import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execSync as shellExecSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { requireAuth, setSecret } from './lib/auth.js';
import { execSync, execBackground, getResult, listBackgroundJobs } from './lib/shell.js';
import { readFile, writeFile, editFile, browseDir } from './lib/files.js';
import { getStatus, resetWorkspace, createBackup, restoreBackup } from './lib/system.js';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Validate that a file path resolves under /workspace or /tmp.
 * Prevents path traversal attacks (e.g. reading /etc/shadow).
 */
function requireSafePath(filePath) {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith('/workspace') || resolved.startsWith('/tmp')) {
        return resolved;
    }
    return null;
}

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);

// Wrap async route handlers so Express 4 catches rejections
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.use(express.json({ limit: '10mb' }));

// --- Unauthenticated ---

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version });
});

// --- Authenticated routes ---

app.use(requireAuth);

// Shell execution
app.post('/shell', wrap(async (req, res) => {
    const { command, cwd, timeout, background, processId } = req.body;

    if (processId) {
        return res.json(getResult(processId));
    }

    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'command is required' });
    }

    if (background) {
        return res.json(execBackground(command, { cwd, timeout }));
    }

    const result = await execSync(command, { cwd, timeout });
    res.json(result);
}));

// Poll background process result
app.get('/shell/result/:processId', (req, res) => {
    res.json(getResult(req.params.processId));
});

// List all background processes
app.get('/shell/jobs', (_req, res) => {
    res.json(listBackgroundJobs());
});

// Read file
app.post('/read', wrap(async (req, res) => {
    const { path: reqPath, startLine, endLine, encoding } = req.body;
    if (!reqPath || typeof reqPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    const safePath = requireSafePath(reqPath);
    if (!safePath) {
        return res.status(403).json({ error: 'Path must be under /workspace or /tmp' });
    }
    res.json(await readFile(safePath, { startLine, endLine, encoding }));
}));

// Write file
app.post('/write', wrap(async (req, res) => {
    const { path: reqPath, content, encoding, createDirs } = req.body;
    if (!reqPath || typeof reqPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    const safePath = requireSafePath(reqPath);
    if (!safePath) {
        return res.status(403).json({ error: 'Path must be under /workspace or /tmp' });
    }
    if (content === undefined || content === null) {
        return res.status(400).json({ error: 'content is required' });
    }
    res.json(await writeFile(safePath, content, { encoding, createDirs }));
}));

// Edit file (search-and-replace)
app.post('/edit', wrap(async (req, res) => {
    const { path: reqPath, oldString, newString, replaceAll } = req.body;
    if (!reqPath || typeof reqPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    const safePath = requireSafePath(reqPath);
    if (!safePath) {
        return res.status(403).json({ error: 'Path must be under /workspace or /tmp' });
    }
    if (!oldString || typeof oldString !== 'string') {
        return res.status(400).json({ error: 'oldString is required' });
    }
    if (newString === undefined || newString === null) {
        return res.status(400).json({ error: 'newString is required' });
    }
    res.json(await editFile(safePath, oldString, newString, { replaceAll }));
}));

// Browse directory
app.post('/browse', wrap(async (req, res) => {
    const { path: dirPath, recursive, maxDepth } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    const safePath = requireSafePath(dirPath);
    if (!safePath) {
        return res.status(403).json({ error: 'Path must be under /workspace or /tmp' });
    }
    res.json(await browseDir(safePath, { recursive, maxDepth }));
}));

// System status
app.get('/status', wrap(async (_req, res) => {
    res.json(await getStatus());
}));

// Create backup tarball of /workspace
app.post('/backup', wrap(async (_req, res) => {
    res.json(await createBackup());
}));

// Restore workspace from a tarball
app.post('/restore', wrap(async (req, res) => {
    const { archivePath } = req.body;
    if (!archivePath || typeof archivePath !== 'string') {
        return res.status(400).json({ error: 'archivePath is required' });
    }
    res.json(await restoreBackup(archivePath));
}));

// Reset workspace
app.post('/reset', wrap(async (req, res) => {
    res.json(await resetWorkspace(req.body.preservePaths));
}));

// Stream-download a file from the container
app.get('/download', wrap(async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path query parameter is required' });
    }
    const safePath = requireSafePath(filePath);
    if (!safePath) {
        return res.status(403).json({ error: 'Path must be under /workspace or /tmp' });
    }

    let stat;
    try {
        stat = await fs.promises.stat(safePath);
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: `File not found: ${safePath}` });
        if (err.code === 'EACCES') return res.status(403).json({ error: `Permission denied: ${safePath}` });
        throw err;
    }

    if (!stat.isFile()) {
        return res.status(400).json({ error: `Not a file: ${safePath}` });
    }

    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(safePath);
    await pipeline(stream, res);
}));

