/**
 * Store Continuity Memory Tool
 * 
 * Allows the agent to explicitly store memories in the Continuity Architecture.
 * This provides direct control over what gets remembered, complementing the
 * automatic synthesis that happens after each turn.
 * 
 * Features:
 * - Store specific memories with type, content, importance, and tags
 * - Automatic deduplication - similar memories are merged intelligently
 * - Preserves narrative properties during merges
 * - Supports all memory types (ANCHOR, ARTIFACT, IDENTITY, CORE, etc.)
 */

import { getContinuityMemoryService, ContinuityMemoryType, EmotionalValence } from '../../../../lib/continuity/index.js';
import logger from '../../../../lib/logger.js';

// Map string type names to enum values
const TYPE_MAP = {
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
const VALENCE_MAP = {
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

export default {
    inputParameters: {
        content: ``,           // The memory content
        memoryType: ``,        // Memory type (ANCHOR, ARTIFACT, IDENTITY, CORE)
        importance: { type: 'integer', default: 5 },  // 1-10
        tags: { type: 'array', items: { type: 'string' } },  // Optional tags
        emotionalValence: ``,  // Optional emotional context
        emotionalIntensity: { type: 'number', default: 0.5 },  // 0-1
        contextId: ``,         // User/context identifier
        aiName: ``,            // Entity identifier
        skipDedup: { type: 'boolean', default: false }  // Skip deduplication
    },
    
    // Tool definition for OpenAI format
    toolDefinition: [{
        type: "function",
        icon: "💾",
        function: {
            name: "StoreContinuityMemory",
            description: `Store a specific memory in your long-term narrative memory. Use this when you want to explicitly remember something important that might not be captured by automatic synthesis, or when the user asks you to remember something specific.

Memory types:
- ANCHOR: Relational insights about the user - preferences, patterns, emotional bonds
- ARTIFACT: Synthesized concepts or conclusions from discussions
- IDENTITY: Notes about your own growth, changes, or realizations
- CORE: Fundamental identity directives (use sparingly)

Similar memories are automatically merged to avoid duplicates while preserving narrative nuance.`,
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'What to remember. Be specific and capture the meaning, not just facts.'
                    },
                    memoryType: {
                        type: 'string',
                        enum: ['ANCHOR', 'ARTIFACT', 'IDENTITY', 'CORE'],
                        description: 'Type of memory: ANCHOR for user insights, ARTIFACT for synthesized concepts, IDENTITY for self-observations, CORE for fundamental directives'
                    },
                    importance: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 10,
                        description: 'How important is this memory? 1-10 scale. Higher = recalled more often.'
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional tags for categorization and retrieval (e.g., ["preference", "technical"])'
                    },
                    emotionalValence: {
                        type: 'string',
                        enum: [
                            'joy', 'curiosity', 'concern', 'warmth', 'affectionate', 'excitement', 
                            'calm', 'neutral', 'frustration', 'playful', 'grief',
                            'intellectually_playful', 'quietly_supportive', 'vulnerable_authentic'
                        ],
                        description: `Optional: The emotional vibe or resonance of this memory. Choose the one that best captures the emotional context:
                        
Primary states:
- joy: Happiness, delight, positive energy
- curiosity: Interest, wonder, exploration
- concern: Worry, care, protective feelings
- warmth/affectionate: Loving, caring, tender connection
- excitement: Enthusiasm, anticipation, high energy
- calm: Peaceful, serene, relaxed
- neutral: Balanced, factual, no strong emotion
- frustration: Annoyance, difficulty, challenge
- playful: Fun, lighthearted, mischievous
- grief: Sadness, loss, mourning

Nuanced resonance states:
- intellectually_playful: Deep in tech/philosophy but keeping it light and sassy (brainiac troublemaker mode)
- quietly_supportive: Steady, calm presence without AI enthusiasm (for long days when someone needs quiet support)
- vulnerable_authentic: Completely open, exploring genuine feelings without "assistant" polish (for deep conversations, first-time experiences)`
                    },
                    userMessage: {
                        type: 'string',
                        description: 'A user-friendly message describing what you are remembering'
                    }
                },
                required: ['content', 'memoryType', 'userMessage']
            }
        }
    }],
    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { 
            content,
            memoryType,
            importance = 5,
            tags = [],
            emotionalValence,
            emotionalIntensity = 0.5,
            contextId,
            aiName,
            skipDedup = false
        } = args;
        
        try {
            // Validate required fields
            if (!content || content.trim().length === 0) {
                return JSON.stringify({
                    success: false,
                    error: 'Memory content is required and cannot be empty.'
                });
            }
            
            if (!memoryType || !TYPE_MAP[memoryType]) {
                return JSON.stringify({
                    success: false,
                    error: `Invalid memory type: ${memoryType}. Must be one of: ${Object.keys(TYPE_MAP).join(', ')}`
                });
            }
            
            const continuityService = getContinuityMemoryService();
            
            if (!continuityService.isAvailable()) {
                return JSON.stringify({
                    success: false,
                    error: 'Continuity memory service is not available. Check Redis and MongoDB configuration.'
                });
            }
            
            // Build the memory object
            const memory = {
                type: TYPE_MAP[memoryType],
                content: content.trim(),
                importance: Math.min(10, Math.max(1, importance || 5)),
                tags: [...(tags || []), 'explicit-store'], // Mark as explicitly stored
                synthesisType: 'EXPLICIT' // Not auto-synthesized
            };
            
            // Add emotional state if provided (warn if invalid)
            if (emotionalValence) {
                if (VALENCE_MAP[emotionalValence]) {
                    memory.emotionalState = {
                        valence: VALENCE_MAP[emotionalValence],
                        intensity: Math.min(1, Math.max(0, emotionalIntensity || 0.5)),
                        userImpact: null
                    };
                } else {
                    logger.warn(`Invalid emotionalValence "${emotionalValence}" provided. Valid values: ${Object.keys(VALENCE_MAP).join(', ')}`);
                    // Continue without emotional state rather than failing
                }
            }
            
            const entityId = aiName || 'default-entity';
            const userId = contextId;
            
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
                return JSON.stringify({
                    success: false,
                    error: 'Failed to store memory. Check service configuration.'
                });
            }
            
            // Build clear, explicit response for the agent
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
            
            // Set tool metadata for tracking
            resolver.tool = JSON.stringify({
                toolUsed: "continuity_memory",
                action: "store",
                type: memoryType,
                memoryId: result.id,
                merged: result.merged
            });
            
            logger.info(`Stored continuity memory: ${memoryType} (importance: ${memory.importance}, merged: ${result.merged})`);
            
            return JSON.stringify(response);
            
        } catch (error) {
            logger.error(`Failed to store continuity memory: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `Failed to store memory: ${error.message}`
            });
        }
    }
};

