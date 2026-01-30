// sys_tool_workspace_shell.js
// Execute shell commands in the entity's workspace container
import logger from '../../../../lib/logger.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: {
        type: "function",
        icon: "💻",
        function: {
            name: "WorkspaceShell",
            description: "Execute a shell command in your workspace container. Supports sync execution (waits for result), background execution (returns immediately with a processId to poll later), and polling a background process result. Use background mode for long-running commands. The workspace is a full Linux environment where you can install software, run builds, manage services, etc.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The shell command to execute (bash). Supports pipes, redirects, and multi-command chains."
                    },
                    cwd: {
                        type: "string",
                        description: "Working directory for the command. Defaults to /workspace."
                    },
                    timeout: {
                        type: "number",
                        description: "Timeout in milliseconds. Default 110000 (110s), max 300000 (300s)."
                    },
                    background: {
                        type: "boolean",
                        description: "If true, start the command in background and return a processId immediately. Use WorkspaceShell with processId to poll for results."
                    },
                    processId: {
                        type: "string",
                        description: "Poll a previously started background process for its result. If provided, command is ignored."
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
        const { command, cwd, timeout, background, processId, entityId } = args;

        try {
            // Poll existing background process
            if (processId) {
                const result = await workspaceRequest(entityId, `/shell/result/${processId}`, null, {
                    method: 'GET',
                    timeoutMs: 10000,
                });
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceShell" });
                return JSON.stringify(result);
            }

            if (!command || typeof command !== 'string') {
                resolver.tool = JSON.stringify({ toolUsed: "WorkspaceShell" });
                return JSON.stringify({ success: false, error: "command is required" });
            }

            const body = { command };
            if (cwd) body.cwd = cwd;
            if (timeout) body.timeout = timeout;
            if (background) body.background = true;

            const timeoutMs = background ? 15000 : Math.min((timeout || 110000) + 5000, 305000);

            const result = await workspaceRequest(entityId, '/shell', body, { timeoutMs });

            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceShell" });
            return JSON.stringify(result);
        } catch (e) {
            logger.error(`WorkspaceShell error: ${e.message}`);
            resolver.tool = JSON.stringify({ toolUsed: "WorkspaceShell" });
            return JSON.stringify({ success: false, error: e.message });
        }
    }
};
