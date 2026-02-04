import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import { getContinuityMemoryService } from '../../../lib/continuity/index.js';

export default {
    prompt: [],
    inputParameters: {
        entityId: ``,
        agentContext: [{ contextId: '', contextKey: '', default: true }],
    },
    timeout: 15,
    json: true,
    useInputChunking: false,
    enableDuplicateRequests: false,

    executePathway: async ({ args }) => {
        const entityConfig = await loadEntityConfig(args.entityId);

        let continuityContext = '';
        const useMemory = entityConfig?.useMemory !== false;

        if (useMemory && args.agentContext?.length) {
            try {
                const memoryService = getContinuityMemoryService();
                if (memoryService.isAvailable()) {
                    continuityContext = await memoryService.getContextWindow({
                        entityId: args.entityId,
                        userId: args.agentContext[0].contextId,
                        options: { episodicLimit: 10, topicMemoryLimit: 5 },
                    });
                }
            } catch (error) {
                console.warn(`[sys_entity_session_context] Memory fetch failed: ${error.message}`);
            }
        }

        return JSON.stringify({
            entityName: entityConfig?.name || args.entityId,
            identity: entityConfig?.identity || entityConfig?.instructions || '',
            continuityContext: continuityContext || '',
            useMemory,
        });
    },
};
