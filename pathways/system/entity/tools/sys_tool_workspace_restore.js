// sys_tool_workspace_restore.js
// Restore the entity's workspace from a cloud backup
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { resolveFileParameter } from '../../../../lib/fileUtils.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: {
        type: "function",
        icon: "⏪",
        function: {
            name: "WorkspaceRestore",
            description: "Restore your workspace from a previously created backup. Downloads the backup archive from cloud storage and extracts it into /workspace, restoring all files. Existing files with the same names will be overwritten. Use FileCollection to find available backups (tagged 'workspace-backup').",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "The backup file to restore from: file ID, filename, or hash from your file collection. Look for files tagged 'workspace-backup'."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["file", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { file, entityId } = args;

        try {
            if (!file || typeof file !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
                return JSON.stringify({ success: false, error: "file is required" });
            }

            // 1. Resolve file reference to cloud URL
            if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
                return JSON.stringify({
                    success: false,
                    error: "agentContext is required. Use FileCollection to find available backups."
                });
            }

            const cloudUrl = await resolveFileParameter(file, args.agentContext);
            if (!cloudUrl) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
                return JSON.stringify({
                    success: false,
                    error: `Backup not found: "${file}". Use FileCollection to find available backups (tagged 'workspace-backup').`
                });
            }

            // 2. Download from cloud storage
            const response = await axios.get(cloudUrl, {
                responseType: 'arraybuffer',
                timeout: 120000,
                validateStatus: (status) => status >= 200 && status < 400,
            });

            if (!response.data) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
                return JSON.stringify({ success: false, error: 'Failed to download backup from cloud storage' });
            }

            // 3. Write tarball to workspace container
            const b64Content = Buffer.from(response.data).toString('base64');
            const archivePath = '/tmp/workspace-restore.tar.gz';

            const writeResult = await workspaceRequest(entityId, '/write', {
                path: archivePath,
                content: b64Content,
                encoding: 'base64',
            }, { timeoutMs: 120000 });

            if (!writeResult.success) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
                return JSON.stringify({ success: false, error: writeResult.error || 'Failed to write backup to workspace' });
            }

            // 4. Extract archive
            const restoreResult = await workspaceRequest(entityId, '/restore', {
                archivePath,
            }, { timeoutMs: 120000 });

            // 5. Clean up temp file
            await workspaceRequest(entityId, '/shell', {
                command: `rm -f "${archivePath}"`,
            }, { timeoutMs: 10000 }).catch(() => {});

            if (!restoreResult.success) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
                return JSON.stringify({ success: false, error: restoreResult.error || 'Failed to extract backup' });
            }

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
            return JSON.stringify({
                success: true,
                message: 'Workspace restored from backup',
                bytesRestored: response.data.length,
            });
        } catch (e) {
            logger.error(`WorkspaceRestore error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRestore" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
