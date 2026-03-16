import test from "ava";
import http from "http";
import { app } from "../src/start.js";

// Start a test server
let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

test.after.always(() => {
  if (server) server.close();
});

/**
 * Helper: make an HTTP request and return { status, data }.
 */
async function request(method, path, { body, headers = {} } = {}) {
  const url = new URL(path, baseUrl);
  const opts = {
    method,
    headers: { ...headers },
  };

  let bodyStr;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    bodyStr = JSON.stringify(body);
    opts.headers["content-type"] = opts.headers["content-type"] || "application/json";
    opts.headers["content-length"] = Buffer.byteLength(bodyStr);
  } else {
    bodyStr = body;
    if (bodyStr) {
      opts.headers["content-length"] = Buffer.byteLength(bodyStr);
    }
  }

  return new Promise((resolve, reject) => {
    const req = http.request(url, opts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Health check ────────────────────────────────────────────────────────────

test("health check returns healthy", async (t) => {
  const { status, data } = await request("GET", "/health");
  t.is(status, 200);
  t.is(data.status, "healthy");
  t.is(data.version, "3.0.0");
});

// ─── GET: missing params ─────────────────────────────────────────────────────

test("GET without params returns 400", async (t) => {
  const { status, data } = await request("GET", "/api/CortexFileHandler");
  t.is(status, 400);
  t.truthy(data.error);
});

// ─── GET: checkHash without hash returns 400 ────────────────────────────────

test("GET checkHash without hash returns 400", async (t) => {
  const { status, data } = await request("GET", "/api/CortexFileHandler?checkHash=true");
  t.is(status, 400);
  t.truthy(data.error);
  t.regex(data.error, /hash/i);
});

// ─── DELETE: missing params returns 400 ──────────────────────────────────────

test("DELETE without hash or requestId returns 400", async (t) => {
  const { status, data } = await request("DELETE", "/api/CortexFileHandler");
  t.is(status, 400);
  t.truthy(data.error);
});

// ─── POST: non-multipart without operation returns 400 ──────────────────────

test("POST with json but no operation returns 400", async (t) => {
  const { status, data } = await request("POST", "/api/CortexFileHandler", {
    body: { foo: "bar" },
  });
  t.is(status, 400);
  t.truthy(data.error);
});

// ─── POST: rename without required params ────────────────────────────────────

test("POST rename without hash returns 400", async (t) => {
  const { status, data } = await request("POST", "/api/CortexFileHandler?operation=rename", {
    body: { newFilename: "test.txt" },
  });
  t.is(status, 400);
  t.truthy(data.error);
  t.regex(data.error, /hash/i);
});

test("POST rename without newFilename returns 400", async (t) => {
  const { status, data } = await request("POST", "/api/CortexFileHandler?operation=rename", {
    body: { hash: "abc123" },
  });
  t.is(status, 400);
  t.truthy(data.error);
  t.regex(data.error, /newFilename/i);
});

// ─── Legacy endpoint ─────────────────────────────────────────────────────────

test("MediaFileChunker endpoint responds", async (t) => {
  const { status } = await request("GET", "/api/MediaFileChunker");
  // Should get same behavior as CortexFileHandler — a 400 for missing params
  t.is(status, 400);
});

// ─── Unsupported method ──────────────────────────────────────────────────────

test("PATCH returns 405", async (t) => {
  const { status, data } = await request("PATCH", "/api/CortexFileHandler");
  t.is(status, 405);
  t.truthy(data.error);
});

// ─── GET: checkHash with nonexistent hash ────────────────────────────────────

test.serial("GET checkHash with nonexistent hash returns 404 or error", async (t) => {
  // This will fail if GCS is not configured, which is expected in CI
  const origBucket = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "test-bucket-nonexistent";

  const { status } = await request(
    "GET",
    "/api/CortexFileHandler?checkHash=true&hash=nonexistent123"
  );

  // Either 404 (not found) or 500 (no GCS creds) — both are valid in test
  t.true(status === 404 || status === 500);

  if (origBucket !== undefined) {
    process.env.GCS_BUCKETNAME = origBucket;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});

// ─── DELETE: with hash but no GCS ────────────────────────────────────────────

test.serial("DELETE with hash but no GCS configured returns error", async (t) => {
  const origBucket = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "test-bucket-nonexistent";

  const { status } = await request(
    "DELETE",
    "/api/CortexFileHandler?hash=abc123"
  );

  // Should be 404 or 500 depending on GCS availability
  t.true(status === 404 || status === 500);

  if (origBucket !== undefined) {
    process.env.GCS_BUCKETNAME = origBucket;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});

// ─── DELETE with JSON body ───────────────────────────────────────────────────

test.serial("DELETE with hash in JSON body", async (t) => {
  const origBucket = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "test-bucket-nonexistent";

  const { status } = await request("DELETE", "/api/CortexFileHandler", {
    body: { hash: "abc123", contextId: "user1" },
  });

  t.true(status === 404 || status === 500);

  if (origBucket !== undefined) {
    process.env.GCS_BUCKETNAME = origBucket;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});

// ─── GET: listFolder request ─────────────────────────────────────────────────

test.serial("GET listFolder returns error without GCS", async (t) => {
  const origBucket = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "test-bucket-nonexistent";

  try {
    const { status } = await request(
      "GET",
      "/api/CortexFileHandler?operation=listFolder&userId=user1&fileScope=global"
    );

    // Without real GCS, expect 500 (no creds) or 200 (emulator/ADC)
    t.true(status === 200 || status === 500);
  } catch (err) {
    // Connection reset is acceptable when no GCS is configured
    t.true(err.code === "ECONNRESET" || err.code === "ECONNREFUSED");
  }

  if (origBucket !== undefined) {
    process.env.GCS_BUCKETNAME = origBucket;
  } else {
    delete process.env.GCS_BUCKETNAME;
  }
});
