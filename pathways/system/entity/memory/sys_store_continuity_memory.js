/**
 * Store Continuity Memory Mutation
 * 
 * GraphQL mutation that allows clients to directly store memories in the 
 * Continuity Architecture for a specific entity and user.
 * 
 * This is the client-facing counterpart to sys_tool_store_continuity_memory,
 * which is used by agents. Both use the same core logic via storeContinuityMemory.
 * 
 * Use cases:
 * - Client apps storing user preferences or context
 * - Importing memories from external sources
 * - Administrative memory management
 * - Seeding entity memories during onboarding
 */

import { storeContinuityMemory, VALID_MEMORY_TYPES, VALID_EMOTIONAL_VALENCES } from './shared/sys_continuity_memory_helpers.js';
import logger from '../../../../lib/logger.js';

export default {
    inputParameters: {
        entityId: ``,          // Entity UUID (required)
        userId: ``,            // User/context identifier (required)
        content: ``,           // The memory content (required)
        memoryType: ``,        // Memory type: ANCHOR, ARTIFACT, IDENTITY, CORE, etc. (required)
        importance: { type: 'integer', default: 5 },  // 1-10
        tags: { type: 'array', items: { type: 'string' }, default: [] },  // Optional tags
        emotionalValence: ``,  // Optional emotional context
        emotionalIntensity: { type: 'number', default: 0.5 },  // 0-1
        skipDedup: { type: 'boolean', default: false }  // Skip deduplication
    },
    
    isMutation: true, // Expose as GraphQL Mutation
    
    resolver: async (_parent, args, _contextValue, _info) => {
        const { 
            entityId,
            userId,
            content,
            memoryType,
            importance = 5,
            tags = [],
            emotionalValence,
            emotionalIntensity = 0.5,
            skipDedup = false
        } = args;
        
        try {
            // Call the shared helper
            const result = await storeContinuityMemory({
                entityId,
                userId,
                content,
                memoryType,
                importance,
                tags: Array.isArray(tags) ? tags : [],
                emotionalValence,
                emotionalIntensity,
                skipDedup
            });
            
            if (result.success) {
                logger.info(`[Mutation] Stored continuity memory for entity ${entityId}, user ${userId}: ${memoryType}`);
            } else {
                logger.warn(`[Mutation] Failed to store continuity memory: ${result.error}`);
            }
            
            return JSON.stringify(result);
            
        } catch (error) {
            logger.error(`[Mutation] Error storing continuity memory: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `Failed to store memory: ${error.message}`
            });
        }
    }
};
