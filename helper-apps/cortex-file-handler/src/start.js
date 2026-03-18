import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import handler from "./handler.js";

const app = express();
const port = process.env.PORT || 7071;

// Get version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
const version = packageJson.version;

// Parse JSON bodies (for DELETE/PUT with JSON body)
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy", version });
});

// Main endpoint
app.all("/api/CortexFileHandler", handler);

// Legacy alias
app.all("/api/MediaFileChunker", handler);

// Only start the server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(port, () => {
    console.log(`Cortex File Handler v${version} (GCS-only) running on port ${port}`);
  });
}

export { app, port };
