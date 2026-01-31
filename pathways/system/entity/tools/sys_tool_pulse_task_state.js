// sys_tool_pulse_task_state.js
// Tool for entities to read/write persistent task state across pulse cycles.
// This is the entity's structured workbench - detailed operational state for
// multi-wake projects (e.g., files modified, test results, step checklists).
//
// Distinct from EndPulse's taskContext (a lightweight prompt breadcrumb),
// PulseTaskState is a structured JSON object the entity manages explicitly.

import logger from '../../../../lib/logger.js';
import { getContinuityMemoryService } from '../../../../lib/continuity/index.js';

export default {
    prompt: [],
    timeout: 10,
    toolDefinition: {
        type: "function",
        icon: "📋",
        hideExecution: true,
        toolCost: 1,
        function: {
            name: "PulseTaskState",
            description: "Read, write, or clear your persistent task state. This structured state persists across pulse cycles (up to 24 hours) and is meant for tracking detailed progress on multi-cycle projects. Use 'read' to see your current state, 'write' to update it, 'clear' to remove it.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["read", "write", "clear"],
                        description: "The action to perform on your task state"
                    },
                    state: {
                        type: "object",
                        description: "The task state to persist (for 'write' action). Can contain any structured data: goals, progress, file lists, test results, next steps, etc."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message (not displayed - pulse wakes are autonomous)"
                    }
                },
                required: ["action"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const entityId = args.entityId;

        if (!entityId) {
            return JSON.stringify({
                success: false,
                error: 'entityId is required for PulseTaskState'
            });
        }

        try {
            const continuityService = getContinuityMemoryService();

            if (!continuityService.isAvailable()) {
                return JSON.stringify({
                    success: false,
                    error: 'Continuity memory service is not available'
                });
            }

            const { action, state } = args;

            switch (action) {
                case 'read': {
                    const taskState = await continuityService.hotMemory.getPulseTaskState(entityId);
                    if (resolver) {
                        resolver.tool = JSON.stringify({ toolUsed: "PulseTaskState", action: "read" });
                    }
                    return JSON.stringify({
                        success: true,
                        hasState: !!taskState,
                        state: taskState || null,
                        message: taskState
                            ? 'Your current task state is loaded.'
                            : 'No task state found. You can write one with action "write".'
                    });
                }

                case 'write': {
                    if (!state || typeof state !== 'object') {
                        return JSON.stringify({
                            success: false,
                            error: 'state parameter is required for write action and must be an object'
                        });
                    }

                    // Add metadata
                    const stateWithMeta = {
                        ...state,
                        _lastUpdated: new Date().toISOString()
                    };

                    await continuityService.hotMemory.setPulseTaskState(entityId, stateWithMeta);
                    if (resolver) {
                        resolver.tool = JSON.stringify({ toolUsed: "PulseTaskState", action: "write" });
                    }
                    return JSON.stringify({
                        success: true,
                        message: 'Task state saved. It will persist across pulse cycles for up to 24 hours.'
                    });
                }

                case 'clear': {
                    await continuityService.hotMemory.clearPulseTaskState(entityId);
                    if (resolver) {
                        resolver.tool = JSON.stringify({ toolUsed: "PulseTaskState", action: "clear" });
                    }
                    return JSON.stringify({
                        success: true,
                        message: 'Task state cleared.'
                    });
                }

                default:
                    return JSON.stringify({
                        success: false,
                        error: `Unknown action: ${action}. Use 'read', 'write', or 'clear'.`
                    });
            }
        } catch (error) {
            logger.error(`PulseTaskState failed: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `PulseTaskState failed: ${error.message}`
            });
        }
    }
};
