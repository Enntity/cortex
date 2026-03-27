import path from "path";

/**
 * Sanitize a filename by removing path traversal, invalid chars,
 * decoding URI components, and limiting length.
 * @param {string} name - Raw filename
 * @returns {string} Sanitized filename
 */
export function sanitizeFilename(name) {
  if (!name) return "file";

  // Decode URI-encoded characters
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // If decoding fails, use original
  }

  // Strip to basename to prevent path traversal
  let basename = path.basename(decoded);

  // Remove characters that are invalid in filenames
  basename = basename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");

  // Collapse multiple underscores
  basename = basename.replace(/_+/g, "_");

  // Remove leading/trailing underscores and dots (avoid hidden files)
  basename = basename.replace(/^[_.]+|[_]+$/g, "");

  // Limit total length to 200 characters, preserving extension
  if (basename.length > 200) {
    const ext = path.extname(basename);
    const stem = basename.slice(0, 200 - ext.length);
    basename = stem + ext;
  }

  return basename || "file";
}

/**
 * Construct a blob name from filename and folder path.
 * If a file with the same name already exists, a short timestamp
 * suffix is added to avoid silent overwrites.
 * @param {string} filename - Sanitized filename
 * @param {string} folderPath - Folder prefix (should end with '/' or be empty)
 * @returns {string} Full blob name
 */
export function constructBlobName(filename, folderPath = "") {
  const sanitized = sanitizeFilename(filename);
  return `${folderPath}${sanitized}`;
}

/**
 * Append a suffix before the filename extension.
 * @param {string} filename - Filename to modify
 * @param {string|number} suffix - Suffix to append
 * @returns {string}
 */
export function appendFilenameSuffix(filename, suffix) {
  const sanitized = sanitizeFilename(filename);
  const parsed = path.parse(sanitized);
  return `${parsed.name}-${suffix}${parsed.ext}`;
}

/**
 * Check if a MIME type is text-based (should get charset=utf-8).
 * @param {string} mimeType - MIME type string
 * @returns {boolean}
 */
export function isTextMimeType(mimeType) {
  if (!mimeType) return false;
  const baseType = mimeType.split(";")[0].trim().toLowerCase();
  return (
    baseType.startsWith("text/") ||
    baseType === "application/json" ||
    baseType === "application/javascript" ||
    baseType === "application/xml" ||
    baseType === "application/xhtml+xml" ||
    baseType === "application/x-sh" ||
    baseType === "application/x-shellscript"
  );
}
