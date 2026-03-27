import test from "ava";
import { constructFolderPath, _resetForTesting } from "../src/storage.js";
import {
  sanitizeFilename,
  constructBlobName,
  appendFilenameSuffix,
  isTextMimeType,
} from "../src/utils.js";
import { getGCSBucketName } from "../src/constants.js";

// Reset singletons between tests
test.afterEach(() => {
  _resetForTesting();
});

// ─── constructFolderPath ─────────────────────────────────────────────────────

test("constructFolderPath: no args returns empty string (root)", (t) => {
  t.is(constructFolderPath(), "");
  t.is(constructFolderPath({}), "");
});

test("constructFolderPath: userId only returns userId/", (t) => {
  t.is(constructFolderPath({ userId: "user1" }), "user1/");
});

test("constructFolderPath: userId + chatId returns chats path", (t) => {
  t.is(
    constructFolderPath({ userId: "user1", chatId: "chat99" }),
    "user1/chats/chat99/"
  );
});

test("constructFolderPath: chatId takes priority over fileScope", (t) => {
  t.is(
    constructFolderPath({ userId: "u1", chatId: "c1", fileScope: "global" }),
    "u1/chats/c1/"
  );
});

test("constructFolderPath: userId + global scope", (t) => {
  t.is(
    constructFolderPath({ userId: "user1", fileScope: "global" }),
    "user1/global/"
  );
});

test("constructFolderPath: userId + media scope", (t) => {
  t.is(
    constructFolderPath({ userId: "user1", fileScope: "media" }),
    "user1/media/"
  );
});

test("constructFolderPath: userId + profile scope", (t) => {
  t.is(
    constructFolderPath({ userId: "user1", fileScope: "profile" }),
    "user1/profile/"
  );
});

test("constructFolderPath: userId + custom scope", (t) => {
  t.is(
    constructFolderPath({ userId: "user1", fileScope: "custom" }),
    "user1/custom/"
  );
});

test("constructFolderPath: no userId with chatId still returns empty (no userId)", (t) => {
  t.is(constructFolderPath({ chatId: "c1" }), "");
});

// ─── sanitizeFilename ────────────────────────────────────────────────────────

test("sanitizeFilename: normal filename passes through", (t) => {
  t.is(sanitizeFilename("photo.jpg"), "photo.jpg");
});

test("sanitizeFilename: removes path traversal", (t) => {
  t.is(sanitizeFilename("../../etc/passwd"), "passwd");
  t.is(sanitizeFilename("/absolute/path/file.txt"), "file.txt");
});

test("sanitizeFilename: removes invalid characters", (t) => {
  const result = sanitizeFilename('file<name>:with"bad|chars?.txt');
  t.false(result.includes("<"));
  t.false(result.includes(">"));
  t.false(result.includes(":"));
  t.false(result.includes('"'));
  t.false(result.includes("|"));
  t.false(result.includes("?"));
  t.true(result.endsWith(".txt"));
});

test("sanitizeFilename: decodes URI components", (t) => {
  t.is(sanitizeFilename("hello%20world.txt"), "hello world.txt");
});

test("sanitizeFilename: limits length to 200 chars", (t) => {
  const longName = "a".repeat(250) + ".txt";
  const result = sanitizeFilename(longName);
  t.true(result.length <= 200);
  t.true(result.endsWith(".txt"));
});

test("sanitizeFilename: empty/null returns default", (t) => {
  t.is(sanitizeFilename(""), "file");
  t.is(sanitizeFilename(null), "file");
  t.is(sanitizeFilename(undefined), "file");
});

test("sanitizeFilename: collapses multiple underscores", (t) => {
  t.is(sanitizeFilename("a___b.txt"), "a_b.txt");
});

test("sanitizeFilename: handles windows-style backslash paths", (t) => {
  // On Unix, backslashes are replaced by the invalid-chars filter, not treated as separators.
  // The important thing is the result is safe and usable.
  const result = sanitizeFilename("C:\\Users\\test\\file.txt");
  t.false(result.includes("\\"));
  t.true(result.endsWith(".txt"));
});

// ─── constructBlobName ───────────────────────────────────────────────────────

test("constructBlobName: basic construction", (t) => {
  t.is(constructBlobName("photo.jpg", ""), "photo.jpg");
});

test("constructBlobName: with folder path", (t) => {
  t.is(constructBlobName("photo.jpg", "user1/global/"), "user1/global/photo.jpg");
});

test("constructBlobName: sanitizes filename", (t) => {
  const result = constructBlobName("../../bad.txt", "user1/");
  t.is(result, "user1/bad.txt");
});

test("constructBlobName: empty folder path", (t) => {
  t.is(constructBlobName("file.txt"), "file.txt");
});

test("appendFilenameSuffix: inserts suffix before extension", (t) => {
  t.is(appendFilenameSuffix("photo.jpg", 2), "photo-2.jpg");
});

test("appendFilenameSuffix: handles filenames without extension", (t) => {
  t.is(appendFilenameSuffix("README", 3), "README-3");
});

// ─── isTextMimeType ──────────────────────────────────────────────────────────

test("isTextMimeType: text/* types are text", (t) => {
  t.true(isTextMimeType("text/plain"));
  t.true(isTextMimeType("text/html"));
  t.true(isTextMimeType("text/css"));
  t.true(isTextMimeType("text/csv"));
});

test("isTextMimeType: application/json is text", (t) => {
  t.true(isTextMimeType("application/json"));
});

test("isTextMimeType: application/xml is text", (t) => {
  t.true(isTextMimeType("application/xml"));
});

test("isTextMimeType: binary types are not text", (t) => {
  t.false(isTextMimeType("image/png"));
  t.false(isTextMimeType("application/pdf"));
  t.false(isTextMimeType("video/mp4"));
  t.false(isTextMimeType("application/octet-stream"));
});

test("isTextMimeType: handles charset suffix", (t) => {
  t.true(isTextMimeType("text/plain; charset=utf-8"));
  t.true(isTextMimeType("application/json; charset=utf-8"));
});

test("isTextMimeType: null/undefined returns false", (t) => {
  t.false(isTextMimeType(null));
  t.false(isTextMimeType(undefined));
  t.false(isTextMimeType(""));
});

// ─── getGCSBucketName ────────────────────────────────────────────────────────

test("getGCSBucketName: throws when not set", (t) => {
  const orig = process.env.GCS_BUCKETNAME;
  delete process.env.GCS_BUCKETNAME;
  t.throws(() => getGCSBucketName(), {
    message: /GCS_BUCKETNAME environment variable is required/,
  });
  // Restore
  if (orig !== undefined) process.env.GCS_BUCKETNAME = orig;
});

test("getGCSBucketName: returns bucket name when set", (t) => {
  const orig = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "my-test-bucket";
  t.is(getGCSBucketName(), "my-test-bucket");
  // Restore
  if (orig !== undefined) {
    process.env.GCS_BUCKETNAME = orig;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});

test("getGCSBucketName: trims whitespace", (t) => {
  const orig = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "  my-bucket  ";
  t.is(getGCSBucketName(), "my-bucket");
  if (orig !== undefined) {
    process.env.GCS_BUCKETNAME = orig;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});

test("getGCSBucketName: throws on empty string", (t) => {
  const orig = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "   ";
  t.throws(() => getGCSBucketName(), {
    message: /GCS_BUCKETNAME environment variable is required/,
  });
  if (orig !== undefined) {
    process.env.GCS_BUCKETNAME = orig;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});
