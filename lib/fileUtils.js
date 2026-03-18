import logger from "./logger.js";
import stream from 'stream';
import os from 'os';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import { axios } from './requestExecutor.js';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import mime from 'mime-types';
import mimeDb from 'mime-db';

const pipeline = promisify(stream.pipeline);
const MEDIA_API_URL = config.get('whisperMediaApiUrl');

// ─── File Handler HTTP Helper ────────────────────────────────────────────────

/**
 * Build a file handler URL with query parameters.
 * Handles separator detection (? vs &) and parameter encoding.
 */
function buildFileHandlerUrl(baseUrl, params = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    const separator = baseUrl.includes('?') ? '&' : '?';
    const queryParams = Object.entries(params)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return queryParams.length === 0 ? baseUrl : `${baseUrl}${separator}${queryParams.join('&')}`;
}

/**
 * Make a request to the file handler service.
 * @param {'get'|'post'|'delete'} method
 * @param {Object} params - Query parameters
 * @param {Object} options - axios options (data, headers, timeout, etc.)
 * @returns {Promise<Object>} Response data
 */
async function _fileHandlerRequest(method, params = {}, options = {}) {
    const baseUrl = MEDIA_API_URL;
    if (!baseUrl || baseUrl === 'null') {
        throw new Error('File handler URL is not configured (whisperMediaApiUrl)');
    }
    const url = buildFileHandlerUrl(baseUrl, params);
    const timeout = options.timeout || 30000;
    const response = await axios({ method, url, timeout, ...options });
    return response.data;
}

// ─── Pure Utility Functions ──────────────────────────────────────────────────

function isYoutubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === "youtube.com" || urlObj.hostname === "www.youtube.com") {
            if (urlObj.pathname === "/watch") return !!urlObj.searchParams.get("v");
            if (urlObj.pathname.startsWith("/embed/")) return urlObj.pathname.length > 7;
            if (urlObj.pathname.startsWith("/shorts/")) return urlObj.pathname.length > 8;
            return false;
        }
        if (urlObj.hostname === "youtu.be") return urlObj.pathname.length > 1;
        return false;
    } catch { return false; }
}

function getMimeTypeFromFilename(filenameOrPath, defaultMimeType = 'application/octet-stream') {
    if (!filenameOrPath) return defaultMimeType;
    return mime.lookup(filenameOrPath) || defaultMimeType;
}

function getMimeTypeFromExtension(extension, defaultMimeType = 'application/octet-stream') {
    if (!extension) return defaultMimeType;
    const normalizedExt = extension.startsWith('.') ? extension : `.${extension}`;
    return mime.lookup(normalizedExt) || defaultMimeType;
}

function isTextMimeType(mimeType) {
    if (!mimeType || typeof mimeType !== 'string') return false;
    const baseMimeType = mimeType.split(';')[0].trim().toLowerCase();
    if (baseMimeType.startsWith('text/')) return true;
    if (baseMimeType.endsWith('+json') || baseMimeType.endsWith('+xml') || baseMimeType.endsWith('+yaml')) return true;
    const dbEntry = mimeDb[baseMimeType];
    if (dbEntry && dbEntry.charset) return true;
    const knownTextTypes = new Set([
        'application/xml', 'application/x-yaml', 'application/yaml', 'application/toml',
        'application/x-toml', 'application/x-sh', 'application/x-shellscript',
        'application/x-httpd-php', 'application/x-perl', 'application/x-python',
        'application/x-sql', 'application/sql', 'application/graphql',
        'application/x-tex', 'application/x-latex', 'application/rtf',
    ]);
    if (knownTextTypes.has(baseMimeType)) return true;
    if (baseMimeType.startsWith('application/x-')) {
        const sub = baseMimeType.substring('application/x-'.length);
        if (sub.includes('source') || sub.includes('script') || sub.includes('src') || sub.includes('code')) return true;
    }
    if (mimeType.toLowerCase().includes('charset=')) return true;
    return false;
}

function extractFilenameFromUrl(url) {
    if (!url) return null;
    try {
        const urlObj = new URL(url);
        return urlObj.pathname.split('/').pop() || null;
    } catch {
        return url.split('/').pop().split('?')[0];
    }
}

