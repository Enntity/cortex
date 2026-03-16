import crypto from "crypto";
import path from "path";
import Busboy from "busboy";
import axios from "axios";
import mime from "mime-types";

import {
  uploadBuffer,
  deleteFile,
  deleteByPrefix,
  fileExists,
  getSignedUrl,
  listFolder,
  constructFolderPath,
  getBucket,
} from "./storage.js";
import { getGCSBucketName } from "./constants.js";
import { sanitizeFilename, constructBlobName } from "./utils.js";

const DEFAULT_SIGNED_MINUTES = 5;

/**
 * Compute a short hash (first 16 hex chars of SHA-256) from a buffer.
 */
function computeHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/**
 * Build a canonical gs:// URL.
 */
function gcsUrl(blobName) {
  return `gs://${getGCSBucketName()}/${blobName}`;
}

/**
 * Search for a file by hash prefix within a folder in GCS.
 * Returns the first matching blob name, or null.
 */
async function findByHash(hash, folderPath = "") {
  const prefix = `${folderPath}${hash}_`;
  const bucketName = getGCSBucketName();

  if (process.env.STORAGE_EMULATOR_HOST) {
    const host = process.env.STORAGE_EMULATOR_HOST.replace(/\/$/, "");
    const resp = await axios.get(
      `${host}/storage/v1/b/${bucketName}/o`,
      {
        params: { prefix, maxResults: 1 },
        validateStatus: (s) => s === 200 || s === 404,
      }
    );
    if (resp.status === 200 && Array.isArray(resp.data.items) && resp.data.items.length > 0) {
      return resp.data.items[0].name;
    }
    return null;
  }

  const bucket = getBucket();
  const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
  return files.length > 0 ? files[0].name : null;
}

/**
 * Parse multipart upload via Busboy.
 * Buffers the file content for hashing, then uploads to GCS.
 *
 * @param {import('express').Request} req
 * @returns {Promise<Object>} Upload result
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null;
    let uploadFilename = null;
    let uploadMimeType = "application/octet-stream";

    const busboy = Busboy({ headers: req.headers });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (_fieldname, stream, info) => {
      const { filename: rawFilename, mimeType } = info;
      uploadFilename = rawFilename || "file";
      uploadMimeType = mimeType || "application/octet-stream";

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", () => {
      resolve({ fields, fileBuffer, uploadFilename, uploadMimeType });
    });

    busboy.on("error", (err) => {
      reject(err);
    });

    req.pipe(busboy);
  });
}

/**
 * Main request handler for the file service.
 * Exported as an async function that receives (req, res).
 */
export default async function handler(req, res) {
  const method = req.method.toUpperCase();

  try {
    if (method === "POST" || method === "PUT") {
      return await handlePost(req, res);
    }
    if (method === "GET") {
      return await handleGet(req, res);
    }
    if (method === "DELETE") {
      return await handleDelete(req, res);
    }
    res.status(405).json({ error: `Method ${method} not allowed` });
  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}

// ─── POST (upload) ───────────────────────────────────────────────────────────

async function handlePost(req, res) {
  const contentType = req.headers["content-type"] || "";

  // Check for rename operation in query params
  const operation = req.query?.operation || req.body?.operation;
  if (operation === "rename") {
    return await handleRename(req, res);
  }

  // Multipart upload
  if (contentType.includes("multipart/form-data")) {
    return await handleMultipartUpload(req, res);
  }

  // JSON body — check for rename or other operations
  if (contentType.includes("application/json")) {
    if (operation === "rename") {
      return await handleRename(req, res);
    }
  }

  res.status(400).json({ error: "Expected multipart/form-data for upload or JSON for operations" });
}

async function handleMultipartUpload(req, res) {
  const { fields, fileBuffer, uploadFilename, uploadMimeType } = await parseMultipart(req);

  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "No file content received" });
  }

  // Merge query params and form fields — form fields take priority
  const params = { ...req.query, ...fields };
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;
  const providedHash = params.hash || null;
  const filename = params.filename || uploadFilename;

  // Compute hash from file content
  const hash = providedHash || computeHash(fileBuffer);

  // Determine folder path and blob name
  const folderPath = constructFolderPath({ userId, chatId, fileScope });
  const sanitized = sanitizeFilename(filename);
  const blobName = constructBlobName(hash, sanitized, folderPath);

  // Resolve content type — prefer Busboy-detected, fall back to mime-types lookup
  let resolvedMimeType = uploadMimeType;
  if (resolvedMimeType === "application/octet-stream") {
    const looked = mime.lookup(sanitized);
    if (looked) resolvedMimeType = looked;
  }

  // Upload to GCS
  const result = await uploadBuffer(fileBuffer, blobName, resolvedMimeType);
  const shortLivedUrl = await getSignedUrl(result.url, DEFAULT_SIGNED_MINUTES);

  res.status(200).json({
    url: result.url,
    hash,
    filename: sanitized,
    shortLivedUrl,
    message: `File '${sanitized}' uploaded successfully.`,
  });
}

