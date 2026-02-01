// sys_tool_workspace_ssh.js
// Consolidated workspace tool — one shell interface replaces 14 individual tools.
// Built-in pseudo-commands: scp push/pull/backup/restore, bg, poll, reset.
import logger from '../../../../lib/logger.js';
import { workspaceRequest, destroyWorkspace } from './shared/workspace_client.js';
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
    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify(result);
}

async function handleBg(rawBgCommand, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, '/shell', {
        command: rawBgCommand,
        background: true,
    }, { timeoutMs: 15000 });
    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify(result);
}

async function handlePoll(processId, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, `/shell/result/${encodeURIComponent(processId)}`, null, {
        method: 'GET',
        timeoutMs: 10000,
    });
    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify(result);
}

/** Push a single file from workspace to cloud storage + file collection. */
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

async function handleScpPush(tokens, args, resolver) {
    // scp push <workspacePath|glob> [displayName]
    const { entityId, contextId, contextKey, chatId } = args;
    const workspacePath = tokens[2];
    if (!workspacePath) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: 'Usage: scp push <workspacePath|glob> [displayName]' });
    }

    // If path contains glob characters, expand via shell and push each match
    if (GLOB_CHARS.test(workspacePath)) {
        const absPattern = toAbsWorkspacePath(workspacePath);
        const expandResult = await workspaceRequest(entityId, '/shell', {
            command: `ls -1d ${absPattern} 2>/dev/null`,
        }, { timeoutMs: 10000 });

        const files = (expandResult.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (files.length === 0) {
            resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
            return JSON.stringify({ success: false, error: `No files matched: ${workspacePath}` });
        }

        const results = [];
        for (const filePath of files) {
            const name = filePath.split('/').pop();
            results.push(await pushOneFile(filePath, name, entityId, contextId, contextKey, chatId, resolver));
        }

        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
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

    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify(result);
}

async function handleScpPull(tokens, args, resolver) {
    // scp pull <fileRef> [destPath]
    const { entityId, contextId, contextKey } = args;
    const fileRef = tokens[2];
    if (!fileRef) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: 'Usage: scp pull <fileRef> [destPath]' });
    }

    const agentContext = args.agentContext;
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({
            success: false,
            error: 'agentContext is required for scp pull. Use FileCollection to find available files.',
        });
    }

    // Find file in collection (gets URL + displayFilename in one lookup)
    const collection = await loadFileCollection(agentContext);
    const foundFile = findFileInCollection(fileRef, collection);
    if (!foundFile) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({
            success: false,
            error: `File not found: "${fileRef}". Use FileCollection to find available files.`,
        });
    }

    const cloudUrl = foundFile.url;
    if (!cloudUrl) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: `No URL available for file "${foundFile.displayFilename || fileRef}"` });
    }

    // Default dest: /workspace/<displayFilename>; normalize relative paths
    const destPath = tokens[3] ? toAbsWorkspacePath(tokens[3]) : `/workspace/${foundFile.displayFilename || fileRef}`;

    // Download file content
    const response = await axios.get(cloudUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    if (!response.data) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
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
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: writeResult.error || 'Failed to write file to workspace' });
    }

    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify({
        success: true,
        file: foundFile.displayFilename || fileRef,
        workspacePath: destPath,
        bytesWritten: writeResult.bytesWritten || response.data.length,
    });
}

async function handleScpBackup(tokens, args, resolver) {
    // scp backup [notes...]
    const { entityId, contextId, contextKey, chatId } = args;
    const notes = tokens.slice(2).join(' ') || null;

    // 1. Create tarball inside workspace container
    const backupResult = await workspaceRequest(entityId, '/backup', {}, { timeoutMs: 120000 });
    if (!backupResult.success || backupResult.error) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: backupResult.error || 'Failed to create backup archive' });
    }

    // 2. Read the tarball as base64
    const readResult = await workspaceRequest(entityId, '/read', {
        path: backupResult.path,
        encoding: 'base64',
    }, { timeoutMs: 120000 });

    if (!readResult.success) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: readResult.error || 'Failed to read backup archive' });
    }

    // 3. Upload to cloud storage
    const buffer = Buffer.from(readResult.content, 'base64');
    const filename = `workspace-backup-${backupResult.timestamp}.tar.gz`;
    const uploadResult = await uploadFileToCloud(buffer, 'application/gzip', filename, resolver, contextId);

    if (!uploadResult || !uploadResult.url) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
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

    // 5. Clean up temp file in container
    await workspaceRequest(entityId, '/shell', {
        command: `rm -f "${backupResult.path}"`,
    }, { timeoutMs: 10000 }).catch(() => {});

    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify({
        success: true,
        filename,
        fileId: fileEntry?.id || null,
        url: uploadResult.url,
        hash: uploadResult.hash || null,
        sizeMB: backupResult.sizeMB,
        timestamp: backupResult.timestamp,
    });
}

