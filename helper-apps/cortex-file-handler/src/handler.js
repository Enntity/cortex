import dns from "node:dns";
import net from "node:net";
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
import {
  sanitizeFilename,
  constructBlobName,
  appendFilenameSuffix,
} from "./utils.js";

const DEFAULT_SIGNED_MINUTES = 5;
const MAX_COLLISION_ATTEMPTS = 1000;

function isPrivateOrReservedIpv4(address) {
  const octets = address.split(".").map((part) => parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateOrReservedIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrReservedIpv4(normalized.substring(7));
  }
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fe90:") ||
    normalized.startsWith("fea0:") ||
    normalized.startsWith("feb0:")
  );
}

function isDisallowedAddress(address) {
  if (!net.isIP(address)) {
    return true;
  }
  return net.isIP(address) === 4
    ? isPrivateOrReservedIpv4(address)
    : isPrivateOrReservedIpv6(address);
}

function isDisallowedHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".internal")
  );
}

async function assertSafeRemoteUrl(remoteUrl) {
  const urlObj = new URL(remoteUrl);
  if (!["http:", "https:"].includes(urlObj.protocol)) {
    const error = new Error("Only http and https URLs are allowed");
    error.statusCode = 400;
    throw error;
  }
  if (urlObj.username || urlObj.password) {
    const error = new Error("Remote URLs with embedded credentials are not allowed");
    error.statusCode = 400;
    throw error;
  }

  const hostname = urlObj.hostname;
  if (isDisallowedHostname(hostname)) {
    const error = new Error("Remote URL host is not allowed");
    error.statusCode = 403;
    throw error;
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.promises.lookup(hostname, { all: true, verbatim: true });

  if (!Array.isArray(addresses) || addresses.length === 0) {
    const error = new Error("Remote URL hostname could not be resolved");
    error.statusCode = 400;
    throw error;
  }

  if (addresses.some(({ address }) => isDisallowedAddress(address))) {
    const error = new Error("Remote URL resolves to a private or reserved address");
    error.statusCode = 403;
    throw error;
  }
}

async function resolveAvailableBlobName(filename, folderPath = "") {
  const sanitized = sanitizeFilename(filename);
  let resolvedFilename = sanitized;
  let blobName = constructBlobName(resolvedFilename, folderPath);
  let attempt = 2;

  while (await fileExists(blobName)) {
    if (attempt > MAX_COLLISION_ATTEMPTS) {
      throw new Error(`Unable to allocate a unique blob name for '${sanitized}'`);
    }
    resolvedFilename = appendFilenameSuffix(sanitized, attempt);
    blobName = constructBlobName(resolvedFilename, folderPath);
    attempt += 1;
  }

  return { resolvedFilename, blobName };
}

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

function normalizeBlobPath(blobPath) {
  const normalized = String(blobPath || "").replace(/^\/+/, "");
  return normalized || null;
}

function resolveExactBlobPath(blobPath, folderPath = "") {
  const normalizedBlobPath = normalizeBlobPath(blobPath);
  if (!normalizedBlobPath) {
    return null;
  }
  if (folderPath && !normalizedBlobPath.startsWith(folderPath)) {
    return null;
  }
  return normalizedBlobPath;
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
  const { resolvedFilename, blobName } = await resolveAvailableBlobName(
    filename,
    folderPath
  );

  // Resolve content type
  let resolvedMimeType = uploadMimeType;
  if (resolvedMimeType === "application/octet-stream") {
    const looked = mime.lookup(resolvedFilename);
    if (looked) resolvedMimeType = looked;
  }

  const result = await uploadBuffer(fileBuffer, blobName, resolvedMimeType);
  const publicUrl = await getSignedUrl(result.blobPath, DEFAULT_SIGNED_MINUTES);

  res.status(200).json(
    buildFileResponse({
      publicUrl,
      blobPath: result.blobPath,
      filename: resolvedFilename,
      size: fileBuffer.length,
      contentType: resolvedMimeType,
      message: `File '${resolvedFilename}' uploaded successfully.`,
    })
  );
}

async function handleRename(req, res) {
  const params = { ...req.query, ...(req.body || {}) };
  const oldFilename = params.filename || params.oldFilename;
  const blobPath = params.blobPath;
  const newFilename = params.newFilename;
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  if (!oldFilename && !blobPath) {
    return res.status(400).json({ error: "Missing filename or blobPath (current file to rename)" });
  }
  if (!newFilename) {
    return res.status(400).json({ error: "Missing newFilename parameter" });
  }

  const folderPath = constructFolderPath({ userId, chatId, fileScope });
  const existingBlobName =
    resolveExactBlobPath(blobPath, folderPath)
    || await findByName(oldFilename, folderPath);
  if (!existingBlobName) {
    return res.status(404).json({ error: `File '${blobPath || oldFilename}' not found` });
  }

  const sanitized = sanitizeFilename(newFilename);
  const existingFolderPath = path.posix.dirname(existingBlobName);
  const targetFolderPath =
    existingFolderPath && existingFolderPath !== "."
      ? `${existingFolderPath.replace(/\/+$/, "")}/`
      : "";
  const newBlobName = constructBlobName(sanitized, targetFolderPath);

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

  if (await fileExists(newBlobName)) {
    return res.status(409).json({
      error: `File '${sanitized}' already exists`,
      filename: sanitized,
      blobPath: newBlobName,
    });
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

  if (!userId) {
    return res.status(400).json({
      error: "userId or contextId is required for listFolder",
    });
  }

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
    await assertSafeRemoteUrl(remoteUrl);
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
    const { resolvedFilename, blobName } = await resolveAvailableBlobName(
      remoteFilename,
      folderPath
    );
    const resolvedMime =
      contentTypeHeader?.split(";")[0].trim() ||
      mime.lookup(resolvedFilename) ||
      "application/octet-stream";

    const result = await uploadBuffer(buffer, blobName, resolvedMime);
    const publicUrl = await getSignedUrl(result.blobPath, DEFAULT_SIGNED_MINUTES);

    res.status(200).json(
      buildFileResponse({
        publicUrl,
        blobPath: result.blobPath,
        filename: resolvedFilename,
        size: buffer.length,
        contentType: resolvedMime,
        message: `File '${resolvedFilename}' uploaded successfully.`,
      })
    );
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
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
  const blobPath = params.blobPath;
  const prefix = params.prefix || params.requestId;
  const userId = params.contextId || params.userId || null;
  const chatId = params.chatId || null;
  const fileScope = params.fileScope || null;

  // Delete by exact blob path or filename within a folder
  if (blobPath || filename) {
    const folderPath = constructFolderPath({ userId, chatId, fileScope });
    const blobName =
      resolveExactBlobPath(blobPath, folderPath)
      || await findByName(filename, folderPath);

    if (!blobName) {
      return res.status(404).json({ error: `File '${blobPath || filename}' not found` });
    }

    await deleteFile(blobName);
    return res.status(200).json({
      message: `File '${blobPath || filename}' deleted successfully`,
      deleted: { filename: filename || path.posix.basename(blobName), blobPath: blobName },
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
