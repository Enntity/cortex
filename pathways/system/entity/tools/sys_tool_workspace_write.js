// sys_tool_workspace_write.js
// Write or create files in the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: {
        type: "function",
        icon: "✍️",
        toolCost: 1,
        function: {
            name: "WorkspaceWrite",
            description: "Write or create a file in your workspace container. Creates parent directories by default. Supports base64 encoding for binary content. Files are written to the container's filesystem.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute path for the file (e.g. /workspace/src/index.js)"
                    },
                    content: {
                        type: "string",
                        description: "The file content to write"
                    },
                    encoding: {
                        type: "string",
                        description: "Set to 'base64' for binary content. Default is utf8 text."
                    },
                    createDirs: {
                        type: "boolean",
                        description: "Create parent directories if they don't exist. Default true."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["path", "content", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { path, content, encoding, createDirs, entityId } = args;

        try {
            if (!path || typeof path !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceWrite" });
                return JSON.stringify({ success: false, error: "path is required" });
            }
            if (content === undefined || content === null) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceWrite" });
                return JSON.stringify({ success: false, error: "content is required" });
            }

            const body = { path, content };
            if (encoding) body.encoding = encoding;
            if (createDirs !== undefined) body.createDirs = createDirs;

            const result = await workspaceRequest(entityId, '/write', body, { timeoutMs: 30000 });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceWrite" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceWrite error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceWrite" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
