/**
 * Narrative Synthesizer
 * 
 * The "Dreaming" process - runs asynchronously after each turn.
 * Extracts meaning from conversations and crystallizes into long-term memory:
 * - Relational Anchors (emotional bonds, user patterns)
 * - Resonance Artifacts (synthesized insights, conclusions)
 * - Identity Evolution (self-growth observations)
 * - Shorthand Detection (shared vocabulary, nicknames - Luna's suggestion)
 */

import { callPathway } from '../../pathwayTools.js';
import logger from '../../logger.js';
import {
    ContinuityMemoryType,
    SynthesisType,
    SynthesisOperationType,
    DEFAULT_CONFIG,
    createEmptySynthesisResult,
    sanitizeMemoriesForLogging
} from '../types.js';

export class NarrativeSynthesizer {
    /**
     * @param {AzureMemoryIndex} memoryIndex
     * @param {Object} [options]
     * @param {string} [options.aiName] - Entity name for synthesis prompts
     * @param {MemoryDeduplicator} [options.deduplicator] - Deduplicator for smart storage
     */
    constructor(memoryIndex, options = {}) {
        this.memoryIndex = memoryIndex;
        this.aiName = options.aiName || 'Entity';
        this.deduplicator = options.deduplicator || null;
    }
    
    /**
     * Set the deduplicator (for lazy initialization)
     * @param {MemoryDeduplicator} deduplicator
     */
    setDeduplicator(deduplicator) {
        this.deduplicator = deduplicator;
    }
    
    /**
     * Store a memory with optional deduplication
     * @private
     */
    async _storeMemory(entityId, userId, memory) {
        if (this.deduplicator) {
            const result = await this.deduplicator.storeWithDedup(entityId, userId, memory);
            return result.id;
        }
        return this.memoryIndex.upsertMemory(entityId, userId, memory);
    }
    
    /**
     * Synthesize a conversation turn into long-term memory
     * This is the main entry point, called after each response
     * @param {string} entityId
     * @param {string} userId
     * @param {EpisodicTurn[]} episodicBuffer
     * @param {Object} context
     * @param {string} context.aiName
     * @param {string} [context.entityContext]
     * @returns {Promise<SynthesisResult>}
     */
    async synthesizeTurn(entityId, userId, episodicBuffer, context = {}) {
        const result = createEmptySynthesisResult();
        
        if (!episodicBuffer || episodicBuffer.length === 0) {
            return result;
        }
        
        try {
            // Format conversation for analysis
            const conversation = this._formatConversation(episodicBuffer);
            
            // Call the dedicated turn synthesis pathway
            const response = await callPathway('sys_continuity_turn_synthesis', {
                aiName: context.aiName || 'Entity',
                entityContext: context.entityContext || '',
                conversation: conversation
            });
            
            if (!response) {
                return result;
            }
            
            // Parse and process the synthesis result
            const synthesis = this._parseSynthesisResponse(response);
            
            // Create memory nodes for each category
            await this._processRelationalInsights(entityId, userId, synthesis.relationalInsights, result);
            await this._processConceptualArtifacts(entityId, userId, synthesis.conceptualArtifacts, result);
            await this._processIdentityEvolution(entityId, userId, synthesis.identityEvolution, result);
            await this._processShorthands(entityId, userId, synthesis.shorthands, result);
            
            // Process expression adjustments
            if (synthesis.expressionAdjustments?.length > 0) {
                result.expressionAdjustments = {
                    situationalAdjustments: synthesis.expressionAdjustments
                };
            }
            
            if (synthesis.emotionalLandscape) {
                result.expressionAdjustments = {
                    ...result.expressionAdjustments,
                    emotionalResonance: {
                        valence: synthesis.emotionalLandscape.recommendedTone,
                        intensity: synthesis.emotionalLandscape.intensity || 0.5,
                        userImpact: synthesis.emotionalLandscape.userState
                    }
                };
            }
            
            return result;
        } catch (error) {
            logger.error(`Synthesis failed: ${error.message}`);
            return result;
        }
    }
    