function extractBlobPathFromGsUrl(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('gs://')) return null;
    const withoutProtocol = url.slice(5);
    const slashIndex = withoutProtocol.indexOf('/');
    return slashIndex === -1 ? null : decodeURIComponent(withoutProtocol.slice(slashIndex + 1));
}

function ensureFilenameExtension(filename, mimeType) {
    if (!mimeType || mimeType === 'application/octet-stream') return filename || null;
    const correctExtension = mime.extension(mimeType);
    if (!correctExtension || correctExtension === 'bin') return filename || null;
    let normalizedExtension = correctExtension;
    if (correctExtension === 'markdown') normalizedExtension = 'md';
    else if (correctExtension === 'jpeg') normalizedExtension = 'jpg';
    const extensionWithDot = '.' + normalizedExtension;
    if (!filename || filename === '') return null;
    const parsed = path.parse(filename);
    if (parsed.ext.toLowerCase() === extensionWithDot.toLowerCase()) return filename;
    return parsed.name + extensionWithDot;
}

function determineMimeTypeFromUrl(url, filename = null) {
    if (url) {
        const urlFilename = extractFilenameFromUrl(url);
        if (urlFilename) {
            const m = getMimeTypeFromFilename(urlFilename);
            if (m !== 'application/octet-stream') return m;
        }
    }
    if (filename) return getMimeTypeFromFilename(filename);
    return 'application/octet-stream';
}

function getActualContentMimeType(file) {
    if (!file) return 'application/octet-stream';
    if (file.mimeType && file.mimeType !== 'application/octet-stream') return file.mimeType;
    return determineMimeTypeFromUrl(file.url, null);
}

function getDefaultContext(agentContext) {
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) return null;
    return agentContext.find(ctx => ctx.default === true) || agentContext[0] || null;
}

async function deleteTempPath(p) {
    try {
        if (!p) { logger.warn('Temporary path is not defined.'); return; }
        if (!fs.existsSync(p)) { logger.warn(`Temporary path ${p} does not exist.`); return; }
        const stats = fs.statSync(p);
        if (stats.isFile()) { fs.unlinkSync(p); logger.info(`Temporary file ${p} deleted successfully.`); }
        else if (stats.isDirectory()) { fs.rmSync(p, { recursive: true }); logger.info(`Temporary folder ${p} and its contents deleted successfully.`); }
    } catch (err) { logger.error(`Error occurred while deleting the temporary path: ${err}`); }
}

function generateUniqueFilename(extension) {
    return `${uuidv4()}.${extension}`;
}

const downloadFile = async (fileUrl) => {
    const urlObj = new URL(fileUrl);
    const fileExtension = path.extname(urlObj.pathname).slice(1) || 'bin';
    const uniqueFilename = generateUniqueFilename(fileExtension);
    const tempDir = os.tmpdir();
    const localFilePath = `${tempDir}/${uniqueFilename}`;
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
        try {
            const parsedUrl = new URL(fileUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;
            const response = await new Promise((res, rej) => {
                protocol.get(parsedUrl, (r) => {
                    if (r.statusCode === 200) res(r); else rej(new Error(`HTTP request failed with status code ${r.statusCode}`));
                }).on('error', rej);
            });
            await pipeline(response, fs.createWriteStream(localFilePath));
            logger.info(`Downloaded file to ${localFilePath}`);
            resolve(localFilePath);
        } catch (error) {
            fs.unlink(localFilePath, () => { reject(error); });
        }
    });
};

function extractFileMetadataFromContent(contentObj) {
    const files = [];
    const blobPath = contentObj.blobPath || null;
    if (contentObj.type === 'image_url' && contentObj.image_url?.url) {
        files.push({
            url: contentObj.image_url.url,
            blobPath,
            type: 'image_url',
        });
    } else if (contentObj.type === 'file' && contentObj.url) {
        files.push({ url: contentObj.url, blobPath, type: 'file' });
    } else if (contentObj.url && (contentObj.type === 'image_url' || !contentObj.type)) {
        files.push({
            url: contentObj.url,
            blobPath,
            type: contentObj.type || 'file',
        });
    }
    return files;
}

