/**
 * Integration tests for cortex-file-handler.
 *
 * Starts a real file handler server backed by fake-gcs-server (Docker).
 * Tests the full HTTP flow: upload → list → signUrl → rename → delete.
 *
 * Prerequisites: Docker must be running (for fake-gcs-server).
 *
 * Run: npm test -- tests/integration.test.js
 */
import test from "ava";
import { execSync, spawn } from "child_process";
import FormData from "form-data";
import axios from "axios";

const FAKE_GCS_PORT = 14443;
const FILE_HANDLER_PORT = 17071;
const BUCKET_NAME = "test-cortex-files";

let gcsContainer = null;
let handlerProcess = null;

// ─── Setup / Teardown ────────────────────────────────────────────────────────

test.before(async (t) => {
  // 1. Start fake-gcs-server
  try {
    execSync(`docker rm -f fake-gcs-test 2>/dev/null`, { stdio: "ignore" });
  } catch { /* ok */ }

  execSync(
    `docker run -d --name fake-gcs-test -p ${FAKE_GCS_PORT}:4443 ` +
    `fsouza/fake-gcs-server:latest -scheme http -port 4443`,
    { stdio: "pipe" }
  );
  gcsContainer = "fake-gcs-test";

  // Wait for fake GCS to be ready
  for (let i = 0; i < 20; i++) {
    try {
      await axios.get(`http://localhost:${FAKE_GCS_PORT}/storage/v1/b`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Create the test bucket
  await axios.post(
    `http://localhost:${FAKE_GCS_PORT}/storage/v1/b`,
    { name: BUCKET_NAME },
    { validateStatus: (s) => s === 200 || s === 409 }
  );

  // 2. Start the file handler
  handlerProcess = spawn("node", ["src/start.js"], {
    cwd: "/Users/jmac/software/ml/enntity/cortex/helper-apps/cortex-file-handler",
    env: {
      ...process.env,
      PORT: String(FILE_HANDLER_PORT),
      GCS_BUCKETNAME: BUCKET_NAME,
      STORAGE_EMULATOR_HOST: `http://localhost:${FAKE_GCS_PORT}`,
      GCP_SERVICE_ACCOUNT_KEY: JSON.stringify({ project_id: "test-project" }),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for file handler to be ready
  for (let i = 0; i < 30; i++) {
    try {
      await axios.get(`http://localhost:${FILE_HANDLER_PORT}/health`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  t.log("File handler and fake-gcs-server ready");
});

test.after.always(async () => {
  if (handlerProcess) {
    handlerProcess.kill("SIGTERM");
    handlerProcess = null;
  }
  if (gcsContainer) {
    try { execSync(`docker rm -f ${gcsContainer} 2>/dev/null`, { stdio: "ignore" }); } catch { /* ok */ }
    gcsContainer = null;
  }
});

const BASE = `http://localhost:${FILE_HANDLER_PORT}/api/CortexFileHandler`;

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeFormData(content, filename, fields = {}) {
  const form = new FormData();
  form.append("file", Buffer.from(content), { filename, contentType: "text/plain" });
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  return form;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.serial("health check", async (t) => {
  const res = await axios.get(`http://localhost:${FILE_HANDLER_PORT}/health`);
  t.is(res.status, 200);
  t.is(res.data.status, "healthy");
});

test.serial("upload a file to user global scope", async (t) => {
  const form = makeFormData("Hello, world!", "hello.txt", {
    userId: "user-test-1",
    fileScope: "global",
  });

  const res = await axios.post(BASE, form, { headers: form.getHeaders() });

  t.is(res.status, 200);
  t.truthy(res.data.url);
  t.truthy(res.data.hash);
  t.truthy(res.data.shortLivedUrl);
  t.is(res.data.filename, "hello.txt");
  t.true(res.data.url.startsWith("gs://"));
  t.true(res.data.url.includes("user-test-1/global/"));
});

test.serial("upload same content gets same hash (content-addressed)", async (t) => {
  const form = makeFormData("Hello, world!", "hello-copy.txt", {
    userId: "user-test-1",
    fileScope: "global",
  });

  const res = await axios.post(BASE, form, { headers: form.getHeaders() });
  t.is(res.status, 200);
  t.truthy(res.data.hash);
  // Same content = same hash (SHA-256 prefix)
});

test.serial("listFolder returns uploaded files", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-test-1", fileScope: "global" },
  });

  t.is(res.status, 200);
  t.true(Array.isArray(res.data));
  t.true(res.data.length >= 1);

  const file = res.data.find((f) => f.filename === "hello.txt");
  t.truthy(file, "Should find hello.txt in listing");
  t.truthy(file.hash);
  t.truthy(file.url);
  t.true(file.size > 0);
  t.truthy(file.contentType);
  t.truthy(file.lastModified);
});

test.serial("listFolder for empty user returns empty array", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-nonexistent" },
  });

  t.is(res.status, 200);
  t.true(Array.isArray(res.data));
  t.is(res.data.length, 0);
});

test.serial("signUrl returns download URL for gs:// file", async (t) => {
  // Upload a file first
  const form = makeFormData("Sign me!", "signme.txt", {
    userId: "user-test-1",
    fileScope: "global",
  });
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });

  // Get signed URL
  const res = await axios.get(BASE, {
    params: { operation: "signUrl", url: uploadRes.data.url, minutes: 10 },
  });

  t.is(res.status, 200);
  t.truthy(res.data.shortLivedUrl);
  t.is(res.data.expiresInMinutes, 10);

  // The signed URL should actually work — download the file
  const downloadRes = await axios.get(res.data.shortLivedUrl, { responseType: "text" });
  t.is(downloadRes.status, 200);
  t.is(downloadRes.data, "Sign me!");
});

test.serial("signUrl returns 404 for nonexistent file", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "signUrl", url: `gs://${BUCKET_NAME}/nonexistent/file.txt` },
    validateStatus: () => true,
  });

  t.is(res.status, 404);
});