async function handleRename(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const hash = params.hash;
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;
  const newFilename = params.newFilename;

  if (!hash) {
    return res.status(400).json({ error: "Missing hash parameter" });
  }
  if (!newFilename) {
    return res.status(400).json({ error: "Missing newFilename parameter" });
  }

  const folderPath = constructFolderPath({ userId, chatId, fileScope });

  // Find existing file by hash
  const existingBlobName = await findByHash(hash, folderPath);
  if (!existingBlobName) {
    return res.status(404).json({ error: `File with hash ${hash} not found` });
  }

  // Construct new blob name
  const sanitized = sanitizeFilename(newFilename);
  const newBlobName = constructBlobName(hash, sanitized, folderPath);

  if (existingBlobName === newBlobName) {
    const signedUrl = await getSignedUrl(gcsUrl(newBlobName), DEFAULT_SIGNED_MINUTES);
    return res.status(200).json({
      url: gcsUrl(newBlobName),
      hash,
      filename: sanitized,
      shortLivedUrl: signedUrl,
      message: "File already has this name.",
    });
  }

  const bucketName = getGCSBucketName();

  if (process.env.STORAGE_EMULATOR_HOST) {
    // Emulator: download then re-upload with new name
    const host = process.env.STORAGE_EMULATOR_HOST.replace(/\/$/, "");
    const downloadResp = await axios.get(
      `${host}/storage/v1/b/${bucketName}/o/${encodeURIComponent(existingBlobName)}?alt=media`,
      { responseType: "arraybuffer" }
    );
    await axios.post(
      `${host}/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(newBlobName)}`,
      downloadResp.data,
      { headers: { "Content-Type": "application/octet-stream" }, maxBodyLength: Infinity }
    );
    await axios.delete(
      `${host}/storage/v1/b/${bucketName}/o/${encodeURIComponent(existingBlobName)}`,
      { validateStatus: (s) => s === 200 || s === 204 || s === 404 }
    );
  } else {
    // Real GCS: copy then delete
    const bucket = getBucket();
    const srcFile = bucket.file(existingBlobName);
    await srcFile.copy(bucket.file(newBlobName));
    await srcFile.delete({ ignoreNotFound: true });
  }

  const newUrl = gcsUrl(newBlobName);
  const signedUrl = await getSignedUrl(newUrl, DEFAULT_SIGNED_MINUTES);

  res.status(200).json({
    url: newUrl,
    hash,
    filename: sanitized,
    shortLivedUrl: signedUrl,
    message: `File renamed to '${sanitized}'.`,
  });
}

// ─── GET ─────────────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const operation = params.operation;

  // listFolder
  if (operation === "listFolder") {
    return await handleListFolder(params, res);
  }

  // signUrl — generate a signed URL for a gs:// URL
  if (operation === "signUrl") {
    return await handleSignUrl(params, res);
  }

  // Fetch/load/restore remote URL
  const remoteUrl = params.fetch || params.load || params.restore;
  if (remoteUrl) {
    return await handleFetchRemote(params, remoteUrl, res);
  }

  res.status(400).json({ error: "Missing required operation or parameters" });
}