// Stream-upload a file into the container
app.post('/upload', wrap(async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path query parameter is required' });
    }
    const safePath = requireSafePath(filePath);
    if (!safePath) {
        return res.status(403).json({ error: 'Path must be under /workspace or /tmp' });
    }

    // Ensure parent directory exists
    await fs.promises.mkdir(path.dirname(safePath), { recursive: true });

    const ws = fs.createWriteStream(safePath);
    await pipeline(req, ws);

    const stat = await fs.promises.stat(safePath);
    res.json({ path: safePath, bytesWritten: stat.size });
}));

// Reconfigure — rotates secret, injects env vars at runtime.
// Used by the warm pool: a pool container starts "clean" and gets reconfigured
// when claimed by a specific entity.
app.post('/reconfigure', wrap(async (req, res) => {
    const { secret, env } = req.body;

    // 1. Inject environment variables (optional)
    if (env && typeof env === 'object') {
        const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const envContent = Object.entries(env)
            .filter(([k]) => SAFE_KEY.test(k))
            .map(([k, v]) => {
                const escaped = String(v).replace(/'/g, "'\\''");
                return `export ${k}='${escaped}'`;
            })
            .join('\n') + '\n';

        fs.writeFileSync('/workspace/.env', envContent);

        // Ensure .bashrc sources .env
        const sourceLine = '[ -f /workspace/.env ] && . /workspace/.env';
        const bashrcPath = path.join(process.env.HOME || '/root', '.bashrc');
        try {
            const bashrc = fs.existsSync(bashrcPath) ? fs.readFileSync(bashrcPath, 'utf8') : '';
            if (!bashrc.includes(sourceLine)) {
                fs.appendFileSync(bashrcPath, '\n' + sourceLine + '\n');
            }
        } catch {
            // Best-effort
        }
    }

    // 2. Mount GCS bucket via gcsfuse (optional)
    if (req.body.gcsMount) {
        const { bucket, serviceAccountKey, onlyDir } = req.body.gcsMount;

        if (!bucket || !serviceAccountKey) {
            return res.status(400).json({ error: 'gcsMount requires bucket and serviceAccountKey' });
        }

        // Write service account key to temp file (NOT in /workspace — excluded from backups)
        const keyPath = '/tmp/gcs-sa-key.json';
        fs.writeFileSync(keyPath, typeof serviceAccountKey === 'string'
            ? serviceAccountKey
            : JSON.stringify(serviceAccountKey));

        // Ensure cache and mount directories exist
        fs.mkdirSync('/tmp/gcsfuse-cache', { recursive: true });
        fs.mkdirSync('/workspace/files', { recursive: true });

        // Unmount any existing gcsfuse mount (idempotent reconfigure)
        try {
            shellExecSync('fusermount -u /workspace/files 2>/dev/null || true', { timeout: 10000 });
        } catch {
            // Not mounted, that's fine
        }

        // Build gcsfuse command
        const args = [
            '--implicit-dirs',
            '--metadata-cache-ttl-secs', '60',
            '--file-cache-max-size-mb', '512',
            '--cache-dir', '/tmp/gcsfuse-cache',
            '--key-file', keyPath,
        ];
        if (onlyDir) {
            args.push('--only-dir', onlyDir);
        }
        args.push(bucket, '/workspace/files');

        try {
            shellExecSync(`gcsfuse ${args.join(' ')}`, { stdio: 'pipe', timeout: 30000 });
        } catch (e) {
            return res.status(500).json({ error: `gcsfuse mount failed: ${e.stderr?.toString() || e.message}` });
        }
    }

    // 3. Rotate secret (done LAST so caller can retry with old secret if step 1 fails)
    if (secret && typeof secret === 'string') {
        setSecret(secret);
    }

    res.json({ success: true });
}));

// Global error handler — async rejections now route here via wrap()
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Workspace client listening on port ${PORT}`);
});
