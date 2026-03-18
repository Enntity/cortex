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

function buildFileResponse({
  publicUrl,
  blobPath,
  filename,
  size,
  contentType,
  message,
  expiresInMinutes,
}) {
  return Object.fromEntries(
    Object.entries({
      url: publicUrl,
      blobPath,
      filename,
      size,
      contentType,
      message,
      expiresInMinutes,
    }).filter(([, value]) => value !== undefined && value !== null)
  );
}

/**
 * Find a file by filename within a folder in GCS.
 * Returns the first matching blob name, or null.
 */
async function findByName(filename, folderPath = "") {
  const files = await listFolder(folderPath);
  const match = files.find(
    (f) => f.filename === filename || f.blobPath === `${folderPath}${filename}`
  );
  return match ? match.blobPath : null;
}

/**
 * Parse multipart upload via Busboy.
 * Buffers the file content, then uploads to GCS.
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
  const operation = req.query?.operation || req.body?.operation;

  if (operation === "rename") {
    return await handleRename(req, res);
  }

  if (contentType.includes("multipart/form-data")) {
    return await handleMultipartUpload(req, res);
  }

  if (contentType.includes("application/json") && operation === "rename") {
    return await handleRename(req, res);
  }

  res.status(400).json({ error: "Expected multipart/form-data for upload or JSON for operations" });
}

async function handleMultipartUpload(req, res) {
  const { fields, fileBuffer, uploadFilename, uploadMimeType } = await parseMultipart(req);

  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "No file content received" });
  }

  const params = { ...req.query, ...fields };
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;
  const filename = params.filename || uploadFilename;

  const folderPath = constructFolderPath({ userId, chatId, fileScope });
  const sanitized = sanitizeFilename(filename);
  const blobName = constructBlobName(sanitized, folderPath);

  // Resolve content type
  let resolvedMimeType = uploadMimeType;
  if (resolvedMimeType === "application/octet-stream") {
    const looked = mime.lookup(sanitized);
    if (looked) resolvedMimeType = looked;
  }

  const result = await uploadBuffer(fileBuffer, blobName, resolvedMimeType);
  const publicUrl = await getSignedUrl(result.blobPath, DEFAULT_SIGNED_MINUTES);

  res.status(200).json(
    buildFileResponse({
      publicUrl,
      blobPath: result.blobPath,
      filename: sanitized,
      size: fileBuffer.length,
      contentType: resolvedMimeType,
      message: `File '${sanitized}' uploaded successfully.`,
    })
  );
}

async function handleRename(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const oldFilename = params.filename || params.oldFilename;
  const newFilename = params.newFilename;
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  if (!oldFilename) {
    return res.status(400).json({ error: "Missing filename (current filename to rename)" });
  }
  if (!newFilename) {
    return res.status(400).json({ error: "Missing newFilename parameter" });
  }

  const folderPath = constructFolderPath({ userId, chatId, fileScope });
  const existingBlobName = await findByName(oldFilename, folderPath);
  if (!existingBlobName) {
    return res.status(404).json({ error: `File '${oldFilename}' not found` });
  }

  const sanitized = sanitizeFilename(newFilename);
  const newBlobName = constructBlobName(sanitized, folderPath);

  if (existingBlobName === newBlobName) {
    const publicUrl = await getSignedUrl(newBlobName, DEFAULT_SIGNED_MINUTES);
    return res.status(200).json(
      buildFileResponse({
        publicUrl,
        blobPath: newBlobName,
        filename: sanitized,
        message: "File already has this name.",
      })
    );
  }

  const bucketName = getGCSBucketName();

  if (process.env.STORAGE_EMULATOR_HOST) {
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
    const bucket = getBucket();
    const srcFile = bucket.file(existingBlobName);
    await srcFile.copy(bucket.file(newBlobName));
    await srcFile.delete({ ignoreNotFound: true });
  }

  const publicUrl = await getSignedUrl(newBlobName, DEFAULT_SIGNED_MINUTES);

  res.status(200).json(
    buildFileResponse({
      publicUrl,
      blobPath: newBlobName,
      filename: sanitized,
      message: `File renamed to '${sanitized}'.`,
    })
  );
}

// ─── GET ─────────────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const operation = params.operation;

  if (operation === "listFolder") {
    return await handleListFolder(params, res);
  }

  if (operation === "signUrl") {
    return await handleSignUrl(params, res);
  }

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
  const blobPath = params.blobPath ? String(params.blobPath).replace(/^\/+/, "") : null;
  if (!blobPath) {
    return res.status(400).json({
      error: "Missing or invalid file reference (provide blobPath)",
    });
  }

  const minutes = parseInt(params.minutes) || DEFAULT_SIGNED_MINUTES;

  const exists = await fileExists(blobPath);
  if (!exists) {
    return res.status(404).json({ error: `File not found: ${blobPath}` });
  }

  const signedUrl = await getSignedUrl(blobPath, minutes);

  res.status(200).json(
    buildFileResponse({
      publicUrl: signedUrl,
      blobPath,
      expiresInMinutes: minutes,
    })
  );
}

async function handleFetchRemote(params, remoteUrl, res) {
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  try {
    const urlObj = new URL(remoteUrl);
    let remoteFilename = path.basename(urlObj.pathname) || "download";

    const response = await axios({
      method: "GET",
      url: remoteUrl,
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: 500 * 1024 * 1024,
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

    if (remoteFilename.length > 200) {
      const ext = path.extname(remoteFilename);
      remoteFilename = remoteFilename.slice(0, 200 - ext.length) + ext;
    }

    const folderPath = constructFolderPath({ userId, chatId, fileScope });
    const sanitized = sanitizeFilename(remoteFilename);
    const blobName = constructBlobName(sanitized, folderPath);
    const resolvedMime = contentTypeHeader?.split(";")[0].trim() || mime.lookup(sanitized) || "application/octet-stream";

    const result = await uploadBuffer(buffer, blobName, resolvedMime);
    const publicUrl = await getSignedUrl(result.blobPath, DEFAULT_SIGNED_MINUTES);

    res.status(200).json(
      buildFileResponse({
        publicUrl,
        blobPath: result.blobPath,
        filename: sanitized,
        size: buffer.length,
        contentType: resolvedMime,
        message: `File '${sanitized}' uploaded successfully.`,
      })
    );
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
  const filename = params.filename;
  const prefix = params.prefix || params.requestId;
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  // Delete by filename within a folder
  if (filename) {
    const folderPath = constructFolderPath({ userId, chatId, fileScope });
    const blobName = await findByName(filename, folderPath);

    if (!blobName) {
      return res.status(404).json({ error: `File '${filename}' not found` });
    }

    await deleteFile(blobName);
    return res.status(200).json({
      message: `File '${filename}' deleted successfully`,
      deleted: { filename, blobPath: blobName },
    });
  }

  // Delete by prefix (folder cleanup)
  if (prefix) {
    const deleted = await deleteByPrefix(prefix);
    return res.status(200).json({
      message: `Deleted ${deleted.length} file(s)`,
      deleted,
    });
  }

  res.status(400).json({ error: "Please provide filename or prefix" });
}
