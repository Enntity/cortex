// sys_tool_workspace_ssh.js
// Consolidated workspace tool — one shell interface replaces 14 individual tools.
// Built-in pseudo-commands: files push/pull/backup/restore, bg, poll, reset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../../../../lib/logger.js';
import { workspaceRequest, destroyWorkspace, workspaceDownloadToFile, workspaceUploadFile } from './shared/workspace_client.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { uploadFileToCloud, addFileToCollection, findFileInCollection, loadFileCollection, getMimeTypeFromFilename } from '../../../../lib/fileUtils.js';
import { axios } from '../../../../lib/requestExecutor.js';

/**
 * Simple quoted-string-aware tokenizer.
 * Splits on whitespace, but respects single and double quotes.
 * Returns array of tokens with quotes stripped.
 */
export function tokenize(input) {
    const tokens = [];
    let current = '';
    let inQuote = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === ' ' || ch === '\t') {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }

    if (current) tokens.push(current);
    return tokens;
}

/** Normalize a path so relative paths resolve under /workspace/ (matching shell cwd). */
export function toAbsWorkspacePath(p) {
    return p.startsWith('/') ? p : `/workspace/${p}`;
}

// --- Handlers ---

async function handleShell(command, args, resolver) {
    const { entityId } = args;
    const timeoutMs = 130000; // 125s effective + 5s buffer
    const result = await workspaceRequest(entityId, '/shell', { command }, { timeoutMs });

    return JSON.stringify(result);
}

async function handleBg(rawBgCommand, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, '/shell', {
        command: rawBgCommand,
        background: true,
    }, { timeoutMs: 15000 });

    return JSON.stringify(result);
}

async function handlePoll(processId, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, `/shell/result/${encodeURIComponent(processId)}`, null, {
        method: 'GET',
        timeoutMs: 10000,
    });

    return JSON.stringify(result);
}

/** Push a single file from workspace to cloud storage + file collection. (used by files push) */
async function pushOneFile(absPath, displayName, entityId, contextId, contextKey, chatId, resolver) {
    const readResult = await workspaceRequest(entityId, '/read', {
        path: absPath,
        encoding: 'base64',
    }, { timeoutMs: 60000 });

    if (!readResult.success) {
        return { success: false, filename: displayName, error: readResult.error || 'Failed to read file' };
    }

    const buffer = Buffer.from(readResult.content, 'base64');
    const mimeType = getMimeTypeFromFilename(displayName);

    const uploadResult = await uploadFileToCloud(buffer, mimeType, displayName, resolver, contextId);
    if (!uploadResult || !uploadResult.url) {
        return { success: false, filename: displayName, error: 'Failed to upload to cloud storage' };
    }

    const fileEntry = await addFileToCollection(
        contextId,
        contextKey || '',
        uploadResult.url,
        uploadResult.gcs || null,
        displayName,
        [],
        '',
        uploadResult.hash || null,
        null,
        resolver,
        true,
        chatId || null,
        entityId || null
    );

    return {
        success: true,
        filename: displayName,
        fileId: fileEntry?.id || null,
        url: uploadResult.url,
        hash: uploadResult.hash || null,
    };
}

const GLOB_CHARS = /[*?[\]]/;

