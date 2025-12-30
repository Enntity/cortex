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
        memoryTypes: [],     // Filter by types: ANCHOR, ARTIFACT, IDENTITY, etc.
        limit: 5,            // Max results
        expandGraph: false,  // Whether to expand to related memories
    },
    
    // Tool definition for OpenAI format
    definition: {
        name: 'search_continuity_memory',
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
        },
        icon: '🧠'
    },
    
    resolver: async (_parent, args, _contextValue, _info) => {
        const { 
            query, 
            memoryTypes = [], 
            limit = 5, 
            expandGraph = false,
            contextId,
            aiName
        } = args;
        
        try {
            const continuityService = getContinuityMemoryService();
            
            if (!continuityService.isAvailable()) {
                return JSON.stringify({
                    error: false,
                    message: 'Continuity memory service is not available.',
                    memories: []
                });
            }
            
            // Map string types to enum values
            const typeFilters = memoryTypes.length > 0 
                ? memoryTypes.map(t => ContinuityMemoryType[t] || t)
                : null;
            
            const entityId = aiName || 'default-entity';
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
            
            if (memories.length === 0) {
                return JSON.stringify({
                    error: false,
                    message: 'No memories found matching your query.',
                    memories: []
                });
            }
            
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
                error: false,
                message: `Found ${memories.length} relevant memories.`,
                memories: formattedMemories,
                display: displayText
            });
            
        } catch (error) {
            logger.error(`Continuity memory search failed: ${error.message}`);
            return JSON.stringify({
                error: true,
                message: `Memory search failed: ${error.message}`,
                memories: []
            });
        }
    }
};

