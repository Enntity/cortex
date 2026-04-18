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

test.serial("non-test mode requires cortex api key", async (t) => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKey = process.env.CORTEX_API_KEY;

  process.env.NODE_ENV = "development";
  process.env.CORTEX_API_KEY = "secret-1";

  const unauthorized = await request("GET", "/api/CortexFileHandler");
  t.is(unauthorized.status, 401);

  const authorized = await request("GET", "/api/CortexFileHandler", {
    headers: {
      authorization: "Bearer secret-1",
    },
  });
  t.is(authorized.status, 400);

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalApiKey === undefined) {
    delete process.env.CORTEX_API_KEY;
  } else {
    process.env.CORTEX_API_KEY = originalApiKey;
  }
});

// ─── GET: missing params ─────────────────────────────────────────────────────

test("GET without params returns 400", async (t) => {
  const { status, data } = await request("GET", "/api/CortexFileHandler");
  t.is(status, 400);
  t.truthy(data.error);
});

// ─── GET: signUrl without url returns 400 ────────────────────────────────────

test("GET signUrl without url returns 400", async (t) => {
  const { status, data } = await request("GET", "/api/CortexFileHandler?operation=signUrl");
  t.is(status, 400);
  t.truthy(data.error);
});

// ─── DELETE: missing params returns 400 ──────────────────────────────────────

test("DELETE without filename or prefix returns 400", async (t) => {
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

test("POST rename without filename returns 400", async (t) => {
  const { status, data } = await request("POST", "/api/CortexFileHandler?operation=rename", {
    body: { newFilename: "test.txt" },
  });
  t.is(status, 400);
  t.truthy(data.error);
  t.regex(data.error, /filename/i);
});

test("POST rename without newFilename returns 400", async (t) => {
  const { status, data } = await request("POST", "/api/CortexFileHandler?operation=rename", {
    body: { filename: "old.txt" },
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

// ─── GET: signUrl without blobPath returns 400 ──────────────────────────────

test("GET signUrl without blobPath returns error", async (t) => {
  const { status, data } = await request(
    "GET",
    "/api/CortexFileHandler?operation=signUrl&url=https://example.com/file.txt"
  );
  t.is(status, 400);
  t.truthy(data.error);
});

test("GET fetch blocks localhost targets", async (t) => {
  const { status, data } = await request(
    "GET",
    "/api/CortexFileHandler?fetch=http://localhost/test.txt&contextId=user1&fileScope=global"
  );
  t.is(status, 403);
  t.truthy(data.error);
});

// ─── DELETE: with filename but no GCS ────────────────────────────────────────

test.serial("DELETE with filename but no GCS configured returns error", async (t) => {
  const origBucket = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "test-bucket-nonexistent";

  const { status } = await request(
    "DELETE",
    "/api/CortexFileHandler?filename=abc.txt&contextId=user1&fileScope=global"
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

test.serial("DELETE with filename in JSON body", async (t) => {
  const origBucket = process.env.GCS_BUCKETNAME;
  process.env.GCS_BUCKETNAME = "test-bucket-nonexistent";

  const { status } = await request("DELETE", "/api/CortexFileHandler", {
    body: { filename: "abc.txt", contextId: "user1", fileScope: "global" },
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

test.serial("GET listFolder rejects requests without user context", async (t) => {
  const { status, data } = await request(
    "GET",
    "/api/CortexFileHandler?operation=listFolder&fileScope=all"
  );

  t.is(status, 400);
  t.is(data.error, "userId or contextId is required for listFolder");
});