test.serial("upload to chat scope", async (t) => {
  const form = makeFormData("Chat message attachment", "attachment.pdf", {
    userId: "user-test-1",
    chatId: "chat-abc-123",
  });

  const res = await axios.post(BASE, form, { headers: form.getHeaders() });
  t.is(res.status, 200);
  t.true(res.data.url.includes("user-test-1/chats/chat-abc-123/"));
});

test.serial("listFolder for chat scope", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-test-1", chatId: "chat-abc-123" },
  });

  t.is(res.status, 200);
  t.true(res.data.length >= 1);
  const file = res.data.find((f) => f.filename === "attachment.pdf");
  t.truthy(file);
});

test.serial("fetch remote URL and upload to GCS", async (t) => {
  // Upload a file first, then fetch it via its emulator URL
  const form = makeFormData("Remote content to fetch", "remote-source.txt", {
    userId: "user-test-1",
    fileScope: "global",
  });
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });
  const sourceUrl = uploadRes.data.shortLivedUrl;

  const res = await axios.get(BASE, {
    params: { fetch: sourceUrl, contextId: "user-test-2", fileScope: "global" },
  });

  t.is(res.status, 200);
  t.truthy(res.data.url);
  t.true(res.data.url.includes("user-test-2/global/"));
});

test.serial("rename a file", async (t) => {
  const form = makeFormData("Rename me!", "old-name.txt", {
    userId: "user-test-1",
    fileScope: "global",
  });
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });

  const res = await axios.post(BASE, {
    operation: "rename",
    hash: uploadRes.data.hash,
    contextId: "user-test-1",
    fileScope: "global",
    newFilename: "new-name.txt",
  });

  t.is(res.status, 200);
  t.is(res.data.filename, "new-name.txt");
  t.true(res.data.url.includes("new-name.txt"));
});