async function handleFilesPush(tokens, args, resolver) {
    // files push <workspacePath|glob> [displayName]
    const { entityId, contextId, contextKey, chatId } = args;
    const workspacePath = tokens[2];
    if (!workspacePath) {

        return JSON.stringify({ success: false, error: 'Usage: files push <workspacePath|glob> [displayName]' });
    }

    // If path contains glob characters, expand via shell and push each match
    if (GLOB_CHARS.test(workspacePath)) {
        const absPattern = toAbsWorkspacePath(workspacePath);
        const expandResult = await workspaceRequest(entityId, '/shell', {
            command: `ls -1d ${absPattern} 2>/dev/null`,
        }, { timeoutMs: 10000 });

        const files = (expandResult.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (files.length === 0) {
    
            return JSON.stringify({ success: false, error: `No files matched: ${workspacePath}` });
        }

        const results = [];
        for (const filePath of files) {
            const name = filePath.split('/').pop();
            results.push(await pushOneFile(filePath, name, entityId, contextId, contextKey, chatId, resolver));
        }


        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        return JSON.stringify({
            success: failed.length === 0,
            pushed: succeeded.length,
            failed: failed.length,
            files: results,
        });
    }

    // Single file push
    const absPath = toAbsWorkspacePath(workspacePath);
    const displayName = tokens[3] || workspacePath.split('/').pop();
    const result = await pushOneFile(absPath, displayName, entityId, contextId, contextKey, chatId, resolver);


    return JSON.stringify(result);
}

async function handleFilesPull(tokens, args, resolver) {
    // files pull <fileRef> [destPath]
    const { entityId, contextId, contextKey } = args;
    const fileRef = tokens[2];
    if (!fileRef) {

        return JSON.stringify({ success: false, error: 'Usage: files pull <fileRef> [destPath]' });
    }

    const agentContext = args.agentContext;
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {

        return JSON.stringify({
            success: false,
            error: 'agentContext is required for files pull. Use FileCollection to find available files.',
        });
    }

    // Find file in collection (gets URL + displayFilename in one lookup)
    const collection = await loadFileCollection(agentContext);
    const foundFile = findFileInCollection(fileRef, collection);
    if (!foundFile) {

        return JSON.stringify({
            success: false,
            error: `File not found: "${fileRef}". Use FileCollection to find available files.`,
        });
    }

    const cloudUrl = foundFile.url;
    if (!cloudUrl) {

        return JSON.stringify({ success: false, error: `No URL available for file "${foundFile.displayFilename || fileRef}"` });
    }

    // Default dest: /workspace/<displayFilename>; normalize relative paths
    let destPath = tokens[3] ? toAbsWorkspacePath(tokens[3]) : `/workspace/${foundFile.displayFilename || fileRef}`;

    // Handle directory destinations (mirrors Unix cp behavior)
    if (tokens[3]) {
        const filename = foundFile.displayFilename || fileRef;
        if (tokens[3].endsWith('/')) {
            // Trailing slash: always treat as directory, append filename
            destPath = destPath.endsWith('/') ? destPath + filename : destPath + '/' + filename;
        } else {
            // No trailing slash: probe if dest is an existing directory
            const probeResult = await workspaceRequest(entityId, '/shell', {
                command: `test -d "${destPath}" && echo DIR`,
            }, { timeoutMs: 10000 });
            if (probeResult.success && (probeResult.stdout || '').trim() === 'DIR') {
                destPath = destPath + '/' + filename;
            }
        }
    }

    // Download file content
    const response = await axios.get(cloudUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    if (!response.data) {

        return JSON.stringify({ success: false, error: 'Failed to download file from cloud storage' });
    }

    // Base64-encode and write to workspace
    const b64Content = Buffer.from(response.data).toString('base64');
    const writeResult = await workspaceRequest(entityId, '/write', {
        path: destPath,
        content: b64Content,
        encoding: 'base64',
        createDirs: true,
    }, { timeoutMs: 60000 });

    if (!writeResult.success) {

        return JSON.stringify({ success: false, error: writeResult.error || 'Failed to write file to workspace' });
    }


    return JSON.stringify({
        success: true,
        file: foundFile.displayFilename || fileRef,
        workspacePath: destPath,
        bytesWritten: writeResult.bytesWritten || response.data.length,
    });
}

async function handleFilesBackup(tokens, args, resolver) {
    // files backup [notes...]
    const { entityId, contextId, contextKey, chatId } = args;
    const notes = tokens.slice(2).join(' ') || null;

    // 1. Create tarball inside workspace container
    const backupResult = await workspaceRequest(entityId, '/backup', {}, { timeoutMs: 120000 });
    if (!backupResult.success || backupResult.error) {
        return JSON.stringify({ success: false, error: backupResult.error || 'Failed to create backup archive' });
    }

    // 2. Stream tarball from container to Cortex temp file
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-backup-'));
    const tempFile = path.join(tempDir, `backup-${backupResult.timestamp}.tar.gz`);

    try {
        const dlResult = await workspaceDownloadToFile(entityId, backupResult.path, tempFile);
        if (!dlResult.success) {
            return JSON.stringify({ success: false, error: dlResult.error || 'Failed to download backup archive' });
        }

        // 3. Upload to cloud storage
        const buffer = fs.readFileSync(tempFile);
        const filename = `workspace-backup-${backupResult.timestamp}.tar.gz`;
        const uploadResult = await uploadFileToCloud(buffer, 'application/gzip', filename, resolver, contextId);

        if (!uploadResult || !uploadResult.url) {
            return JSON.stringify({ success: false, error: 'Failed to upload backup to cloud storage' });
        }

        // 4. Add to file collection
        const fileEntry = await addFileToCollection(
            contextId,
            contextKey || '',
            uploadResult.url,
            uploadResult.gcs || null,
            filename,
            ['workspace-backup'],
            notes || `Workspace backup created at ${backupResult.timestamp}`,
            uploadResult.hash || null,
            null,
            resolver,
            true,
            chatId || null,
            entityId || null
        );

        return JSON.stringify({
            success: true,
            filename,
            fileId: fileEntry?.id || null,
            url: uploadResult.url,
            hash: uploadResult.hash || null,
            sizeMB: backupResult.sizeMB,
            timestamp: backupResult.timestamp,
        });
    } finally {
        // Clean up: remove tarball from container + Cortex temp dir
        await workspaceRequest(entityId, '/shell', {
            command: `rm -f "${backupResult.path}"`,
        }, { timeoutMs: 10000 }).catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function handleFilesRestore(tokens, args, resolver) {
    // files restore <fileRef>
    const { entityId } = args;
    const fileRef = tokens[2];
    if (!fileRef) {
        return JSON.stringify({ success: false, error: 'Usage: files restore <backupRef>' });
    }

    const agentContext = args.agentContext;
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        return JSON.stringify({
            success: false,
            error: "agentContext is required. Use FileCollection to find available backups (tagged 'workspace-backup').",
        });
    }

    // Find backup file in collection
    const collection = await loadFileCollection(agentContext);
    const foundFile = findFileInCollection(fileRef, collection);
    if (!foundFile) {
        return JSON.stringify({
            success: false,
            error: `Backup not found: "${fileRef}". Use FileCollection to find available backups (tagged 'workspace-backup').`,
        });
    }

    const cloudUrl = foundFile.url;
    if (!cloudUrl) {
        return JSON.stringify({ success: false, error: `No URL available for backup "${foundFile.displayFilename || fileRef}"` });
    }

    // Stream download from cloud → Cortex temp file → stream upload to container
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-restore-'));
    const tempFile = path.join(tempDir, 'restore.tar.gz');
    const archivePath = '/tmp/workspace-restore.tar.gz';

    try {
        // 1. Stream cloud backup to Cortex temp file
        const response = await axios.get(cloudUrl, {
            responseType: 'stream',
            timeout: 300000,
            validateStatus: (status) => status >= 200 && status < 400,
        });

        await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(tempFile);
            response.data.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
            response.data.on('error', reject);
        });

        // 2. Stream temp file to container
        const ulResult = await workspaceUploadFile(entityId, tempFile, archivePath);
        if (!ulResult.success) {
            return JSON.stringify({ success: false, error: ulResult.error || 'Failed to upload backup to workspace' });
        }

        // 3. Extract archive in container
        const restoreResult = await workspaceRequest(entityId, '/restore', {
            archivePath,
        }, { timeoutMs: 120000 });

        if (!restoreResult.success) {
            return JSON.stringify({ success: false, error: restoreResult.error || 'Failed to extract backup' });
        }

        const stat = fs.statSync(tempFile);
        return JSON.stringify({
            success: true,
            message: 'Workspace restored from backup',
            bytesRestored: stat.size,
        });
    } finally {
        // Clean up: remove tarball from container + Cortex temp dir
        await workspaceRequest(entityId, '/shell', {
            command: `rm -f "${archivePath}"`,
        }, { timeoutMs: 10000 }).catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function handleReset(tokens, args, resolver) {
    // reset [--preserve <paths>] [--destroy] [--destroy-volume]
    const { entityId } = args;
    let destroy = false;
    let destroyVolume = false;
    const preservePaths = [];

    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--destroy') {
            destroy = true;
        } else if (token === '--destroy-volume') {
            destroyVolume = true;
            destroy = true; // implies destroy
        } else if (token === '--preserve') {
            // Collect all following non-flag tokens as preserve paths
            i++;
            while (i < tokens.length && !tokens[i].startsWith('--')) {
                preservePaths.push(tokens[i]);
                i++;
            }
            i--; // back up so outer loop increments correctly
        }
    }

    // Full container destruction
    if (destroy) {
        const entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig) {
    
            return JSON.stringify({ success: false, error: 'Entity not found' });
        }

        const result = await destroyWorkspace(entityId, entityConfig, { destroyVolume });

        return JSON.stringify(result);
    }

    // Soft reset: wipe /workspace contents
    const body = {};
    if (preservePaths.length > 0) {
        body.preservePaths = preservePaths;
    }

    const result = await workspaceRequest(entityId, '/reset', body, { timeoutMs: 60000 });

    return JSON.stringify(result);
}