function extractFilesFromChatHistory(chatHistory) {
    if (!chatHistory || !Array.isArray(chatHistory)) return [];
    const extractedFiles = [];
    for (const message of chatHistory) {
        if (!message || !message.content) continue;
        if (Array.isArray(message.content)) {
            for (const content of message.content) {
                try {
                    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
                    extractedFiles.push(...extractFileMetadataFromContent(contentObj));
                } catch { continue; }
            }
        } else if (typeof message.content === 'string') {
            try {
                const contentObj = JSON.parse(message.content);
                extractedFiles.push(...extractFileMetadataFromContent(contentObj));
            } catch { continue; }
        } else if (typeof message.content === 'object') {
            extractedFiles.push(...extractFileMetadataFromContent(message.content));
        }
    }
    return extractedFiles;
}

function injectFileIntoChatHistory(chatHistory, fileContent) {
    if (!chatHistory || !Array.isArray(chatHistory)) return [{ role: 'user', content: [fileContent] }];
    if (!fileContent) return chatHistory;
    const fileUrl = fileContent.url || fileContent.image_url?.url;
    const fileBlobPath = fileContent.blobPath || null;
    const existingFiles = extractFilesFromChatHistory(chatHistory);
    const fileAlreadyExists = existingFiles.some(f =>
        (fileUrl && f.url === fileUrl) ||
        (fileBlobPath && f.blobPath === fileBlobPath)
    );
    if (fileAlreadyExists) return chatHistory;
    return [...chatHistory, { role: 'user', content: [fileContent] }];
}

function buildFileCreationResponse(successfulFiles, options = {}) {
    const { mediaType = 'image', action = 'Generation', imageUrls } = options;
    const files = successfulFiles.map((item) => ({
        filename: item.filename || item.displayFilename || null,
        blobPath: item.blobPath || null,
        url: item.url,
    }));
    const count = files.length;
    const displayInstruction = mediaType === 'video'
        ? 'Display videos using markdown link: [video description](url).'
        : 'Display images using markdown: ![description](url).';
    const response = {
        success: true, count,
        message: `${action} complete. ${count} ${mediaType}(s) uploaded. ${displayInstruction}`,
        files,
    };
    // imageUrls is consumed by pathwayTools.js to inject images into LLM context
    if (imageUrls?.length > 0) response.imageUrls = imageUrls;
    return JSON.stringify(response);
}

// ─── GCS File Handler API Functions ──────────────────────────────────────────

/**
 * List files for a context via file handler API.
 * @param {string} contextId - User/context ID
 * @param {Object} options - {chatId, fileScope, limit}
 * @returns {Promise<Array>} Array of file objects
 */
async function listFilesForContext(contextId, options = {}) {
    if (!contextId) return [];
    const { chatId, fileScope, limit } = options;
    try {
        const params = {
            operation: 'listFolder',
            userId: contextId,
            ...(chatId ? { chatId } : {}),
            fileScope: fileScope || 'all',
        };
        const files = await _fileHandlerRequest('get', params, { timeout: 15000 });
        if (!Array.isArray(files)) return [];
        let result = files.map(f => ({
            filename: f.filename,
            displayFilename: f.displayFilename || f.filename,
            url: f.url,
            blobPath: f.blobPath || null,
            size: f.size,
            contentType: f.contentType,
            lastModified: f.lastModified,
            _contextId: contextId,
        }));
        if (limit && limit > 0) result = result.slice(0, limit);
        return result;
    } catch (err) {
        logger.warn(`listFilesForContext failed for ${contextId}: ${err.message}`);
        return [];
    }
}

/**
 * Load file collection — backward-compatible wrapper over listFilesForContext.
 * Extracts contextId from agentContext array, calls listFilesForContext.
 */
