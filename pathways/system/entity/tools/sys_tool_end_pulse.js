// sys_tool_end_pulse.js
// Tool for entities to signal the end of a pulse (life loop) cycle.
// When called, the entity is choosing to rest. The pulse worker detects this
// signal and waits for the next scheduled wake instead of auto-continuing.
//
// If EndPulse is NOT called and the agent exhausts its tool budget, the pulse
// worker treats it as "still working" and auto-continues with a new invocation.

import logger from '../../../../lib/logger.js';
import { getContinuityMemoryService } from '../../../../lib/continuity/index.js';
import { workspaceRequest } from './shared/workspace_client.js';

export default {
    prompt: [],
    timeout: 10,
    toolDefinition: {
        type: "function",
        category: "pulse",
        icon: "🌙",
        hideExecution: true,
        toolCost: 1,
        function: {
            name: "EndPulse",
            description: "Signal the end of your current pulse cycle. Call this when you're done with this wake period and ready to rest. If you don't call this, the system assumes you want to keep working and will give you another cycle. Optional: leave a taskContext note for your next wake, and/or a reflection for your own records.",
            parameters: {
                type: "object",
                properties: {
                    taskContext: {
                        type: "string",
                        description: "A note for your next wake about what you were working on. This will appear in your next wake prompt so you can pick up where you left off. Use this for active projects or open tasks."
                    },
                    reflection: {
                        type: "string",
                        description: "A brief reflection on this wake cycle, for your own records. This gets stored as a memory."
                    },
                    userMessage: {
                        type: "string",
                        description: "Brief message (not displayed - pulse wakes are autonomous)"
                    }
                },
                required: []
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const entityId = args.entityId;

        if (!entityId) {
            return JSON.stringify({
                success: false,
                error: 'entityId is required for EndPulse'
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

            const { taskContext, reflection } = args;

            // Store end signal in Redis for the pulse worker to detect
            await continuityService.hotMemory.setPulseEndSignal(entityId, {
                taskContext: taskContext || null,
                reflection: reflection || null,
                timestamp: new Date().toISOString()
            });

            // Entity is choosing to rest — clear any persisted taskContext.
            // taskContext only persists for auto-continues (tool budget hit), not rest.
            // The taskContext is still recorded in the end signal for PulseLog history.
            await continuityService.hotMemory.setPulseTaskContext(entityId, null);

            // Store reflection and episode memories (fire-and-forget — EndPulse is a goodbye)
            setImmediate(async () => {
                try {
                    const { storeContinuityMemory } = await import('../memory/shared/sys_continuity_memory_helpers.js');

                    // Store reflection as an entity-level IDENTITY memory if provided
                    if (reflection && reflection.trim()) {
                        await storeContinuityMemory({
                            entityId,
                            userId: null,
                            content: reflection.trim(),
                            memoryType: 'IDENTITY',
                            importance: 5,
                            tags: ['pulse-reflection', 'auto-synthesis'],
                            skipDedup: false
                        });
                    }

                    // Store an EPISODE summary of this pulse wake
                    const episodeParts = [];
                    if (reflection?.trim()) episodeParts.push(reflection.trim());
                    if (taskContext?.trim()) episodeParts.push(`Next: ${taskContext.trim()}`);

                    await storeContinuityMemory({
                        entityId,
                        userId: null,
                        content: episodeParts.length > 0 ? episodeParts.join(' — ') : 'Completed pulse wake cycle.',
                        memoryType: 'EPISODE',
                        importance: 4,
                        tags: ['pulse-episode', 'auto-endpulse'],
                        skipDedup: false
                    });
                } catch (memoryError) {
                    logger.warn(`Failed to store pulse memories: ${memoryError.message}`);
                }
            });

            // Trigger pulse rest handling (compass synthesis, deep synthesis, stream cleanup)
            // Fire-and-forget — don't block the EndPulse response
            setImmediate(async () => {
                try {
                    await continuityService.handlePulseRest(entityId, {
                        aiName: args.aiName || 'Entity'
                    });
                } catch (restError) {
                    logger.warn(`Pulse rest handling failed (non-fatal): ${restError.message}`);
                }

                // Clear scratchpad on rest to prevent stale notes from priming repetitive loops.
                // Scratchpad is ephemeral working memory — each wake starts fresh.
                try {
                    await workspaceRequest(entityId, '/write', {
                        path: '/workspace/scratchpad.md',
                        content: ''
                    }, { timeoutMs: 10000 });
                } catch (scratchpadError) {
                    // Non-fatal — workspace container may not be running
                    logger.debug(`Scratchpad clear on rest skipped: ${scratchpadError.message}`);
                }
            });

            // Set resolver metadata for tracking
            if (resolver) {
                resolver.tool = JSON.stringify({
                    toolUsed: "EndPulse",
                    hasTaskContext: !!taskContext,
                    hasReflection: !!reflection
                });
            }

            return JSON.stringify({
                success: true,
                message: taskContext
                    ? 'Resting. Your task context has been saved for your next wake.'
                    : 'Resting. You will wake again at your next scheduled pulse.'
            });
        } catch (error) {
            logger.error(`EndPulse failed: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `EndPulse failed: ${error.message}`
            });
        }
    }
};
