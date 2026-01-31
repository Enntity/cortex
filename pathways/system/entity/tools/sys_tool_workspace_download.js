// sys_tool_workspace_download.js
// Download a file from cloud storage into the entity's workspace container
import logger from '../../../../lib/logger.js';
import { axios } from '../../../../lib/requestExecutor.js';
import { resolveFileParameter } from '../../../../lib/fileUtils.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 120,
    toolDefinition: {
        type: "function",
        icon: "📥",
        toolCost: 1,
        function: {
            name: "WorkspaceDownload",
            description: "Download a file from your file collection into your workspace container. Resolves a file reference (ID, filename, or hash) to its cloud URL, downloads it, and writes it to the specified workspace path.",
            parameters: {
                type: "object",
                properties: {
                    file: {
                        type: "string",
                        description: "The file to download: file ID, filename, URL, or hash from your file collection."
                    },
                    workspacePath: {
                        type: "string",
                        description: "Absolute path where the file should be saved in the workspace (e.g. /workspace/data/input.csv)"
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["file", "workspacePath", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { file, workspacePath, entityId } = args;

        try {
            if (!file || typeof file !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
                return JSON.stringify({ success: false, error: "file is required" });
            }
            if (!workspacePath || typeof workspacePath !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
                return JSON.stringify({ success: false, error: "workspacePath is required" });
            }

            // Resolve file reference to cloud URL
            if (!args.agentContext || !Array.isArray(args.agentContext) || args.agentContext.length === 0) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
                return JSON.stringify({
                    success: false,
                    error: "agentContext is required when using the 'file' parameter. Use FileCollection to find available files."
                });
            }

            const cloudUrl = await resolveFileParameter(file, args.agentContext);
            if (!cloudUrl) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
                return JSON.stringify({
                    success: false,
                    error: `File not found: "${file}". Use FileCollection to find available files.`
                });
            }

            // Download file content
            const response = await axios.get(cloudUrl, {
                responseType: 'arraybuffer',
                timeout: 60000,
                validateStatus: (status) => status >= 200 && status < 400,
            });

            if (!response.data) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
                return JSON.stringify({ success: false, error: 'Failed to download file from cloud storage' });
            }

            // Base64-encode and write to workspace
            const b64Content = Buffer.from(response.data).toString('base64');

            const writeResult = await workspaceRequest(entityId, '/write', {
                path: workspacePath,
                content: b64Content,
                encoding: 'base64',
                createDirs: true,
            }, { timeoutMs: 60000 });

            if (!writeResult.success) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
                return JSON.stringify({ success: false, error: writeResult.error || 'Failed to write file to workspace' });
            }

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
            return JSON.stringify({
                success: true,
                workspacePath,
                bytesWritten: writeResult.bytesWritten || response.data.length,
            });
        } catch (e) {
            logger.error(`WorkspaceDownload error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceDownload" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