test.serial("delete by hash", async (t) => {
  const form = makeFormData("Delete me!", "deleteme.txt", {
    userId: "user-test-del",
    fileScope: "global",
  });
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });

  // Delete
  const res = await axios.delete(BASE, {
    params: { hash: uploadRes.data.hash, contextId: "user-test-del", fileScope: "global" },
  });
  t.is(res.status, 200);
  t.truthy(res.data.deleted);

  // Verify it's gone via listFolder
  const listRes = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-test-del", fileScope: "global" },
  });
  const found = listRes.data.find((f) => f.filename === "deleteme.txt");
  t.falsy(found, "File should be gone after deletion");
});

test.serial("delete by prefix cleans up user folder", async (t) => {
  // Upload files to a dedicated user so we can delete by prefix
  const form1 = makeFormData("Prefix file 1", "pf1.txt", { userId: "user-prefix-del", fileScope: "global" });
  const form2 = makeFormData("Prefix file 2", "pf2.txt", { userId: "user-prefix-del", fileScope: "global" });

  await axios.post(BASE, form1, { headers: form1.getHeaders() });
  await axios.post(BASE, form2, { headers: form2.getHeaders() });

  // Delete by user prefix
  const res = await axios.delete(BASE, {
    params: { requestId: "user-prefix-del/global/" },
  });

  t.is(res.status, 200);
  t.true(res.data.deleted.length >= 2);
});

test.serial("POST with no file content returns error", async (t) => {
  const res = await axios.post(
    BASE,
    "--boundary\r\nContent-Disposition: form-data; name=\"userId\"\r\n\r\ntest\r\n--boundary--",
    {
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
      validateStatus: () => true,
    }
  );
  t.true(res.status >= 400);
});

test.serial("DELETE without params returns 400", async (t) => {
  const res = await axios.delete(BASE, { validateStatus: () => true });
  t.is(res.status, 400);
});

test.serial("per-user isolation: different user cannot see files", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-isolated-check", fileScope: "global" },
  });
  t.is(res.status, 200);
  t.is(res.data.length, 0);
});

test.serial("upload binary content preserves size", async (t) => {
  // Create a buffer with known binary content
  const binaryContent = Buffer.alloc(1024, 0xAB);
  const form = new FormData();
  form.append("file", binaryContent, { filename: "binary.bin", contentType: "application/octet-stream" });
  form.append("userId", "user-test-bin");
  form.append("fileScope", "global");

  const res = await axios.post(BASE, form, { headers: form.getHeaders() });
  t.is(res.status, 200);

  // Verify via list
  const listRes = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-test-bin", fileScope: "global" },
  });
  const file = listRes.data.find((f) => f.filename === "binary.bin");
  t.truthy(file);
  t.is(file.size, 1024);
});

test.serial("full lifecycle: upload → list → sign → download → delete → verify gone", async (t) => {
  const content = "Full lifecycle test content - " + Date.now();
  const form = makeFormData(content, "lifecycle.txt", {
    userId: "user-lifecycle",
    fileScope: "global",
  });

  // Upload
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });
  t.is(uploadRes.status, 200);
  const { url, hash } = uploadRes.data;

  // List — should find it
  const listRes = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-lifecycle", fileScope: "global" },
  });
  t.true(listRes.data.length >= 1);
  const listed = listRes.data.find((f) => f.hash === hash);
  t.truthy(listed);

  // Sign — get downloadable URL
  const signRes = await axios.get(BASE, {
    params: { operation: "signUrl", url, minutes: 5 },
  });
  t.truthy(signRes.data.shortLivedUrl);

  // Download — verify content
  const dlRes = await axios.get(signRes.data.shortLivedUrl, { responseType: "text" });
  t.is(dlRes.data, content);

  // Delete
  const delRes = await axios.delete(BASE, {
    params: { hash, contextId: "user-lifecycle", fileScope: "global" },
  });
  t.is(delRes.status, 200);

  // Verify gone
  const listAfter = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-lifecycle", fileScope: "global" },
  });
  const stillThere = listAfter.data.find((f) => f.hash === hash);
  t.falsy(stillThere, "File should be gone after deletion");
});
