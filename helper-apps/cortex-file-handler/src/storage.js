import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";
import axios from "axios";
import { getGCSBucketName } from "./constants.js";
import { isTextMimeType } from "./utils.js";

// --- Singleton instances ---
let _storage = null;
let _bucket = null;

/**
 * Parse GCP credentials from environment variables.
 * Supports GCP_SERVICE_ACCOUNT_KEY_BASE64 (base64-encoded JSON),
 * GCP_SERVICE_ACCOUNT_KEY (raw JSON string), or ADC via
 * GCP_SERVICE_ACCOUNT_EMAIL.
 */
function parseCredentials() {
  const keyBase64 = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const email = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  if (keyBase64) {
    try {
      return JSON.parse(Buffer.from(keyBase64, "base64").toString("utf-8"));
    } catch (err) {
      throw new Error(`Failed to parse GCP_SERVICE_ACCOUNT_KEY_BASE64: ${err.message}`);
    }
  }

  if (keyJson) {
    try {
      return JSON.parse(keyJson);
    } catch (err) {
      throw new Error(`Failed to parse GCP_SERVICE_ACCOUNT_KEY: ${err.message}`);
    }
  }

  if (email) {
    // ADC — return null so Storage() uses application default credentials
    return null;
  }

  throw new Error(
    "No GCP credentials configured. Set GCP_SERVICE_ACCOUNT_KEY_BASE64, " +
    "GCP_SERVICE_ACCOUNT_KEY, or GCP_SERVICE_ACCOUNT_EMAIL."
  );
}

/**
 * Check if we are using the fake-gcs-server emulator.
 */
function isEmulator() {
  return !!process.env.STORAGE_EMULATOR_HOST;
}

/**
 * Get the emulator base URL (without trailing slash).
 */
function emulatorHost() {
  return process.env.STORAGE_EMULATOR_HOST.replace(/\/$/, "");
}

// --- Public API ---

/**
 * Get (or create) the singleton GCS Storage client.
 */
export function getStorage() {
  if (_storage) return _storage;

  if (isEmulator()) {
    // For emulator, create a minimal client — most operations use axios anyway
    _storage = new Storage({
      projectId: "test-project",
      apiEndpoint: emulatorHost(),
    });
    return _storage;
  }

  const credentials = parseCredentials();
  const config = {};
  if (credentials) {
    config.credentials = credentials;
    config.projectId = credentials.project_id || process.env.GCP_PROJECT_ID;
  } else {
    // ADC mode
    config.projectId = process.env.GCP_PROJECT_ID || undefined;
  }
  _storage = new Storage(config);
  return _storage;
}

/**
 * Get the singleton bucket reference.
 */
export function getBucket() {
  if (_bucket) return _bucket;
  const storage = getStorage();
  _bucket = storage.bucket(getGCSBucketName());
  return _bucket;
}

/**
 * Upload a buffer to GCS.
 * @param {Buffer} buffer
 * @param {string} blobName - Full path within the bucket
 * @param {string} contentType
 * @returns {Promise<{blobPath: string}>}
 */
