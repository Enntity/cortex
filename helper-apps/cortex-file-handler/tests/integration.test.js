/**
 * Integration tests for cortex-file-handler (GCS-only, no hashing).
 *
 * Starts a real file handler server backed by fake-gcs-server (Docker).
 * Tests the full HTTP flow: upload → list → signUrl → rename → delete.
 *
 * Prerequisites: Docker must be running (for fake-gcs-server).
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

test.before(async (t) => {
  try { execSync(`docker rm -f fake-gcs-test 2>/dev/null`, { stdio: "ignore" }); } catch { /* ok */ }

  execSync(
    `docker run -d --name fake-gcs-test -p ${FAKE_GCS_PORT}:4443 ` +
    `fsouza/fake-gcs-server:latest -scheme http -port 4443`,
    { stdio: "pipe" }
  );
  gcsContainer = "fake-gcs-test";

  for (let i = 0; i < 20; i++) {
    try {
      await axios.get(`http://localhost:${FAKE_GCS_PORT}/storage/v1/b`, { timeout: 1000 });
      break;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }

  await axios.post(
    `http://localhost:${FAKE_GCS_PORT}/storage/v1/b`,
    { name: BUCKET_NAME },
    { validateStatus: (s) => s === 200 || s === 409 }
  );

  handlerProcess = spawn("node", ["src/start.js"], {
    cwd: new URL("../", import.meta.url).pathname,
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

  for (let i = 0; i < 30; i++) {
    try {
      await axios.get(`http://localhost:${FILE_HANDLER_PORT}/health`, { timeout: 1000 });
      break;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  t.log("File handler and fake-gcs-server ready");
});

test.after.always(async () => {
  if (handlerProcess) { handlerProcess.kill("SIGTERM"); handlerProcess = null; }
  if (gcsContainer) { try { execSync(`docker rm -f ${gcsContainer} 2>/dev/null`, { stdio: "ignore" }); } catch { /* ok */ } gcsContainer = null; }
});

const BASE = `http://localhost:${FILE_HANDLER_PORT}/api/CortexFileHandler`;

function makeFormData(content, filename, fields = {}) {
  const form = new FormData();
  form.append("file", Buffer.from(content), { filename, contentType: "text/plain" });
  for (const [k, v] of Object.entries(fields)) { form.append(k, v); }
  return form;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.serial("health check", async (t) => {
  const res = await axios.get(`http://localhost:${FILE_HANDLER_PORT}/health`);
  t.is(res.status, 200);
  t.is(res.data.status, "healthy");
});

test.serial("upload a file", async (t) => {
  const form = makeFormData("Hello, world!", "hello.txt", { userId: "user-1", fileScope: "global" });
  const res = await axios.post(BASE, form, { headers: form.getHeaders() });

  t.is(res.status, 200);
  t.is(res.data.filename, "hello.txt");
  t.truthy(res.data.url);
  t.is(res.data.blobPath, "user-1/global/hello.txt");
});

test.serial("upload overwrites same filename", async (t) => {
  const form = makeFormData("Updated content", "hello.txt", { userId: "user-1", fileScope: "global" });
  const res = await axios.post(BASE, form, { headers: form.getHeaders() });

  t.is(res.status, 200);
  t.is(res.data.filename, "hello.txt");

  // Download and verify content was overwritten
  const dlRes = await axios.get(res.data.url, { responseType: "text" });
  t.is(dlRes.data, "Updated content");
});

test.serial("listFolder returns files", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-1", fileScope: "global" },
  });

  t.is(res.status, 200);
  t.true(Array.isArray(res.data));
  t.true(res.data.length >= 1);

  const file = res.data.find((f) => f.filename === "hello.txt");
  t.truthy(file);
  t.truthy(file.url);
  t.truthy(file.displayFilename);
  t.true(file.size > 0);
});

test.serial("listFolder for empty user returns empty array", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-nonexistent" },
  });
  t.is(res.status, 200);
  t.deepEqual(res.data, []);
});

test.serial("signUrl returns download URL", async (t) => {
  const form = makeFormData("Sign me!", "signme.txt", { userId: "user-1", fileScope: "global" });
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });

  const res = await axios.get(BASE, {
    params: { operation: "signUrl", blobPath: uploadRes.data.blobPath, minutes: 10 },
  });

  t.is(res.status, 200);
  t.truthy(res.data.url);
  t.is(res.data.expiresInMinutes, 10);
  t.is(res.data.blobPath, "user-1/global/signme.txt");

  // Actually download it
  const dlRes = await axios.get(res.data.url, { responseType: "text" });
  t.is(dlRes.data, "Sign me!");
});

test.serial("signUrl returns 404 for nonexistent file", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "signUrl", blobPath: "nonexistent.txt" },
    validateStatus: () => true,
  });
  t.is(res.status, 404);
});

test.serial("upload to chat scope", async (t) => {
  const form = makeFormData("Chat attachment", "doc.pdf", { userId: "user-1", chatId: "chat-123" });
  const res = await axios.post(BASE, form, { headers: form.getHeaders() });

  t.is(res.status, 200);
  t.is(res.data.blobPath, "user-1/chats/chat-123/doc.pdf");
});