async function loadFileCollection(agentContext, options = {}) {
    let contexts = [];
    if (typeof agentContext === 'string') {
        contexts = [{ contextId: agentContext, default: true }];
    } else if (Array.isArray(agentContext)) {
        contexts = agentContext.filter(ctx => ctx && ctx.contextId);
    } else if (agentContext && typeof agentContext === 'object' && agentContext.contextId) {
        contexts = [agentContext];
    }
    if (contexts.length === 0) return [];

    let chatIds = options.chatIds;
    if (typeof chatIds === 'string') chatIds = chatIds.trim() ? [chatIds] : null;
    else if (Array.isArray(chatIds)) { chatIds = chatIds.filter(id => id && typeof id === 'string' && id.trim()); if (chatIds.length === 0) chatIds = null; }
    else chatIds = null;

    const allFiles = [];
    const seenFiles = new Set();

    for (const ctx of contexts) {
        // If chatIds provided, list each chatId scope; otherwise list all
        const scopes = chatIds
            ? chatIds.map(cid => ({ chatId: cid }))
            : [{ fileScope: 'all' }];

        for (const scope of scopes) {
            const files = await listFilesForContext(ctx.contextId, scope);
            for (const f of files) {
                const stableId = f.blobPath || f.url;
                if (stableId && seenFiles.has(stableId)) continue;
                if (stableId) seenFiles.add(stableId);
                allFiles.push({ ...f, _contextId: f._contextId || ctx.contextId });
            }
        }
    }
    return allFiles;
}

/**
 * Find a file in a collection array by filename, URL, or partial match.
 */
function findFileInCollection(fileParam, collection) {
    if (!fileParam || typeof fileParam !== 'string' || !Array.isArray(collection)) return null;
    const trimmed = fileParam.trim();
    const normalizedParam = trimmed.toLowerCase();
    const paramFilename = path.basename(normalizedParam);
    const normalizedBlobPath = extractBlobPathFromGsUrl(trimmed);

    // Exact matches
    for (const file of collection) {
        if (file.url === trimmed) return file;
        if (file.blobPath === trimmed) return file;
        if (normalizedBlobPath && file.blobPath === normalizedBlobPath) return file;
        if (file.displayFilename) {
            if (path.basename(file.displayFilename.toLowerCase()) === paramFilename) return file;
        }
        if (file.filename) {
            if (path.basename(file.filename.toLowerCase()) === paramFilename) return file;
        }
    }

    // Partial matches (4+ chars)
    if (normalizedParam.length >= 4) {
        for (const file of collection) {
            if (file.displayFilename && file.displayFilename.toLowerCase().includes(normalizedParam)) return file;
            if (file.filename && file.filename.toLowerCase().includes(normalizedParam)) return file;
            if (file.url && file.url.toLowerCase().includes(normalizedParam)) return file;
            if (file.blobPath && file.blobPath.toLowerCase().includes(normalizedParam)) return file;
        }
    }
    return null;
}

/**
 * Get a signed HTTPS URL for a blob path.
 * Legacy gs:// refs are normalized to blob paths before calling the file handler.
 * Calls the file handler's signUrl endpoint.
 * @param {string} fileRef - blob path or legacy gs://bucket/path URL
 * @param {number} minutes - URL expiration in minutes (default 5)
 * @returns {Promise<string|null>} Signed HTTPS URL, or null on failure
 */
async function getSignedFileUrl(fileRef, minutes = 5) {
    if (!fileRef || typeof fileRef !== 'string') return null;
    try {
        const blobPath = extractBlobPathFromGsUrl(fileRef) || fileRef;
        if (!blobPath || /^https?:\/\//.test(blobPath)) {
            return null;
        }
        const params = {
            operation: 'signUrl',
            blobPath,
            minutes,
        };
        const data = await _fileHandlerRequest('get', params, { timeout: 10000 });
        return data?.url || null;
    } catch (err) {
        logger.warn(`Failed to get signed URL for ${fileRef}: ${err.message}`);
        return null;
    }
}

/**
 * Delete a file from cloud storage by filename.
 */
async function deleteFileByName(filename, pathwayResolver = null, contextId = null) {
    if (!filename || typeof filename !== 'string') { logger.warn('deleteFileByName: filename is required'); return false; }
    try {
        const url = buildFileHandlerUrl(MEDIA_API_URL, { filename, ...(contextId ? { contextId } : {}) });
        const response = await axios.delete(url, { validateStatus: s => s >= 200 && s < 500, timeout: 30000 });
        if (response.status === 200) { logger.info(`Deleted file ${filename}`); return true; }
        if (response.status === 404) { logger.info(`File ${filename} not found`); return false; }
        return false;
    } catch (err) {
        if (err?.response?.status === 404) return false;
        logger.warn(`Error deleting file ${filename}: ${err?.message || err}`);
        return false;
    }
}

/**
 * Fetch/load a file from URL via file handler.
 */
