// sys_tool_workspace_reset.js
// Reset or destroy the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest, destroyWorkspace } from './shared/workspace_client.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';

export default {
    prompt: [],
    timeout: 120,
    toolDefinition: {
        type: "function",
        icon: "🔄",
        toolCost: 1,
        function: {
            name: "WorkspaceReset",
            description: "Reset your workspace to a clean state. By default, wipes all files in /workspace except optionally preserved paths. With destroy=true, stops and removes the entire container (it will be auto-reprovisioned on next use). The persistent volume is preserved by default so data survives re-provisioning.",
            parameters: {
                type: "object",
                properties: {
                    confirm: {
                        type: "boolean",
                        description: "Must be true to confirm the reset. Safety check to prevent accidental resets."
                    },
                    preservePaths: {
                        type: "array",
                        items: { type: "string" },
                        description: "File or directory names to preserve during reset (e.g. [\".env\", \"data\"]). Only applies when destroy is false."
                    },
                    destroy: {
                        type: "boolean",
                        description: "If true, stop and remove the entire container instead of just wiping files. Container will be auto-reprovisioned on next workspace tool use. Default false."
                    },
                    destroyVolume: {
                        type: "boolean",
                        description: "If true (and destroy is true), also delete the persistent volume. Data will NOT survive re-provisioning. Default false."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message to display while this action runs"
                    }
                },
                required: ["confirm", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { confirm, preservePaths, destroy, destroyVolume, entityId } = args;

        try {
            if (confirm !== true) {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceReset" });
                return JSON.stringify({
                    success: false,
                    error: "confirm must be true to proceed with workspace reset"
                });
            }

            // Full container destruction
            if (destroy) {
                const entityConfig = await loadEntityConfig(entityId);
                if (!entityConfig) {
                    resolver.tool = JSON.stringify({ toolUsed: "WorkspaceReset" });
                    return JSON.stringify({ success: false, error: "Entity not found" });
                }

                const result = await destroyWorkspace(entityId, entityConfig, { destroyVolume: destroyVolume || false });
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceReset" });
                return JSON.stringify(result);
            }

            // Soft reset: wipe /workspace contents
            const body = {};
            if (preservePaths && Array.isArray(preservePaths)) {
                body.preservePaths = preservePaths;
            }

            const result = await workspaceRequest(entityId, '/reset', body, { timeoutMs: 60000 });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceReset" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceReset error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceReset" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