test.serial("listFolder for chat scope", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-1", chatId: "chat-123" },
  });
  t.true(res.data.length >= 1);
  t.truthy(res.data.find((f) => f.filename === "doc.pdf"));
});

test.serial("fetch remote URL", async (t) => {
  // Upload a source file, then fetch it into another user's scope
  const form = makeFormData("Fetchable content", "source.txt", { userId: "user-1", fileScope: "global" });
  const uploadRes = await axios.post(BASE, form, { headers: form.getHeaders() });

  const res = await axios.get(BASE, {
    params: { fetch: uploadRes.data.url, contextId: "user-2", fileScope: "global" },
  });

  t.is(res.status, 200);
  t.truthy(res.data.url);
  t.is(res.data.blobPath.startsWith("user-2/global/"), true);
});

test.serial("rename a file", async (t) => {
  const form = makeFormData("Rename me!", "old-name.txt", { userId: "user-1", fileScope: "global" });
  await axios.post(BASE, form, { headers: form.getHeaders() });

  const res = await axios.post(BASE, {
    operation: "rename",
    filename: "old-name.txt",
    contextId: "user-1",
    fileScope: "global",
    newFilename: "new-name.txt",
  });

  t.is(res.status, 200);
  t.is(res.data.filename, "new-name.txt");
  t.is(res.data.blobPath, "user-1/global/new-name.txt");
});

test.serial("delete by filename", async (t) => {
  const form = makeFormData("Delete me!", "deleteme.txt", { userId: "user-del", fileScope: "global" });
  await axios.post(BASE, form, { headers: form.getHeaders() });

  const res = await axios.delete(BASE, {
    params: { filename: "deleteme.txt", contextId: "user-del", fileScope: "global" },
  });
  t.is(res.status, 200);

  // Verify it's gone
  const listRes = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-del", fileScope: "global" },
  });
  t.falsy(listRes.data.find((f) => f.filename === "deleteme.txt"));
});

test.serial("delete by prefix", async (t) => {
  const form1 = makeFormData("F1", "pf1.txt", { userId: "user-prefix", fileScope: "global" });
  const form2 = makeFormData("F2", "pf2.txt", { userId: "user-prefix", fileScope: "global" });
  await axios.post(BASE, form1, { headers: form1.getHeaders() });
  await axios.post(BASE, form2, { headers: form2.getHeaders() });

  const res = await axios.delete(BASE, { params: { prefix: "user-prefix/global/" } });
  t.is(res.status, 200);
  t.true(res.data.deleted.length >= 2);
});

test.serial("POST with no file returns error", async (t) => {
  const res = await axios.post(
    BASE,
    "--boundary\r\nContent-Disposition: form-data; name=\"userId\"\r\n\r\ntest\r\n--boundary--",
    { headers: { "Content-Type": "multipart/form-data; boundary=boundary" }, validateStatus: () => true }
  );
  t.true(res.status >= 400);
});

test.serial("DELETE without params returns 400", async (t) => {
  const res = await axios.delete(BASE, { validateStatus: () => true });
  t.is(res.status, 400);
});

test.serial("per-user isolation", async (t) => {
  const res = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-isolated", fileScope: "global" },
  });
  t.is(res.data.length, 0);
});

test.serial("binary content preserves size", async (t) => {
  const binary = Buffer.alloc(1024, 0xAB);
  const form = new FormData();
  form.append("file", binary, { filename: "binary.bin", contentType: "application/octet-stream" });
  form.append("userId", "user-bin");
  form.append("fileScope", "global");

  const res = await axios.post(BASE, form, { headers: form.getHeaders() });
  t.is(res.status, 200);

  const listRes = await axios.get(BASE, {
    params: { operation: "listFolder", userId: "user-bin", fileScope: "global" },
  });
  const file = listRes.data.find((f) => f.filename === "binary.bin");
  t.truthy(file);
  t.is(file.size, 1024);
});

test.serial("full lifecycle: upload → list → sign → download → delete → verify", async (t) => {
  const content = "Lifecycle test - " + Date.now();
  const fname = "lifecycle.txt";
  const form = makeFormData(content, fname, { userId: "user-lc", fileScope: "global" });

  // Upload
  const up = await axios.post(BASE, form, { headers: form.getHeaders() });
  t.is(up.status, 200);

  // List
  const list = await axios.get(BASE, { params: { operation: "listFolder", userId: "user-lc", fileScope: "global" } });
  t.truthy(list.data.find((f) => f.filename === fname));

  // Sign
  const sign = await axios.get(BASE, { params: { operation: "signUrl", blobPath: up.data.blobPath, minutes: 5 } });
  t.truthy(sign.data.url);

  // Download
  const dl = await axios.get(sign.data.url, { responseType: "text" });
  t.is(dl.data, content);

  // Delete
  const del = await axios.delete(BASE, { params: { filename: fname, contextId: "user-lc", fileScope: "global" } });
  t.is(del.status, 200);

  // Verify gone
  const after = await axios.get(BASE, { params: { operation: "listFolder", userId: "user-lc", fileScope: "global" } });
  t.falsy(after.data.find((f) => f.filename === fname));
});