async function fetchFileFromUrl(fileUrl, requestId, contextId = null, save = false) {
    return await _fileHandlerRequest('get', {
        fetch: fileUrl, requestId,
        ...(contextId ? { contextId } : {}),
        ...(save ? { save: true } : {}),
    }, { timeout: 60000 });
}

/**
 * Get media chunks from file handler.
 */
async function getMediaChunks(file, requestId, contextId = null) {
    try {
        if (MEDIA_API_URL) {
            const url = buildFileHandlerUrl(MEDIA_API_URL, { uri: file, requestId, ...(contextId ? { contextId } : {}) });
            const res = await axios.get(url, { timeout: 600000 });
            return res.data;
        }
        logger.info('No API_URL set, returning file as chunk');
        return [file];
    } catch (err) { logger.error(`Error getting media chunks: ${err}`); throw err; }
}

/**
 * Mark a request as completed for cleanup in file handler.
 */
async function markCompletedForCleanUp(requestId, contextId = null) {
    try {
        if (MEDIA_API_URL) {
            const url = buildFileHandlerUrl(MEDIA_API_URL, { requestId, ...(contextId ? { contextId } : {}) });
            const res = await axios.delete(url, { timeout: 15000 });
            logger.info(`Marked request ${requestId} as completed: ${JSON.stringify(res.data)}`);
            return res.data;
        }
    } catch (err) { logger.error(`Error marking request ${requestId} as completed: ${err}`); }
    return null;
}

/**
 * Upload a file to cloud storage via file handler.
 * Accepts buffer, URL string, or base64 string as fileInput.
 */
async function uploadFileToCloud(fileInput, mimeType = null, filename = null, pathwayResolver = null, contextId = null, chatId = null) {
    let tempFilePath = null;
    let tempDir = null;
    let fileBuffer = null;

    try {
        const fileHandlerUrl = MEDIA_API_URL;
        if (!fileHandlerUrl) throw new Error('WHISPER_MEDIA_API_URL is not set');

        if (typeof fileInput === 'string') {
            if (fileInput.startsWith('http://') || fileInput.startsWith('https://')) {
                tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-upload-'));
                let extension = 'bin';
                if (filename) extension = path.extname(filename).slice(1) || 'bin';
                else try { extension = path.extname(new URL(fileInput).pathname).slice(1) || 'bin'; } catch {}
                const downloadFilename = filename || `download_${Date.now()}.${extension}`;
                tempFilePath = path.join(tempDir, downloadFilename);
                const downloadResponse = await axios.get(fileInput, { responseType: 'stream', timeout: 60000, validateStatus: s => s >= 200 && s < 400 });
                const writeStream = fs.createWriteStream(tempFilePath);
                await pipeline(downloadResponse.data, writeStream);
                fileBuffer = fs.readFileSync(tempFilePath);
            } else {
                fileBuffer = Buffer.from(fileInput, 'base64');
            }
        } else if (Buffer.isBuffer(fileInput)) {
            fileBuffer = fileInput;
        } else {
            throw new Error('fileInput must be a URL string, base64 string, or Buffer');
        }

        if (fileBuffer) {
            if (!tempFilePath) {
                let extension = 'bin';
                if (mimeType) extension = mimeType.split('/')[1] || 'bin';
                else if (filename) extension = path.extname(filename).slice(1) || 'bin';
                const uploadFilename = filename || `upload_${Date.now()}.${extension}`;
                if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-upload-'));
                tempFilePath = path.join(tempDir, uploadFilename);
                fs.writeFileSync(tempFilePath, fileBuffer);
            }
        }

        if (!tempFilePath) throw new Error('No file to upload');

        const formData = new FormData();
        const uploadFilename = filename || path.basename(tempFilePath);
        formData.append('file', fs.createReadStream(tempFilePath), { filename: uploadFilename, contentType: mimeType || 'application/octet-stream' });
        if (contextId) formData.append('contextId', contextId);
        if (chatId) formData.append('chatId', chatId);

        const uploadUrl = buildFileHandlerUrl(fileHandlerUrl, { requestId: uuidv4() });
        const uploadResponse = await axios.post(uploadUrl, formData, { headers: { ...formData.getHeaders() }, timeout: 30000 });

        if (uploadResponse.data?.url) {
            const d = uploadResponse.data;
            return {
                url: d.url,
                blobPath: d.blobPath || null,
                filename: d.filename,
            };
        }
        throw new Error('No URL returned from file handler');
    } catch (error) {
        const msg = error?.message || String(error);
        if (pathwayResolver?.logError) pathwayResolver.logError(`Failed to upload file: ${msg}`);
        else logger.error(`Failed to upload file: ${msg}`);
        throw error;
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { logger.warn(`Failed to clean up temp dir: ${e.message}`); }
        } else if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) { logger.warn(`Failed to clean up temp file: ${e.message}`); }
        }
    }
}

