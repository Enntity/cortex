import express from 'express';
import { requireAuth } from './lib/auth.js';
import { execSync, execBackground, getResult } from './lib/shell.js';
import { readFile, writeFile, editFile, browseDir } from './lib/files.js';
import { getStatus, resetWorkspace, createBackup, restoreBackup } from './lib/system.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);

// Wrap async route handlers so Express 4 catches rejections
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.use(express.json({ limit: '10mb' }));

// --- Unauthenticated ---

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
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

// Read file
app.post('/read', wrap(async (req, res) => {
    const { path, startLine, endLine, encoding } = req.body;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    res.json(await readFile(path, { startLine, endLine, encoding }));
}));

// Write file
app.post('/write', wrap(async (req, res) => {
    const { path, content, encoding, createDirs } = req.body;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    if (content === undefined || content === null) {
        return res.status(400).json({ error: 'content is required' });
    }
    res.json(await writeFile(path, content, { encoding, createDirs }));
}));

// Edit file (search-and-replace)
app.post('/edit', wrap(async (req, res) => {
    const { path, oldString, newString, replaceAll } = req.body;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    if (!oldString || typeof oldString !== 'string') {
        return res.status(400).json({ error: 'oldString is required' });
    }
    if (newString === undefined || newString === null) {
        return res.status(400).json({ error: 'newString is required' });
    }
    res.json(await editFile(path, oldString, newString, { replaceAll }));
}));

// Browse directory
app.post('/browse', wrap(async (req, res) => {
    const { path: dirPath, recursive, maxDepth } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    res.json(await browseDir(dirPath, { recursive, maxDepth }));
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

// Global error handler — async rejections now route here via wrap()
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Workspace client listening on port ${PORT}`);
});
