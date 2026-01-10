/**
 * Search Continuity Memory Tool
 * 
 * Provides explicit memory search access to the Continuity Architecture.
 * Allows the AI to query its narrative memory for:
 * - Relational Anchors (emotional bonds, user patterns)
 * - Resonance Artifacts (synthesized insights)
 * - Identity Evolution (self-growth notes)
 * - Shared Vocabulary (nicknames, shorthands)
 */

import { getContinuityMemoryService, ContinuityMemoryType } from '../../../../lib/continuity/index.js';
import logger from '../../../../lib/logger.js';

export default {
    inputParameters: {
        query: ``,           // Search query
        memoryTypes: { type: 'array', items: { type: 'string' } },  // Filter by types: ANCHOR, ARTIFACT, IDENTITY, etc.
        limit: { type: 'integer', default: 5 },  // Max results
        expandGraph: { type: 'boolean', default: false },  // Whether to expand to related memories
        contextId: ``,       // User/context identifier
        aiName: ``,          // Entity identifier
    },
    
    // Tool definition for OpenAI format
    toolDefinition: [{
        type: "function",
        icon: "🧠",
        function: {
            name: "SearchMemory",
            description: `Search your narrative memory for relational context, insights, and identity notes. Use this when you need to explicitly recall:
- Relational anchors: Emotional bonds, user patterns, shared experiences
- Resonance artifacts: Synthesized insights and conclusions from past conversations
- Identity evolution: Notes about your own growth and changes
- Shared vocabulary: Nicknames, metaphors, and inside references you've developed together

This searches your long-term memory beyond the current context window.`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What to search for in memory. Be descriptive - this uses semantic search.'
                    },
                    memoryTypes: {
                        type: 'array',
                        items: {
                            type: 'string',
                            enum: ['ANCHOR', 'ARTIFACT', 'IDENTITY', 'SHORTHAND']
                        },
                        description: 'Filter by memory types. Leave empty to search all types.'
                    },
                    expandGraph: {
                        type: 'boolean',
                        description: 'If true, also fetch memories related to the search results (associative recall).'
                    }
                },
                required: ['query']
            }
        }
    }],
    
    resolver: async (_parent, args, _contextValue, _info) => {
        const { 
            query, 
            memoryTypes, 
            limit = 15, // Increased from 5 to capture more relevant memories, including factual lists
            expandGraph = false,
            contextId,
            aiName
        } = args;
        
        try {
            const continuityService = getContinuityMemoryService();
            
            if (!continuityService.isAvailable()) {
                return JSON.stringify({
                    success: false,
                    error: 'Continuity memory service is not available.',
                    memories: []
                });
            }
            
            // Map string types to enum values (handle null/undefined)
            const typesArray = Array.isArray(memoryTypes) ? memoryTypes : [];
            const typeFilters = typesArray.length > 0 
                ? typesArray.map(t => ContinuityMemoryType[t] || t)
                : null;
            
            // Use args.entityId (UUID from pathway context) for memory operations
            // If no entityId is provided, memory operations are not allowed
            if (!args.entityId) {
                return JSON.stringify({
                    success: false,
                    error: 'entityId is required for memory operations. Memory search is disabled when no entityId is provided.',
                    memories: []
                });
            }
            
            const entityId = args.entityId;
            const userId = contextId;
            
            const memories = await continuityService.searchMemory({
                entityId,
                userId,
                query,
                options: {
                    types: typeFilters,
                    limit,
                    expandGraph
                }
            });
            
            // Format memories for display
            const formattedMemories = memories.map(m => ({
                type: m.type,
                content: m.content,
                importance: m.importance,
                emotionalContext: m.emotionalState?.valence || null,
                recallCount: m.recallCount,
                relatedCount: m.relatedMemoryIds?.length || 0
            }));
            
            // Also provide a natural language summary
            const displayText = continuityService.formatMemoriesForDisplay(memories);
            
            return JSON.stringify({
                success: true,
                message: memories.length === 0 
                    ? 'No memories found matching your query.'
                    : `Found ${memories.length} relevant memories.`,
                memories: formattedMemories,
                display: displayText
            });
            
        } catch (error) {
            logger.error(`Continuity memory search failed: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `Memory search failed: ${error.message}`,
                memories: []
            });
        }
    }
};

