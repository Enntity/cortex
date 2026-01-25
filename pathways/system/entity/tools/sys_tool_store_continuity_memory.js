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
 * 
 * Note: Core logic is shared with sys_store_continuity_memory (GraphQL mutation)
 * via the storeContinuityMemory helper.
 */

import { storeContinuityMemory, VALID_MEMORY_TYPES, VALID_EMOTIONAL_VALENCES } from '../memory/shared/sys_continuity_memory_helpers.js';

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
                        description: 'A short voice phrase (2-5 words) like "Got it" or "Noted"'
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
            skipDedup = false
        } = args;
        
        try {
            // Validate entityId is provided (required for memory operations)
            if (!args.entityId) {
                return JSON.stringify({
                    success: false,
                    error: 'entityId is required for memory operations. Memory storage is disabled when no entityId is provided.'
                });
            }
            
            // Call the shared helper
            const result = await storeContinuityMemory({
                entityId: args.entityId,
                userId: contextId,
                content,
                memoryType,
                importance,
                tags,
                emotionalValence,
                emotionalIntensity,
                skipDedup
            });
            
            // Set tool metadata for tracking (only for tool pathway)
            if (result.success && resolver) {
                resolver.tool = JSON.stringify({
                    toolUsed: "continuity_memory",
                    action: "store",
                    type: memoryType,
                    memoryId: result.memoryId,
                    merged: result.merged
                });
            }
            
            return JSON.stringify(result);
            
        } catch (error) {
            return JSON.stringify({
                success: false,
                error: `Failed to store memory: ${error.message}`
            });
        }
    }
};