// --- Command routing ---

/**
 * Route a command string to the appropriate handler.
 * Returns [handler, ...handlerArgs] or null if it's a plain shell command.
 */
function routeCommand(command) {
    const tokens = tokenize(command);
    if (tokens.length === 0) return null;

    const first = tokens[0].toLowerCase();

    if ((first === 'files' || first === 'scp') && tokens.length >= 2) {
        const sub = tokens[1].toLowerCase();
        switch (sub) {
            case 'push':    return { handler: handleFilesPush, tokens };
            case 'pull':    return { handler: handleFilesPull, tokens };
            case 'backup':  return { handler: handleFilesBackup, tokens };
            case 'restore': return { handler: handleFilesRestore, tokens };
            // Any other subcommand (e.g. scp user@host:/path) falls through to shell
        }
    }

    if (first === 'bg') {
        // Preserve raw command after "bg " to avoid re-tokenizing quoted args
        const rawBgCommand = command.replace(/^\s*bg\s+/, '');
        return { handler: handleBg, rawBgCommand };
    }

    if (first === 'poll') {
        const processId = tokens[1];
        if (!processId) return null; // let it fall to shell (will error naturally)
        return { handler: handlePoll, processId };
    }

    if (first === 'reset') {
        return { handler: handleReset, tokens };
    }

    return null; // plain shell command
}

