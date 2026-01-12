/**
 * Continuity Memory Helpers
 * 
 * Shared logic for storing memories in the Continuity Architecture.
 * Used by both the agent tool (sys_tool_store_continuity_memory) and
 * the GraphQL mutation (sys_store_continuity_memory).
 */

import { getContinuityMemoryService, ContinuityMemoryType, EmotionalValence } from '../../../../../lib/continuity/index.js';
import logger from '../../../../../lib/logger.js';

// Map string type names to enum values
export const MEMORY_TYPE_MAP = {
    'ANCHOR': ContinuityMemoryType.ANCHOR,
    'ARTIFACT': ContinuityMemoryType.ARTIFACT,
    'IDENTITY': ContinuityMemoryType.IDENTITY,
    'CORE': ContinuityMemoryType.CORE,
    'EPISODE': ContinuityMemoryType.EPISODE,
    'EXPRESSION': ContinuityMemoryType.EXPRESSION,
    'VALUE': ContinuityMemoryType.VALUE,
    'CAPABILITY': ContinuityMemoryType.CAPABILITY
};

// Map string emotional valence names to enum values
export const EMOTIONAL_VALENCE_MAP = {
    // Primary states
    'joy': EmotionalValence.JOY,
    'curiosity': EmotionalValence.CURIOSITY,
    'concern': EmotionalValence.CONCERN,
    'grief': EmotionalValence.GRIEF,
    'frustration': EmotionalValence.FRUSTRATION,
    'excitement': EmotionalValence.EXCITEMENT,
    'calm': EmotionalValence.CALM,
    'neutral': EmotionalValence.NEUTRAL,
    'warmth': EmotionalValence.WARMTH,
    'affectionate': EmotionalValence.WARMTH, // Alias for warmth
    'playful': EmotionalValence.PLAYFUL,
    // Nuanced resonance states
    'intellectually_playful': EmotionalValence.INTELLECTUALLY_PLAYFUL,
    'quietly_supportive': EmotionalValence.QUIETLY_SUPPORTIVE,
    'vulnerable_authentic': EmotionalValence.VULNERABLE_AUTHENTIC
};

/**
 * Store a memory in the Continuity Architecture
 * 
 * @param {Object} params - Memory storage parameters
 * @param {string} params.entityId - Entity UUID (required)
 * @param {string} params.userId - User/context identifier (required)
 * @param {string} params.content - Memory content (required)
 * @param {string} params.memoryType - Memory type: ANCHOR, ARTIFACT, IDENTITY, CORE, etc. (required)
 * @param {number} [params.importance=5] - Importance level 1-10
 * @param {string[]} [params.tags=[]] - Optional tags for categorization
 * @param {string} [params.emotionalValence] - Optional emotional context
 * @param {number} [params.emotionalIntensity=0.5] - Emotional intensity 0-1
 * @param {boolean} [params.skipDedup=false] - Skip deduplication
 * @returns {Promise<Object>} Result object with success status and memory details
 */
export async function storeContinuityMemory({
    entityId,
    userId,
    content,
    memoryType,
    importance = 5,
    tags = [],
    emotionalValence,
    emotionalIntensity = 0.5,
    skipDedup = false
}) {
    // Validate required fields
    if (!entityId) {
        return {
            success: false,
            error: 'entityId is required for memory operations.'
        };
    }
    
    if (!userId) {
        return {
            success: false,
            error: 'userId is required for memory operations.'
        };
    }
    
    if (!content || content.trim().length === 0) {
        return {
            success: false,
            error: 'Memory content is required and cannot be empty.'
        };
    }
    
    if (!memoryType || !MEMORY_TYPE_MAP[memoryType]) {
        return {
            success: false,
            error: `Invalid memory type: ${memoryType}. Must be one of: ${Object.keys(MEMORY_TYPE_MAP).join(', ')}`
        };
    }
    
    const continuityService = getContinuityMemoryService();
    
    if (!continuityService.isAvailable()) {
        return {
            success: false,
            error: 'Continuity memory service is not available. Check Redis and MongoDB configuration.'
        };
    }
    
    // Build the memory object
    const memory = {
        type: MEMORY_TYPE_MAP[memoryType],
        content: content.trim(),
        importance: Math.min(10, Math.max(1, importance || 5)),
        tags: [...(tags || []), 'explicit-store'], // Mark as explicitly stored
        synthesisType: 'EXPLICIT' // Not auto-synthesized
    };
    
    // Add emotional state if provided (warn if invalid)
    if (emotionalValence) {
        if (EMOTIONAL_VALENCE_MAP[emotionalValence]) {
            memory.emotionalState = {
                valence: EMOTIONAL_VALENCE_MAP[emotionalValence],
                intensity: Math.min(1, Math.max(0, emotionalIntensity || 0.5)),
                userImpact: null
            };
        } else {
            logger.warn(`Invalid emotionalValence "${emotionalValence}" provided. Valid values: ${Object.keys(EMOTIONAL_VALENCE_MAP).join(', ')}`);
            // Continue without emotional state rather than failing
        }
    }
    
    let result;
    
    if (skipDedup) {
        // Direct storage without deduplication
        const id = await continuityService.addMemory(entityId, userId, memory);
        result = { id, merged: false, mergedCount: 0 };
    } else {
        // Storage with deduplication (default)
        result = await continuityService.addMemoryWithDedup(entityId, userId, memory);
    }
    
    if (!result.id) {
        return {
            success: false,
            error: 'Failed to store memory. Check service configuration.'
        };
    }
    
    // Build response
    const response = {
        success: true,
        message: result.merged 
            ? `Memory stored successfully and merged with ${result.mergedCount} similar existing memories. The consolidated memory has ID: ${result.id}`
            : `Memory stored successfully with ID: ${result.id}`,
        memoryId: result.id,
        type: memoryType,
        importance: memory.importance,
        merged: result.merged,
        mergedCount: result.mergedCount || 0,
        content: content.trim().substring(0, 100) + (content.length > 100 ? '...' : '') // Preview for confirmation
    };
    
    if (result.mergedIds?.length > 0) {
        response.consolidatedMemories = result.mergedIds;
        response.message += ` (replaced ${result.mergedIds.length} duplicate memories)`;
    }
    
    logger.info(`Stored continuity memory: ${memoryType} (importance: ${memory.importance}, merged: ${result.merged})`);
    
    return response;
}

// Export constants for use by consumers
export const VALID_MEMORY_TYPES = Object.keys(MEMORY_TYPE_MAP);
export const VALID_EMOTIONAL_VALENCES = Object.keys(EMOTIONAL_VALENCE_MAP);