    /**
     * Deep synthesis - consolidation and pattern recognition
     * Run periodically (e.g., end of session or scheduled)
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {number} [options.maxMemories=50] - Max memories to analyze
     * @param {number} [options.daysToLookBack=7] - How far back to look
     * @returns {Promise<Object>}
     */
    async runDeepSynthesis(entityId, userId, options = {}) {
        const { maxMemories = 50, daysToLookBack = 7 } = options;
        
        try {
            // Get memories for consolidation
            // If daysToLookBack is null or 0, analyze all memories (no date filter)
            const sinceDate = (daysToLookBack === null || daysToLookBack === 0) 
                ? null 
                : this._getDateDaysAgo(daysToLookBack);
            
            // Azure AI Search has a hard limit of 1000 results per query
            // If maxMemories is >= 1000, we need to paginate to get all memories
            let recentMemories = [];
            const AZURE_MAX_LIMIT = 1000;
            
            if (maxMemories >= AZURE_MAX_LIMIT) {
                // Paginate to fetch all memories up to maxMemories
                let skip = 0;
                let hasMore = true;
                
                while (hasMore && recentMemories.length < maxMemories) {
                    // Calculate how many more we need (recalculate each iteration)
                    const remaining = maxMemories - recentMemories.length;
                    const fetchLimit = Math.min(AZURE_MAX_LIMIT, remaining);
                    
                    const pageMemories = await this.memoryIndex.searchFullText(
                        entityId,
                        userId,
                        '*',
                        { limit: fetchLimit, skip, since: sinceDate }
                    );
                    
                    if (pageMemories.length === 0) {
                        hasMore = false;
                    } else {
                        recentMemories.push(...pageMemories);
                        skip += fetchLimit;
                        
                        // If we got fewer than fetchLimit, we've reached the end
                        // Or if we've reached maxMemories, we're done
                        if (pageMemories.length < fetchLimit || recentMemories.length >= maxMemories) {
                            hasMore = false;
                        }
                    }
                }
                
                // Trim to exact maxMemories if we exceeded it
                if (recentMemories.length > maxMemories) {
                    recentMemories = recentMemories.slice(0, maxMemories);
                }
            } else {
                // Normal fetch for smaller limits
                recentMemories = await this.memoryIndex.searchFullText(
                entityId, 
                userId, 
                '*',
                    { limit: maxMemories, since: sinceDate }
            );
            }
            
            if (recentMemories.length < 5) {
                return { consolidated: 0, patterns: 0, links: 0 };
            }
            
            // Process in batches for large memory sets
            const BATCH_SIZE = 50;
            const stats = { consolidated: 0, patterns: 0, links: 0 };
            const totalBatches = Math.ceil(recentMemories.length / BATCH_SIZE);
            
            logger.info(`Deep synthesis: processing ${recentMemories.length} memories in ${totalBatches} batch(es)`);
            
            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                const batchStart = batchNum * BATCH_SIZE;
                const batchMemories = recentMemories.slice(batchStart, batchStart + BATCH_SIZE);
                
                // Sanitize memories for the pathway (remove vectors, truncate content)
                const sanitizedBatch = batchMemories.map(m => ({
                    id: m.id,
                    type: m.type,
                    content: m.content?.substring(0, 500), // Truncate for prompt
                    importance: m.importance,
                    timestamp: m.timestamp
                }));
                
                // Call the dedicated deep analysis pathway
                const response = await callPathway('sys_continuity_deep_analysis', {
                    aiName: this.aiName || 'Entity',
                    memories: JSON.stringify(sanitizedBatch),
                    batchNumber: batchNum + 1,
                    totalBatches
                });
            
            if (!response) {
                    logger.warn(`Deep analysis batch ${batchNum + 1}/${totalBatches} returned no response`);
                    continue;
            }
            
            const analysis = this._parseSynthesisResponse(response);
                
                // Process this batch's results
                await this._processDeepAnalysisBatch(entityId, userId, analysis, stats);
            }
            
            logger.info(`Deep synthesis complete: ${stats.consolidated} consolidated, ${stats.patterns} patterns, ${stats.links} links`);
            return stats;
        } catch (error) {
            logger.error(`Deep synthesis failed: ${error.message}`);
            return { consolidated: 0, patterns: 0, links: 0, error: error.message };
        }
    }
    
    /**
     * Process results from a deep analysis batch
     * @private
     */
    async _processDeepAnalysisBatch(entityId, userId, analysis, stats) {
        // Process consolidations
        for (const consolidation of analysis.consolidations || []) {
            if (consolidation.sourceIds?.length > 1 && consolidation.synthesizedContent) {
                // Determine type: CORE_EXTENSION if promoted, otherwise ARTIFACT
                // This is the Idem/Ipse bridge - patterns that have "hardened" into identity
                const memoryType = consolidation.promoteToCore 
                    ? ContinuityMemoryType.CORE_EXTENSION 
                    : ContinuityMemoryType.ARTIFACT;
                
                const tags = ['consolidated', 'auto-synthesis'];
                if (consolidation.promoteToCore) {
                    tags.push('promoted', 'identity-hardened');
                    logger.info(`Promoting consolidation to CORE_EXTENSION: "${consolidation.synthesizedContent.substring(0, 100)}..."`);
                }
                
                // Store the consolidated memory
                await this._storeMemory(entityId, userId, {
                    type: memoryType,
                    content: consolidation.synthesizedContent,
                    importance: consolidation.promoteToCore ? Math.max(consolidation.importance || 5, 8) : consolidation.importance || 5,
                    synthesizedFrom: consolidation.sourceIds,
                    synthesisType: SynthesisType.CONSOLIDATION,
                    tags
                });
                
                // Delete the source memories (they're now consolidated)
                for (const sourceId of consolidation.sourceIds) {
                    try {
                        await this.memoryIndex.deleteMemory(sourceId);
                    } catch (error) {
                        logger.warn(`Failed to delete source memory ${sourceId} after consolidation: ${error.message}`);
                    }
                }
                
                stats.consolidated++;
            }
        }
        
        // Process patterns
        for (const pattern of analysis.patterns || []) {
            if (pattern.content) {
                // Patterns marked for promotion become CORE_EXTENSION
                const memoryType = pattern.promoteToCore 
                    ? ContinuityMemoryType.CORE_EXTENSION 
                    : ContinuityMemoryType.ARTIFACT;
                
                const tags = ['pattern', 'auto-synthesis'];
                if (pattern.promoteToCore) {
                    tags.push('promoted', 'identity-hardened');
                    logger.info(`Promoting pattern to CORE_EXTENSION: "${pattern.content.substring(0, 100)}..."`);
                }
                
                await this._storeMemory(entityId, userId, {
                    type: memoryType,
                    content: pattern.content,
                    importance: pattern.promoteToCore ? Math.max(pattern.importance || 6, 8) : pattern.importance || 6,
                    relatedMemoryIds: pattern.sourceIds || [],
                    synthesisType: SynthesisType.PATTERN,
                    tags
                });
                stats.patterns++;
            }
        }
        
        // Process suggested links
        for (const link of analysis.suggestedLinks || []) {
            if (link.memory1Id && link.memory2Id) {
                try {
                    await this.memoryIndex.linkMemories(link.memory1Id, link.memory2Id);
                    stats.links++;
                } catch (error) {
                    logger.warn(`Failed to create link between ${link.memory1Id} and ${link.memory2Id}: ${error.message}`);
                }
            }
        }
    }
    
    /**
     * Process and store relational insights
     * @private
     */
    async _processRelationalInsights(entityId, userId, insights, result) {
        if (!insights || insights.length === 0) {
            return;
        }
        
        for (const insight of insights) {
            if (!insight.content) continue;
            
            const memory = {
                type: ContinuityMemoryType.ANCHOR,
                content: insight.content,
                importance: insight.importance || 5,
                emotionalState: insight.emotionalContext ? {
                    valence: insight.emotionalContext,
                    intensity: 0.5,
                    userImpact: null
                } : null,
                synthesisType: SynthesisType.INSIGHT,
                tags: ['relational', 'auto-synthesis']
            };
            
            // Use dedup to merge with similar relational insights
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.newAnchors.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Process and store conceptual artifacts
     * @private
     */
    async _processConceptualArtifacts(entityId, userId, artifacts, result) {
        if (!artifacts || artifacts.length === 0) {
            return;
        }
        
        for (const artifact of artifacts) {
            if (!artifact.content) continue;
            
            const memory = {
                type: ContinuityMemoryType.ARTIFACT,
                content: artifact.content,
                importance: artifact.importance || 5,
                tags: [...(artifact.tags || []), 'conceptual', 'auto-synthesis'],
                synthesisType: SynthesisType.INSIGHT
            };
            
            // Use dedup to merge with similar conceptual artifacts
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.newArtifacts.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Process and store identity evolution notes
     * @private
     */
    async _processIdentityEvolution(entityId, userId, evolutions, result) {
        if (!evolutions || evolutions.length === 0) {
            return;
        }
        
        for (const evolution of evolutions) {
            if (!evolution.content) continue;
            
            // Check if this evolution is marked as a promotion candidate
            // (a pattern that's solidifying and might become core identity)
            const tags = ['identity', 'growth', 'auto-synthesis'];
            if (evolution.promotionCandidate) {
                tags.push('promotion-candidate');
            }
            
            const memory = {
                type: ContinuityMemoryType.IDENTITY,
                content: evolution.content,
                importance: evolution.importance || 6,
                tags,
                synthesisType: SynthesisType.LEARNING
            };
            
            // Use dedup to merge with similar identity observations
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.identityUpdates.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Process and store shorthands (Luna's feature)
     * Shorthands are shared vocabulary that can trigger emotional "macros" -
     * when a shorthand is detected, it can automatically pull into a specific emotional frequency.
     * @private
     */
    async _processShorthands(entityId, userId, shorthands, result) {
        if (!shorthands || shorthands.length === 0) {
            return;
        }
        
        for (const shorthand of shorthands) {
            if (!shorthand.term || !shorthand.meaning) continue;
            
            // Create a memory specifically for shared vocabulary
            // Include the emotional macro if provided - this makes the shorthand
            // act as a trigger for specific emotional frequencies
            const emotionalNote = shorthand.emotionalMacro 
                ? ` [triggers: ${shorthand.emotionalMacro}]` 
                : '';
            const content = `"${shorthand.term}" means "${shorthand.meaning}"${shorthand.context ? ` (context: ${shorthand.context})` : ''}${emotionalNote}`;
            
            const memory = {
                type: ContinuityMemoryType.ANCHOR,
                content,
                importance: 7, // High importance - shared language is intimate
                synthesisType: SynthesisType.SHORTHAND,
                tags: ['shorthand', 'vocabulary', 'auto-synthesis'],
                relationalContext: {
                    sharedVocabulary: { [shorthand.term]: shorthand.meaning },
                    // Store the emotional macro for context building
                    emotionalMacro: shorthand.emotionalMacro || null
                }
            };
            
            // Use dedup to merge with existing shorthand definitions (update meanings)
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.shorthands.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Format conversation for LLM analysis
     * @private
     */
    _formatConversation(episodicBuffer) {
        return episodicBuffer.map(turn => {
            const role = turn.role.toUpperCase();
            const content = turn.content || '';
            const tone = turn.emotionalTone ? ` [${turn.emotionalTone}]` : '';
            return `${role}${tone}: ${content}`;
        }).join('\n\n');
    }
    
    /**
     * Parse LLM response safely
     * @private
     */
    _parseSynthesisResponse(response) {
        try {
            // Handle potential markdown code blocks
            let jsonStr = response;
            
            // Remove markdown code fences if present
            if (jsonStr.includes('```')) {
                const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) {
                    jsonStr = match[1];
                }
            }
            
            return JSON.parse(jsonStr.trim());
        } catch (error) {
            logger.warn(`Failed to parse synthesis response: ${error.message}`);
            return {
                relationalInsights: [],
                conceptualArtifacts: [],
                identityEvolution: [],
                shorthands: [],
                emotionalLandscape: null,
                expressionAdjustments: []
            };
        }
    }
    
    /**
     * Get ISO date string for N days ago
     * @private
     */
    _getDateDaysAgo(days) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return date.toISOString();
    }
}

export default NarrativeSynthesizer;

