// sys_tool_workspace_status.js
// Get system status of the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: {
        type: "function",
        icon: "📊",
        function: {
            name: "WorkspaceStatus",
            description: "Get system status of your workspace container. Returns uptime, disk usage, memory usage, CPU load, running processes, and background job status.",
            parameters: {
                type: "object",
                properties: {
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
        const { entityId } = args;

        try {
            const result = await workspaceRequest(entityId, '/status', null, {
                method: 'GET',
                timeoutMs: 15000,
            });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceStatus" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceStatus error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceStatus" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
