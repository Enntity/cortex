// sys_tool_workspace_read.js
// Read file contents from the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: {
        type: "function",
        icon: "📖",
        toolCost: 1,
        function: {
            name: "WorkspaceRead",
            description: "Read file contents from your workspace container. Supports line ranges for large files and base64 encoding for binary files. Files are read from the container's filesystem (default root: /workspace).",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute path to the file in the workspace container (e.g. /workspace/src/app.js)"
                    },
                    startLine: {
                        type: "number",
                        description: "Starting line number (1-indexed). If not provided, reads from the beginning."
                    },
                    endLine: {
                        type: "number",
                        description: "Ending line number (1-indexed, inclusive). If not provided, reads to end (max 1000 lines)."
                    },
                    encoding: {
                        type: "string",
                        description: "Set to 'base64' for binary files. Default is utf8 text."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["path", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { path, startLine, endLine, encoding, entityId } = args;

        try {
            if (!path || typeof path !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRead" });
                return JSON.stringify({ success: false, error: "path is required" });
            }

            const body = { path };
            if (startLine !== undefined) body.startLine = startLine;
            if (endLine !== undefined) body.endLine = endLine;
            if (encoding) body.encoding = encoding;

            const result = await workspaceRequest(entityId, '/read', body, { timeoutMs: 30000 });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRead" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceRead error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceRead" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