async function handleListFolder(params, res) {
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  const folderPath = constructFolderPath({ userId, chatId, fileScope });
  const files = await listFolder(folderPath);

  res.status(200).json(files);
}

async function handleSignUrl(params, res) {
  const gcsUrlParam = params.url;
  if (!gcsUrlParam || !gcsUrlParam.startsWith("gs://")) {
    return res.status(400).json({ error: "Missing or invalid url parameter (must be a gs:// URL)" });
  }

  const minutes = parseInt(params.minutes) || DEFAULT_SIGNED_MINUTES;

  const exists = await fileExists(gcsUrlParam);
  if (!exists) {
    return res.status(404).json({ error: `File not found: ${gcsUrlParam}` });
  }

  const shortLivedUrl = await getSignedUrl(gcsUrlParam, minutes);

  res.status(200).json({
    url: gcsUrlParam,
    shortLivedUrl,
    expiresInMinutes: minutes,
  });
}

async function handleFetchRemote(params, remoteUrl, res) {
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;
  const providedHash = params.hash || null;

  try {
    // Determine filename from URL
    const urlObj = new URL(remoteUrl);
    let remoteFilename = path.basename(urlObj.pathname) || "download";

    // Download
    const response = await axios({
      method: "GET",
      url: remoteUrl,
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: 500 * 1024 * 1024, // 500MB
    });

    const buffer = Buffer.from(response.data);

    // Ensure correct extension from content-type
    const contentTypeHeader = response.headers["content-type"];
    if (contentTypeHeader) {
      const ext = mime.extension(contentTypeHeader.split(";")[0].trim());
      if (ext && !remoteFilename.toLowerCase().endsWith(`.${ext}`)) {
        remoteFilename = `${path.basename(remoteFilename, path.extname(remoteFilename))}.${ext}`;
      }
    }

    // Truncate long filenames
    if (remoteFilename.length > 200) {
      const ext = path.extname(remoteFilename);
      remoteFilename = remoteFilename.slice(0, 200 - ext.length) + ext;
    }

    // Compute hash
    const hash = providedHash || computeHash(buffer);

    // Upload to GCS
    const folderPath = constructFolderPath({ userId, chatId, fileScope });
    const sanitized = sanitizeFilename(remoteFilename);
    const blobName = constructBlobName(hash, sanitized, folderPath);
    const resolvedMime = contentTypeHeader?.split(";")[0].trim() || mime.lookup(sanitized) || "application/octet-stream";

    const result = await uploadBuffer(buffer, blobName, resolvedMime);
    const shortLivedUrl = await getSignedUrl(result.url, DEFAULT_SIGNED_MINUTES);

    res.status(200).json({
      url: result.url,
      hash,
      filename: sanitized,
      shortLivedUrl,
      message: `File '${sanitized}' uploaded successfully.`,
    });
  } catch (err) {
    if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
      return res.status(408).json({ error: "Remote file download timed out" });
    }
    console.error("Error fetching remote file:", err.message);
    res.status(500).json({ error: `Error fetching remote file: ${err.message}` });
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

async function handleDelete(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const hash = params.hash;
  const requestId = params.requestId;
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  // Delete by hash
  if (hash) {
    const folderPath = constructFolderPath({ userId, chatId, fileScope });
    const blobName = await findByHash(hash, folderPath);

    // Also try root if not found in scoped path
    let resolvedBlobName = blobName;
    if (!resolvedBlobName && folderPath) {
      resolvedBlobName = await findByHash(hash, "");
    }

    if (!resolvedBlobName) {
      return res.status(404).json({ error: `File with hash ${hash} not found` });
    }

    await deleteFile(gcsUrl(resolvedBlobName));
    return res.status(200).json({
      message: `File with hash ${hash} deleted successfully`,
      deleted: { hash, blobName: resolvedBlobName },
    });
  }

  // Delete by requestId (prefix)
  if (requestId) {
    const deleted = await deleteByPrefix(requestId);
    return res.status(200).json({
      message: `Deleted ${deleted.length} file(s) for requestId ${requestId}`,
      deleted,
    });
  }

  res.status(400).json({ error: "Please provide either hash or requestId" });
}
