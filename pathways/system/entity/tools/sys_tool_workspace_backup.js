// sys_tool_workspace_backup.js
// Backup the entity's workspace to cloud storage
import logger from '../../../../lib/logger.js';
import { uploadFileToCloud, addFileToCollection } from '../../../../lib/fileUtils.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: {
        type: "function",
        icon: "💾",
        function: {
            name: "WorkspaceBackup",
            description: "Create a backup of your entire workspace and save it to cloud storage. The backup is a compressed archive of everything in /workspace. Use this before risky operations or periodically to protect your work. Backups are stored in your file collection and can be restored with WorkspaceRestore.",
            parameters: {
                type: "object",
                properties: {
                    notes: {
                        type: "string",
                        description: "Optional description of what this backup contains or why it was created"
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { notes, entityId, contextId, contextKey, chatId } = args;

        try {
            // 1. Create tarball inside the workspace container
            const backupResult = await workspaceRequest(entityId, '/backup', {}, { timeoutMs: 120000 });

            if (!backupResult.success || backupResult.error) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBackup" });
                return JSON.stringify({ success: false, error: backupResult.error || 'Failed to create backup archive' });
            }

            // 2. Read the tarball as base64
            const readResult = await workspaceRequest(entityId, '/read', {
                path: backupResult.path,
                encoding: 'base64',
            }, { timeoutMs: 120000 });

            if (!readResult.success) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBackup" });
                return JSON.stringify({ success: false, error: readResult.error || 'Failed to read backup archive' });
            }

            // 3. Upload to cloud storage
            const buffer = Buffer.from(readResult.content, 'base64');
            const filename = `workspace-backup-${backupResult.timestamp}.tar.gz`;

            const uploadResult = await uploadFileToCloud(buffer, 'application/gzip', filename, resolver, contextId);

            if (!uploadResult || !uploadResult.url) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBackup" });
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
                true, // permanent
                chatId || null,
                entityId || null
            );

            // 5. Clean up temp file in container
            await workspaceRequest(entityId, '/shell', {
                command: `rm -f "${backupResult.path}"`,
            }, { timeoutMs: 10000 }).catch(() => {});

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBackup" });
            return JSON.stringify({
                success: true,
                filename,
                fileId: fileEntry?.id || null,
                url: uploadResult.url,
                hash: uploadResult.hash || null,
                sizeMB: backupResult.sizeMB,
                timestamp: backupResult.timestamp,
            });
        } catch (e) {
            logger.error(`WorkspaceBackup error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBackup" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