async function handleScpRestore(tokens, args, resolver) {
    // scp restore <fileRef>
    const { entityId } = args;
    const fileRef = tokens[2];
    if (!fileRef) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: 'Usage: scp restore <backupRef>' });
    }

    const agentContext = args.agentContext;
    if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({
            success: false,
            error: "agentContext is required. Use FileCollection to find available backups (tagged 'workspace-backup').",
        });
    }

    // Find backup file in collection
    const collection = await loadFileCollection(agentContext);
    const foundFile = findFileInCollection(fileRef, collection);
    if (!foundFile) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({
            success: false,
            error: `Backup not found: "${fileRef}". Use FileCollection to find available backups (tagged 'workspace-backup').`,
        });
    }

    const cloudUrl = foundFile.url;
    if (!cloudUrl) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: `No URL available for backup "${foundFile.displayFilename || fileRef}"` });
    }

    // Download backup from cloud storage
    const response = await axios.get(cloudUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    if (!response.data) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: 'Failed to download backup from cloud storage' });
    }

    // Write tarball to workspace container
    const b64Content = Buffer.from(response.data).toString('base64');
    const archivePath = '/tmp/workspace-restore.tar.gz';

    const writeResult = await workspaceRequest(entityId, '/write', {
        path: archivePath,
        content: b64Content,
        encoding: 'base64',
    }, { timeoutMs: 120000 });

    if (!writeResult.success) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: writeResult.error || 'Failed to write backup to workspace' });
    }

    // Extract archive
    const restoreResult = await workspaceRequest(entityId, '/restore', {
        archivePath,
    }, { timeoutMs: 120000 });

    // Clean up temp file
    await workspaceRequest(entityId, '/shell', {
        command: `rm -f "${archivePath}"`,
    }, { timeoutMs: 10000 }).catch(() => {});

    if (!restoreResult.success) {
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify({ success: false, error: restoreResult.error || 'Failed to extract backup' });
    }

    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
    return JSON.stringify({
        success: true,
        message: 'Workspace restored from backup',
        bytesRestored: response.data.length,
    });
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
            resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
            return JSON.stringify({ success: false, error: 'Entity not found' });
        }

        const result = await destroyWorkspace(entityId, entityConfig, { destroyVolume });
        resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
        return JSON.stringify(result);
    }

    // Soft reset: wipe /workspace contents
    const body = {};
    if (preservePaths.length > 0) {
        body.preservePaths = preservePaths;
    }

    const result = await workspaceRequest(entityId, '/reset', body, { timeoutMs: 60000 });
    resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
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

    if (first === 'scp' && tokens.length >= 2) {
        const sub = tokens[1].toLowerCase();
        switch (sub) {
            case 'push':    return { handler: handleScpPush, tokens };
            case 'pull':    return { handler: handleScpPull, tokens };
            case 'backup':  return { handler: handleScpBackup, tokens };
            case 'restore': return { handler: handleScpRestore, tokens };
            // Any other scp subcommand (e.g. scp user@host:/path) falls through to shell
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
• scp push <path|glob> [name] — upload file(s) to your file collection. Supports globs: scp push *.jpg
• scp pull <fileRef> [dest] — download from file collection to workspace
• scp backup [notes] / scp restore <ref> — snapshot or restore entire workspace
• bg <cmd> — run in background, returns processId. poll <id> — check result
• reset [--preserve .env] — wipe workspace contents
Everything else runs as bash. Both relative and absolute paths work.`,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Shell command or built-in (e.g. "ls -la", "scp push output/*.pdf")',
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

        try {
            if (!command || typeof command !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
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

            // scp and reset handlers receive tokens
            return route.handler(route.tokens, args, resolver);
        } catch (e) {
            logger.error(`WorkspaceSSH error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: 'WorkspaceSSH' });
            return JSON.stringify({ success: false, error: e.message });
        }
    },
};