const uploadImageToCloud = async (imageInput, mimeType, filename, pathwayResolver = null, contextId = null, chatId = null) => {
    return await uploadFileToCloud(imageInput, mimeType, filename, pathwayResolver, contextId, chatId);
};

/**
 * Resolve a file parameter to a URL by looking it up in the file collection.
 */
export async function resolveFileParameter(fileParam, agentContext, options = {}) {
    if (!fileParam || typeof fileParam !== 'string') return null;
    const trimmed = fileParam.trim();
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) return null;
    try {
        const collection = await loadFileCollection(agentContext);
        const foundFile = findFileInCollection(trimmed, collection);
        if (foundFile) {
            return foundFile.url;
        }
        return null;
    } catch (error) {
        logger.warn(`Failed to resolve file parameter "${trimmed}": ${error.message}`);
        return null;
    }
}

/**
 * Generate file message content by looking up a file parameter in the collection.
 */
async function generateFileMessageContent(fileParam, agentContext) {
    if (!fileParam || typeof fileParam !== 'string') return null;
    try {
        if (isYoutubeUrl(fileParam)) {
            return {
                type: 'image_url',
                url: fileParam,
                image_url: { url: fileParam },
            };
        }
    } catch {}
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) return null;
    const collection = await loadFileCollection(agentContext, { useCache: false });
    const foundFile = findFileInCollection(fileParam, collection);
    if (!foundFile) return null;
    return {
        type: 'image_url',
        url: foundFile.url,
        image_url: { url: foundFile.url },
        blobPath: foundFile.blobPath || null,
        filename: foundFile.filename || foundFile.displayFilename || null,
    };
}

/**
 * Get available files from file collection and format for template.
 */
async function getAvailableFilesFromCollection(contextId, contextKey = null) {
    if (!contextId) return 'No files available.';
    const collection = await listFilesForContext(contextId);
    return formatFilesForTemplate(collection);
}

/**
 * Format file collection for template display (last 10 most recently used).
 */
function formatFilesForTemplate(collection) {
    if (!collection || collection.length === 0) return 'No files available.';
    const sorted = [...collection].sort((a, b) => {
        const aDate = a.lastModified || a.lastAccessed || a.addedDate || '';
        const bDate = b.lastModified || b.lastAccessed || b.addedDate || '';
        return new Date(bDate) - new Date(aDate);
    });
    const recentFiles = sorted.slice(0, 10);
    const totalFiles = collection.length;
    const hasMore = totalFiles > 10;
    const fileList = recentFiles.map((file) => {
        const displayFilename = file.displayFilename || file.filename || 'Unnamed file';
        const url = file.url || '';
        const dateAdded = file.lastModified
            ? new Date(file.lastModified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
        const tags = Array.isArray(file.tags) && file.tags.length > 0 ? file.tags.join(',') : '';
        return `${displayFilename} | ${url} | ${dateAdded}${tags ? ' | ' + tags : ''}`;
    }).join('\n');
    let result = fileList;
    if (hasMore) result += `\n(${totalFiles - 10} more file(s) available - use FileCollection)`;
    return result;
}

/**
 * Get available files formatted for template.
 */
async function getAvailableFiles(chatHistory, agentContext) {
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) return 'No files available.';
    const collection = await loadFileCollection(agentContext);
    return formatFilesForTemplate(collection);
}

// ─── Chat History File Stripping ─────────────────────────────────────────────

function tryParseJson(str) { try { return JSON.parse(str); } catch { return null; } }

