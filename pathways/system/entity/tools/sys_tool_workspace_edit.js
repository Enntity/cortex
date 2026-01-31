// sys_tool_workspace_edit.js
// Search-and-replace in files in the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: {
        type: "function",
        icon: "✏️",
        toolCost: 1,
        function: {
            name: "WorkspaceEdit",
            description: "Edit a file in your workspace container using exact search-and-replace. Finds the exact oldString in the file and replaces it with newString. Use replaceAll to replace all occurrences.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute path to the file to edit (e.g. /workspace/src/app.js)"
                    },
                    oldString: {
                        type: "string",
                        description: "The exact string to find in the file"
                    },
                    newString: {
                        type: "string",
                        description: "The replacement string"
                    },
                    replaceAll: {
                        type: "boolean",
                        description: "If true, replace all occurrences. Default false (first occurrence only)."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["path", "oldString", "newString", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { path, oldString, newString, replaceAll, entityId } = args;

        try {
            if (!path || typeof path !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceEdit" });
                return JSON.stringify({ success: false, error: "path is required" });
            }
            if (!oldString || typeof oldString !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceEdit" });
                return JSON.stringify({ success: false, error: "oldString is required" });
            }
            if (newString === undefined || newString === null) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceEdit" });
                return JSON.stringify({ success: false, error: "newString is required" });
            }

            const body = { path, oldString, newString };
            if (replaceAll !== undefined) body.replaceAll = replaceAll;

            const result = await workspaceRequest(entityId, '/edit', body, { timeoutMs: 30000 });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceEdit" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceEdit error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceEdit" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
