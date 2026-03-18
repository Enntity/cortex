// sys_read_file_collection.js
// GraphQL pathway for reading file collections from GCS
// Returns file listing as JSON array string

import { listFilesForContext, getDefaultContext } from '../../../../lib/fileUtils.js';

export default {
    inputParameters: {
        agentContext: [
            { contextId: ``, contextKey: ``, default: true }
        ],
        useCache: true
    },
    // No format field - returns String directly (like sys_read_memory)
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {
        let { agentContext } = args;
        
        // Backward compatibility: if contextId is provided without agentContext, create agentContext
        if ((!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) && args.contextId) {
            agentContext = [{ 
                contextId: args.contextId, 
                contextKey: args.contextKey || null, 
                default: true 
            }];
        }
        
        // Validate that agentContext is provided
        if (!agentContext || !Array.isArray(agentContext) || agentContext.length === 0) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }
        
        try {
            const ctx = getDefaultContext(agentContext);
            if (!ctx) return "[]";
            const files = await listFilesForContext(ctx.contextId, { fileScope: 'all' });
            return JSON.stringify(files);
        } catch (e) {
            // Log error for debugging
            const logger = (await import('../../../../lib/logger.js')).default;
            logger.warn(`Error loading file collection: ${e.message}`);
            // Return empty array on error for backward compatibility
            return "[]";
        }
    }
}