// --- Tool definition and entry point ---

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: {
        type: 'function',
        icon: '💻',
        toolCost: 1,
        function: {
            name: 'WorkspaceSSH',
            description: `Execute commands in your workspace — a persistent Linux container (cwd: /workspace). Built-in commands:
• files push <path|glob> [name] — upload file(s) to your file collection. Supports globs: files push *.jpg
• files pull <fileRef> [dest] — download from file collection to workspace
• files backup [notes] / files restore <ref> — snapshot or restore entire workspace
• bg <cmd> — run in background, returns processId. poll <id> — check result
• reset [--preserve .env] — wipe workspace contents
Everything else runs as bash. Both relative and absolute paths work.`,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Shell command or built-in (e.g. "ls -la", "files push output/*.pdf")',
                    },
                    userMessage: {
                        type: 'string',
                        description: 'Brief display message',
                    },
                },
                required: ['command', 'userMessage'],
            },
        },
    },

    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { command } = args;
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });

        try {
            if (!command || typeof command !== 'string') {
                return JSON.stringify({ success: false, error: 'command is required' });
            }

            const route = routeCommand(command);

            if (!route) {
                // Plain shell command
                return handleShell(command, args, resolver);
            }

            if (route.handler === handleBg) {
                return route.handler(route.rawBgCommand, args, resolver);
            }

            if (route.handler === handlePoll) {
                return route.handler(route.processId, args, resolver);
            }

            // files and reset handlers receive tokens
            return route.handler(route.tokens, args, resolver);
        } catch (e) {
            logger.error(`WorkspaceSSH error: ${e.message}`);
    
            return JSON.stringify({ success: false, error: e.message });
        }
    },
};
