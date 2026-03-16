// File type extension constants

export const DOC_EXTENSIONS = [
  ".txt",
  ".json",
  ".csv",
  ".md",
  ".xml",
  ".js",
  ".html",
  ".css",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
];

export const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".pdf",
];

export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mpeg",
  ".mov",
  ".avi",
  ".flv",
  ".mpg",
  ".webm",
  ".wmv",
  ".3gp",
];

export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".aac", ".ogg", ".flac"];

export const ACCEPTED_MIME_TYPES = {
  // Document types
  "text/plain": [".txt"],
  "application/json": [".json"],
  "text/csv": [".csv"],
  "text/markdown": [".md"],
  "application/xml": [".xml"],
  "text/javascript": [".js"],
  "text/html": [".html"],
  "text/css": [".css"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/msword": [".doc"],
  "application/vnd.ms-excel": [".xls"],

  // Image types
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
  "image/heif": [".heif"],
  "application/octet-stream": [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"],
  "application/pdf": [".pdf"],

  // Audio types
  "audio/wav": [".wav"],
  "audio/mpeg": [".mp3"],
  "audio/aac": [".aac"],
  "audio/ogg": [".ogg"],
  "audio/flac": [".flac"],
  "audio/m4a": [".m4a"],
  "audio/x-m4a": [".m4a"],
  "audio/mp3": [".mp3"],
  "audio/mp4": [".mp4"],

  // Video types
  "video/mp4": [".mp4"],
  "video/mpeg": [".mpeg", ".mpg"],
  "video/mov": [".mov"],
  "video/quicktime": [".mov"],
  "video/x-msvideo": [".avi"],
  "video/x-flv": [".flv"],
  "video/mpg": [".mpeg", ".mpg"],
  "video/webm": [".webm"],
  "video/wmv": [".wmv"],
  "video/3gpp": [".3gp"],
};

/**
 * Get the GCS bucket name from environment.
 * Throws if GCS_BUCKETNAME is not set.
 */
export function getGCSBucketName() {
  const bucketName = process.env.GCS_BUCKETNAME;
  if (!bucketName || bucketName.trim() === "") {
    throw new Error(
      "GCS_BUCKETNAME environment variable is required but not set."
    );
  }
  return bucketName.trim();
}