function extractFilenameFromFileContent(content) {
    if (!content) return 'unknown file';
    if (content.originalFilename) return content.originalFilename;
    if (content.displayFilename) return content.displayFilename;
    if (content.filename) return content.filename;
    if (content.name) return content.name;
    if (content.blobPath) return path.basename(content.blobPath);
    const url = content.url || content.image_url?.url;
    if (url) {
        try {
            const basename = new URL(url).pathname.split('/').pop();
            if (basename && basename.length > 0 && basename !== '/') return decodeURIComponent(basename).replace(/\?.*$/, '');
        } catch {}
    }
    if (content.type === 'image_url') return 'image';
    if (content.type === 'file') return 'file';
    return 'unknown file';
}

/**
 * Strip file content from chat messages (URLs, base64 images).
 * No Redis metadata updates — just strips and returns available files summary.
 */
async function syncAndStripFilesFromChatHistory(chatHistory, agentContext, chatId = null, entityId = null) {
    if (!chatHistory || !Array.isArray(chatHistory)) return { chatHistory: chatHistory || [], availableFiles: 'No files available.' };
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) return { chatHistory, availableFiles: 'No files available.' };

    const allFiles = await loadFileCollection(agentContext);
    const collectionByUrl = new Map(allFiles.filter(f => f.url).map(f => [f.url, f]));
    const collectionByBlobPath = new Map(allFiles.filter(f => f.blobPath).map(f => [f.blobPath, f]));

    const isInCollection = (contentObj) => {
        const blobPath = contentObj.blobPath || null;
        if (blobPath && collectionByBlobPath.has(blobPath)) return true;
        const fileUrl = contentObj.url || contentObj.image_url?.url;
        if (fileUrl && collectionByUrl.has(fileUrl)) return true;
        return false;
    };

    const processedHistory = chatHistory.map(message => {
        if (!message || message.role !== 'user' || !message.content) return message;
        if (Array.isArray(message.content)) {
            const newContent = message.content.map(item => {
                const contentObj = typeof item === 'string' ? tryParseJson(item) : item;
                if (contentObj && (contentObj.type === 'image_url' || contentObj.type === 'file')) {
                    if (isInCollection(contentObj)) {
                        const filename = extractFilenameFromFileContent(contentObj);
                        return { type: 'text', text: `[File: ${filename} - available via file tools]` };
                    }
                    return contentObj;
                }
                return item;
            });
            return { ...message, content: newContent };
        }
        if (typeof message.content === 'object' && message.content !== null) {
            if ((message.content.type === 'image_url' || message.content.type === 'file') && isInCollection(message.content)) {
                const filename = extractFilenameFromFileContent(message.content);
                return { ...message, content: `[File: ${filename} - available via file tools]` };
            }
        }
        if (typeof message.content === 'string') {
            const contentObj = tryParseJson(message.content);
            if (contentObj && (contentObj.type === 'image_url' || contentObj.type === 'file') && isInCollection(contentObj)) {
                const filename = extractFilenameFromFileContent(contentObj);
                return { ...message, content: `[File: ${filename} - available via file tools]` };
            }
        }
        return message;
    });

    const availableFiles = formatFilesForTemplate(allFiles);
    return { chatHistory: processedHistory, availableFiles };
}


/**
 * Build file location params for file handler routing.
 */
function buildFileLocation(contextId, { chatId, workspaceId, fileScope } = {}) {
    return { userId: contextId, ...(chatId ? { chatId } : {}), fileScope: fileScope || 'global' };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
    deleteTempPath,
    deleteFileByName,
    downloadFile,
    generateUniqueFilename,
    fetchFileFromUrl,
    getMediaChunks,
    markCompletedForCleanUp,
    extractFileMetadataFromContent,
    extractFilesFromChatHistory,
    getAvailableFilesFromCollection,
    getDefaultContext,
    formatFilesForTemplate,
    getAvailableFiles,
    syncAndStripFilesFromChatHistory,
    findFileInCollection,
    generateFileMessageContent,
    injectFileIntoChatHistory,

    loadFileCollection,
    listFilesForContext,
    getSignedFileUrl,
    buildFileCreationResponse,
    uploadFileToCloud,
    uploadImageToCloud,
    getMimeTypeFromFilename,
    getMimeTypeFromExtension,
    isTextMimeType,
    getActualContentMimeType,
    isYoutubeUrl,
    extractFilenameFromUrl,
    ensureFilenameExtension,
    determineMimeTypeFromUrl,
    buildFileLocation,
};