export async function uploadBuffer(buffer, blobName, contentType = "application/octet-stream") {
  let resolvedType = contentType;
  if (isTextMimeType(resolvedType) && !resolvedType.includes("charset=")) {
    resolvedType = `${resolvedType}; charset=utf-8`;
  }

  const bucketName = getGCSBucketName();

  if (isEmulator()) {
    await axios.post(
      `${emulatorHost()}/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(blobName)}`,
      buffer,
      {
        headers: { "Content-Type": resolvedType },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    return { blobPath: blobName };
  }

  const bucket = getBucket();
  const file = bucket.file(blobName);
  await file.save(buffer, {
    metadata: { contentType: resolvedType },
    resumable: false,
  });
  return { blobPath: blobName };
}

/**
 * Upload a readable stream to GCS.
 * @param {import('stream').Readable} stream
 * @param {string} blobName
 * @param {string} contentType
 * @returns {Promise<string>} Blob path
 */
export async function uploadStream(stream, blobName, contentType = "application/octet-stream") {
  let resolvedType = contentType;
  if (isTextMimeType(resolvedType) && !resolvedType.includes("charset=")) {
    resolvedType = `${resolvedType}; charset=utf-8`;
  }

  const bucketName = getGCSBucketName();

  if (isEmulator()) {
    // Collect stream into buffer for emulator upload
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    await axios.post(
      `${emulatorHost()}/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(blobName)}`,
      buffer,
      {
        headers: { "Content-Type": resolvedType },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    return blobName;
  }

  const bucket = getBucket();
  const file = bucket.file(blobName);
  const writeStream = file.createWriteStream({
    metadata: { contentType: resolvedType },
    resumable: false,
  });

  await new Promise((resolve, reject) => {
    stream.pipe(writeStream).on("finish", resolve).on("error", reject);
    stream.on("error", reject);
  });

  return blobName;
}

/**
 * Delete a file by its blob path within the bucket.
 * @param {string} blobPath
 */
export async function deleteFile(blobPath) {
  const filePath = normalizeBlobPath(blobPath);

  if (isEmulator()) {
    await axios.delete(
      `${emulatorHost()}/storage/v1/b/${getGCSBucketName()}/o/${encodeURIComponent(filePath)}`,
      { validateStatus: (s) => s === 200 || s === 204 || s === 404 }
    );
    return;
  }

  const file = getBucket().file(filePath);
  try {
    await file.delete();
  } catch (err) {
    if (err.code === 404) {
      // Already gone — not an error
      return;
    }
    throw err;
  }
}

/**
 * Delete all files under a given prefix.
 * @param {string} prefix - Path prefix within the bucket
 * @returns {Promise<string[]>} Deleted file names
 */
export async function deleteByPrefix(prefix) {
  if (!prefix) throw new Error("Missing prefix");

  const bucketName = getGCSBucketName();
  const deleted = [];

  if (isEmulator()) {
    const listResp = await axios.get(
      `${emulatorHost()}/storage/v1/b/${bucketName}/o`,
      {
        params: { prefix },
        validateStatus: (s) => s === 200 || s === 404,
      }
    );
    if (listResp.status === 200 && Array.isArray(listResp.data.items)) {
      for (const item of listResp.data.items) {
        await axios.delete(
          `${emulatorHost()}/storage/v1/b/${bucketName}/o/${encodeURIComponent(item.name)}`,
          { validateStatus: (s) => s === 200 || s === 204 || s === 404 }
        );
        deleted.push(item.name);
      }
    }
    return deleted;
  }

  const bucket = getBucket();
  const [files] = await bucket.getFiles({ prefix });
  for (const file of files) {
    try {
      await file.delete({ ignoreNotFound: true });
      deleted.push(file.name);
    } catch (err) {
      if (err.code !== 404) {
        console.error(`Error deleting ${file.name}:`, err.message);
      }
    }
  }
  return deleted;
}

/**
 * Check if a file exists at a blob path.
 * @param {string} blobPath
 * @returns {Promise<boolean>}
 */
export async function fileExists(blobPath) {
  if (!blobPath) return false;

  const filePath = normalizeBlobPath(blobPath);

  if (isEmulator()) {
    try {
      const resp = await axios.get(
        `${emulatorHost()}/storage/v1/b/${getGCSBucketName()}/o/${encodeURIComponent(filePath)}`,
        { validateStatus: (s) => s === 200 || s === 404 }
      );
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  const file = getBucket().file(filePath);
  const [exists] = await file.exists();
  return exists;
}

/**
 * Download a blob path to a local path.
 * @param {string} blobPath
 * @param {string} destPath
 */
export async function downloadToFile(blobPath, destPath) {
  const filePath = normalizeBlobPath(blobPath);

  if (isEmulator()) {
    const response = await axios({
      method: "GET",
      url: `${emulatorHost()}/storage/v1/b/${getGCSBucketName()}/o/${encodeURIComponent(filePath)}?alt=media`,
      responseType: "stream",
    });
    const writer = fs.createWriteStream(destPath);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
      response.data.on("error", reject);
    });
    return;
  }

  const file = getBucket().file(filePath);
  await file.download({ destination: destPath });
}

/**
 * Generate a time-limited signed URL for a blob path.
 * @param {string} blobPath
 * @param {number} minutes - Expiration time in minutes (default 5)
 * @returns {Promise<string>} Signed HTTPS URL
 */
export async function getSignedUrl(blobPath, minutes = 5) {
  const filePath = normalizeBlobPath(blobPath);

  if (isEmulator()) {
    // Emulator doesn't support signed URLs — return a direct download link
    return `${emulatorHost()}/storage/v1/b/${getGCSBucketName()}/o/${encodeURIComponent(filePath)}?alt=media`;
  }

  const file = getBucket().file(filePath);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + minutes * 60 * 1000,
  });
  return url;
}

/**
 * List files under a GCS prefix (folder). Returns metadata with signed URLs.
 * @param {string} prefix - Folder prefix in the bucket
 * @returns {Promise<Array<{blobPath: string, filename: string, displayFilename: string, size: number, contentType: string, lastModified: string, url: string}>>}
 */
export async function listFolder(prefix) {
  const bucketName = getGCSBucketName();
  const results = [];

  if (isEmulator()) {
    const listResp = await axios.get(
      `${emulatorHost()}/storage/v1/b/${bucketName}/o`,
      {
        params: { prefix },
        validateStatus: (s) => s === 200 || s === 404,
      }
    );
    if (listResp.status === 200 && Array.isArray(listResp.data.items)) {
      for (const item of listResp.data.items) {
        const filename = path.basename(item.name);
        const signedUrl = `${emulatorHost()}/storage/v1/b/${bucketName}/o/${encodeURIComponent(item.name)}?alt=media`;
        results.push({
          blobPath: item.name,
          filename,
          displayFilename: filename,
          size: parseInt(item.size || "0", 10),
          contentType: item.contentType || "application/octet-stream",
          lastModified: item.updated || item.timeCreated || new Date().toISOString(),
          url: signedUrl,
        });
      }
    }
    return results;
  }

  const bucket = getBucket();
  const [files] = await bucket.getFiles({ prefix });

  for (const file of files) {
    const filename = path.basename(file.name);

    const signedUrl = await getSignedUrl(file.name, 60);

    const metadata = file.metadata || {};
    results.push({
      blobPath: file.name,
      filename,
      displayFilename: filename,
      size: parseInt(metadata.size || "0", 10),
      contentType: metadata.contentType || "application/octet-stream",
      lastModified: metadata.updated || metadata.timeCreated || new Date().toISOString(),
      url: signedUrl,
    });
  }

  return results;
}

/**
 * Construct a folder path from user/chat/scope parameters.
 *
 * Paths:
 *   {userId}/global/          — user global files
 *   {userId}/chats/{chatId}/  — chat-scoped files
 *   {userId}/media/           — media uploads
 *   {userId}/profile/         — profile assets
 *   {userId}/                 — fallback for unknown scope with userId
 *   "" (empty)                — root, for legacy/system files
 *
 * @param {{userId?: string, chatId?: string, fileScope?: string}} opts
 * @returns {string} Folder prefix ending with '/' (or empty string for root)
 */
export function constructFolderPath({ userId, chatId, fileScope } = {}) {
  if (!userId) return "";

  if (chatId) {
    return `${userId}/chats/${chatId}/`;
  }

  switch (fileScope) {
    case "all":
      return `${userId}/`; // all files under user root
    case "global":
      return `${userId}/global/`;
    case "media":
      return `${userId}/media/`;
    case "profile":
      return `${userId}/profile/`;
    default:
      // If a fileScope is given but not recognized, use it as-is
      if (fileScope) {
        return `${userId}/${fileScope}/`;
      }
      // No scope, no chatId — just user root
      return `${userId}/`;
  }
}

// --- Internal helpers ---

/**
 * Normalize a blob path.
 */
function normalizeBlobPath(blobPath) {
  const normalized = String(blobPath || "").replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("Invalid blob path");
  }
  return normalized;
}

/**
 * Reset singleton instances (for testing).
 */
export function _resetForTesting() {
  _storage = null;
  _bucket = null;
}
