// sys_tool_workspace_browse.js
// Browse directory contents in the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 60,
    toolDefinition: {
        type: "function",
        icon: "📂",
        function: {
            name: "WorkspaceBrowse",
            description: "List directory contents in your workspace container. Returns file names, types, sizes, and modification dates. Supports recursive listing with configurable depth.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute path to the directory to browse (e.g. /workspace)"
                    },
                    recursive: {
                        type: "boolean",
                        description: "If true, list subdirectory contents recursively. Default false."
                    },
                    maxDepth: {
                        type: "number",
                        description: "Maximum recursion depth when recursive is true. Default 3."
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
        const { path, recursive, maxDepth, entityId } = args;

        try {
            if (!path || typeof path !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBrowse" });
                return JSON.stringify({ success: false, error: "path is required" });
            }

            const body = { path };
            if (recursive !== undefined) body.recursive = recursive;
            if (maxDepth !== undefined) body.maxDepth = maxDepth;

            const result = await workspaceRequest(entityId, '/browse', body, { timeoutMs: 30000 });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBrowse" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceBrowse error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceBrowse" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
