// sys_tool_workspace_ssh.js
// Consolidated workspace tool — one shell interface replaces 14 individual tools.
// Built-in pseudo-commands: files backup/restore, bg, poll, jobs, reset.
// /workspace/files/ is auto-synced to GCS via gcsfuse — no push/pull needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../../../../lib/logger.js';
import { workspaceRequest, destroyWorkspace, workspaceDownloadToFile, workspaceUploadFile } from './shared/workspace_client.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { uploadFileToCloud, listFilesForContext, findFileInCollection, getSignedFileUrl, loadFileCollection } from '../../../../lib/fileUtils.js';
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

/**
 * Extract the last non-empty, non-hint line from stderr — usually the actual
 * error message (e.g. "ModuleNotFoundError: No module named 'sympy'").
 */
function lastMeaningfulLine(stderr) {
    if (!stderr) return null;
    const lines = stderr.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('hint:') && !l.startsWith('note:'));
    return lines[lines.length - 1] || null;
}

// --- Handlers ---

async function handleShell(command, args, resolver) {
    const { entityId, timeoutSeconds } = args;
    const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : 300000; // default 5 min
    const result = await workspaceRequest(entityId, '/shell', { command }, { timeoutMs });

    if (!result.success && !result.error) {
        result.error = lastMeaningfulLine(result.stderr)
            || `Command failed (exit code ${result.exitCode})`;
    }

    // Hint when a failed command looks like it tried to use bg/poll as bash commands
    if (!result.success && /\bbg\s+|poll\s+[0-9a-f]/i.test(command)) {
        result.hint = '`bg` and `poll` are built-in commands of this tool, not bash commands. They must be the entire command string — e.g. command: "bg python train.py", not inside scripts or chained with && or ;.';
    }

    // Auto-detect files created in /workspace/files/ and return signed URLs
    // so the user can see/download them directly.
    if (result.success && result.stdout) {
        try {
            const fileRefs = result.stdout.match(/\/workspace\/files\/\S+/g);
            if (fileRefs && fileRefs.length > 0) {
                const entityConfig = await loadEntityConfig(entityId);
                const userId = entityConfig?.assocUserIds?.[0];
                if (userId) {
                    const collection = await listFilesForContext(userId, { limit: 100 });
                    if (collection.length > 0) {
                        const displayLinks = [];
                        for (const ref of fileRefs.slice(0, 10)) { // cap at 10
                            const basename = path.basename(ref);
                            const match = findFileInCollection(basename, collection);
                            if (match?.url) {
                                displayLinks.push(`[${basename}](${match.url})`);
                            }
                        }
                        if (displayLinks.length > 0) {
                            result.displayMarkdown = displayLinks.join('\n');
                        }
                    }
                }
            }
        } catch (e) {
            // Best-effort — don't fail the command over URL resolution
            logger.warn(`Failed to resolve file URLs from shell output: ${e.message}`);
        }
    }

    return JSON.stringify(result);
}

async function handleBg(rawBgCommand, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, '/shell', {
        command: rawBgCommand,
        background: true,
    }, { timeoutMs: 15000 });

    if (!result.success && !result.error) {
        result.error = lastMeaningfulLine(result.stderr)
            || `Command failed (exit code ${result.exitCode})`;
    }

    return JSON.stringify(result);
}

async function handlePoll(processId, args, resolver) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, `/shell/result/${encodeURIComponent(processId)}`, null, {
        method: 'GET',
        timeoutMs: 10000,
    });

    if (!result.success && !result.error) {
        result.error = lastMeaningfulLine(result.stderr)
            || `Command failed (exit code ${result.exitCode})`;
    }

    return JSON.stringify(result);
}

async function handleJobs(args) {
    const { entityId } = args;
    const result = await workspaceRequest(entityId, '/shell/jobs', null, {
        method: 'GET',
        timeoutMs: 10000,
    });

    return JSON.stringify(result);
}

async function handleFilesBackup(tokens, args, resolver) {
    // files backup [notes...]
    const { entityId, contextId } = args;
    const notes = tokens.slice(2).join(' ') || null;

    // 1. Create tarball inside workspace container
    const backupResult = await workspaceRequest(entityId, '/backup', {}, { timeoutMs: 300000 });
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
        const uploadResult = await uploadFileToCloud(buffer, 'application/gzip', filename, resolver, contextId, args.chatId || null);

        if (!uploadResult || !uploadResult.url) {
            return JSON.stringify({ success: false, error: 'Failed to upload backup to cloud storage' });
        }

        return JSON.stringify({
            success: true,
            filename,
            url: uploadResult.url,
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
            error: "agentContext is required. Check your available files or browse /workspace/files/ for backups.",
        });
    }

    // Find backup file in collection
    const collection = await loadFileCollection(agentContext);
    const foundFile = findFileInCollection(fileRef, collection);
    if (!foundFile) {
        return JSON.stringify({
            success: false,
            error: `Backup not found: "${fileRef}". Check your available files or browse /workspace/files/ for backups.`,
        });
    }

    const cloudUrl = foundFile.blobPath
        ? await getSignedFileUrl(foundFile.blobPath, 60) || foundFile.url
        : foundFile.url;
    if (!cloudUrl) {
        return JSON.stringify({ success: false, error: `No URL available for backup "${foundFile.displayFilename || fileRef}"` });
    }

    // Stream download from cloud -> Cortex temp file -> stream upload to container
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
        }, { timeoutMs: 300000 });

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

    if (first === 'jobs') {
        return { handler: handleJobs };
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
• files backup [notes] / files restore <ref> — snapshot or restore entire workspace
• bg <cmd> — run in background, returns processId. poll <id> — check result. jobs — list all background processes
• reset [--preserve .env] — wipe workspace contents
Everything else runs as bash. Both relative and absolute paths work.

/workspace/files/ is auto-synced cloud storage (GCS via gcsfuse). Files written there are automatically available via signed URLs. No manual push/pull needed.

IMPORTANT: bg, poll, jobs, and reset are built-in commands — they must be the ENTIRE command string. Do not chain them with && or embed in scripts.`,
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
                    icon: {
                        type: 'string',
                        description: 'Emoji icon for this action (e.g. "🐍" for Python, "📦" for package install). Defaults to 💻.',
                    },
                    timeoutSeconds: {
                        type: 'number',
                        description: 'Optional timeout in seconds for long-running commands. Defaults to 300 (5 min).',
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

            if (route.handler === handleJobs) {
                return route.handler(args);
            }

            // files and reset handlers receive tokens
            return route.handler(route.tokens, args, resolver);
        } catch (e) {
            logger.error(`WorkspaceSSH error: ${e.message}`);

            return JSON.stringify({ success: false, error: e.message });
        }
    },
};
