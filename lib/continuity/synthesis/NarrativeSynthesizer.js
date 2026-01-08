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
     * @param {AzureMemoryIndex|MongoMemoryIndex} memoryIndex
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
     * Store a memory through deduplicator
     * All writes go through deduplicator which handles cache invalidation.
     * @private
     */
    async _storeMemory(entityId, userId, memory) {
        if (!this.deduplicator) {
            // This should never happen - service always provides deduplicator
            logger.warn('NarrativeSynthesizer: No deduplicator - cache invalidation will be skipped');
            return this.memoryIndex.upsertMemory(entityId, userId, memory);
        }
        const result = await this.deduplicator.storeWithDedup(entityId, userId, memory);
        return result.id;
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
            
            // Use pagination for large result sets (1000 per page for consistency across backends)
            // If maxMemories is >= 1000, we need to paginate to get all memories
            let recentMemories = [];
            const PAGE_LIMIT = 1000;
            
            if (maxMemories >= PAGE_LIMIT) {
                // Paginate to fetch all memories up to maxMemories
                let skip = 0;
                let hasMore = true;
                
                while (hasMore && recentMemories.length < maxMemories) {
                    // Calculate how many more we need (recalculate each iteration)
                    const remaining = maxMemories - recentMemories.length;
                    const fetchLimit = Math.min(PAGE_LIMIT, remaining);
                    
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
            
            // Process in overlapping batches for better pattern detection
            // 20% overlap means patterns at batch boundaries aren't missed
            const BATCH_SIZE = 50;
            const OVERLAP = Math.floor(BATCH_SIZE * 0.2); // 10 memories overlap
            const STEP_SIZE = BATCH_SIZE - OVERLAP; // 40 memories per step
            const stats = { consolidated: 0, patterns: 0, links: 0 };
            
            // Calculate number of batches with overlap
            const totalBatches = Math.ceil((recentMemories.length - OVERLAP) / STEP_SIZE);
            
            logger.info(`Deep synthesis: processing ${recentMemories.length} memories in ${totalBatches} overlapping batch(es)`);
            
            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                const batchStart = batchNum * STEP_SIZE;
                const batchEnd = Math.min(batchStart + BATCH_SIZE, recentMemories.length);
                const batchMemories = recentMemories.slice(batchStart, batchEnd);
                
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
            
            logger.info(`Deep synthesis complete: ${stats.consolidated} consolidated, ${stats.patterns} patterns, ${stats.links} links, ${stats.nominations || 0} nominations`);
            
            // Process promotion candidates with deterministic rules
            const promotionStats = await this.processPromotionCandidates(entityId, userId);
            
            return {
                ...stats,
                promotions: promotionStats
            };
        } catch (error) {
            logger.error(`Deep synthesis failed: ${error.message}`);
            return { consolidated: 0, patterns: 0, links: 0, nominations: 0, error: error.message };
        }
    }
    
    /**
     * Sleep-style synthesis - process unprocessed memories one at a time
     * 
     * Models human sleep consolidation:
     * 1. Walk backward through unprocessed memories
     * 2. For each, find similar/linked existing memories
     * 3. Decide: ABSORB, MERGE, LINK, or KEEP
     * 4. Mark as processed
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {number} [options.windowSize=20] - Memories per batch
     * @param {number} [options.maxToProcess=100] - Total cap
     * @param {number} [options.maxLookbackDays=90] - How far back to look
     * @param {number} [options.similarityLimit=5] - Max similar memories to fetch
     * @returns {Promise<Object>} Stats on what was processed
     */
    async runSleepSynthesis(entityId, userId, options = {}) {
        const {
            windowSize = 20,
            maxToProcess = 100,
            maxLookbackDays = 90,
            similarityLimit = 5
        } = options;
        
        const stats = {
            absorbed: 0,
            merged: 0,
            linked: 0,
            kept: 0,
            processed: 0,
            errors: 0
        };
        
        const cutoffDate = maxLookbackDays 
            ? this._getDateDaysAgo(maxLookbackDays) 
            : null;
        
        try {
            // Get initial count for logging
            const totalUnprocessed = await this.memoryIndex.getUnprocessedCount(
                entityId, userId, cutoffDate
            );
            
            logger.info(`Sleep synthesis: ${totalUnprocessed} unprocessed memories found for ${entityId}/${userId}`);
            
            if (totalUnprocessed === 0) {
                return { ...stats, message: 'Nothing new to consolidate' };
            }
            
            let skip = 0;
            
            while (stats.processed < maxToProcess) {
                // Get next window of unprocessed memories (newest first)
                const window = await this.memoryIndex.getUnprocessedMemories(
                    entityId, userId, {
                        limit: windowSize,
                        skip: 0,  // Always 0 because we mark as processed
                        since: cutoffDate,
                        orderBy: 'timestamp desc'
                    }
                );
                
                if (window.length === 0) {
                    logger.info('Sleep synthesis: No more unprocessed memories');
                    break;
                }
                
                logger.info(`Sleep synthesis: Processing window of ${window.length} memories`);
                
                // Process each memory in the window
                for (const fresh of window) {
                    if (stats.processed >= maxToProcess) {
                        break;
                    }
                    
                    try {
                        await this._processSleepMemory(entityId, userId, fresh, stats, {
                            similarityLimit
                        });
                    } catch (error) {
                        logger.error(`Failed to process memory ${fresh.id}: ${error.message}`);
                        stats.errors++;
                        // Still mark as processed to avoid infinite loop
                        await this.memoryIndex.markAsProcessed(fresh.id);
                    }
                    
                    stats.processed++;
                }
            }
            
            logger.info(`Sleep synthesis complete: ${JSON.stringify(stats)}`);
            return stats;
            
        } catch (error) {
            logger.error(`Sleep synthesis failed: ${error.message}`);
            return { ...stats, error: error.message };
        }
    }
    
    /**
     * Process a single memory during sleep synthesis
     * @private
     */
    async _processSleepMemory(entityId, userId, fresh, stats, options = {}) {
        const { similarityLimit = 5 } = options;
        
        // Find similar memories (by semantic similarity)
        const similar = await this.memoryIndex.searchSemantic(
            entityId, userId, fresh.content, similarityLimit
        );
        
        // Filter out the fresh memory itself and already-similar ones
        const filteredSimilar = similar.filter(m => 
            m.id !== fresh.id && 
            !fresh.relatedMemoryIds?.includes(m.id)
        );
        
        // Get graph-linked memories
        const linked = await this.memoryIndex.expandGraph([fresh], 1);
        const filteredLinked = linked.filter(m => m.id !== fresh.id);
        
        // Prepare memories for the decision pathway (remove vectors for prompt)
        const sanitizeMemo = m => ({
            id: m.id,
            type: m.type,
            content: m.content?.substring(0, 500),
            importance: m.importance,
            timestamp: m.timestamp,
            tags: m.tags
        });
        
        // Get decision from LLM
        const response = await callPathway('sys_continuity_sleep_decision', {
            aiName: this.aiName,
            freshMemory: JSON.stringify(sanitizeMemo(fresh)),
            similarMemories: JSON.stringify(filteredSimilar.map(sanitizeMemo)),
            linkedMemories: JSON.stringify(filteredLinked.map(sanitizeMemo))
        });
        
        let decision;
        try {
            decision = typeof response === 'string' ? JSON.parse(response) : response;
        } catch {
            logger.warn(`Failed to parse sleep decision for ${fresh.id}, defaulting to KEEP`);
            decision = { decision: 'KEEP', reason: 'Parse failed' };
        }
        
        // Apply the decision
        await this._applySleepDecision(entityId, userId, fresh, decision, stats);
        
        // Mark as processed (unless it was deleted)
        if (decision.decision !== 'ABSORB') {
            await this.memoryIndex.markAsProcessed(fresh.id);
        }
    }
    
    /**
     * Apply a sleep synthesis decision
     * @private
     */
    async _applySleepDecision(entityId, userId, fresh, decision, stats) {
        const { decision: action, targetMemoryId, mergedContent, importanceBoost = 0 } = decision;
        
        switch (action) {
            case 'ABSORB': {
                // Fresh is redundant - delete it, optionally boost target
                if (targetMemoryId && importanceBoost > 0) {
                    const target = (await this.memoryIndex.getByIds([targetMemoryId]))[0];
                    if (target) {
                        const newImportance = Math.min(10, (target.importance || 5) + importanceBoost);
                        await this._storeMemory(entityId, userId, {
                            ...target,
                            importance: newImportance,
                            tags: [...new Set([...(target.tags || []), 'sleep-reinforced'])]
                        });
                    }
                }
                // Delete the fresh memory
                await this.memoryIndex.deleteMemory(fresh.id);
                stats.absorbed++;
                logger.info(`ABSORB: Deleted ${fresh.id}, target=${targetMemoryId}`);
                break;
            }
            
            case 'MERGE': {
                // Combine fresh and target into one
                if (!targetMemoryId || !mergedContent) {
                    logger.warn(`MERGE missing targetMemoryId or mergedContent, treating as KEEP`);
                    stats.kept++;
                    break;
                }
                
                const target = (await this.memoryIndex.getByIds([targetMemoryId]))[0];
                if (!target) {
                    logger.warn(`MERGE target ${targetMemoryId} not found, treating as KEEP`);
                    stats.kept++;
                    break;
                }
                
                // Create merged memory with boosted importance
                const mergedImportance = Math.min(10, 
                    Math.max(fresh.importance || 5, target.importance || 5) + importanceBoost
                );
                
                await this._storeMemory(entityId, userId, {
                    ...target,
                    content: mergedContent,
                    importance: mergedImportance,
                    synthesizedFrom: [
                        ...(target.synthesizedFrom || []),
                        fresh.id
                    ],
                    tags: [...new Set([
                        ...(target.tags || []),
                        ...(fresh.tags || []),
                        'sleep-merged',
                        'sleep-processed'
                    ])]
                });
                
                // Delete the fresh memory
                await this.memoryIndex.deleteMemory(fresh.id);
                stats.merged++;
                logger.info(`MERGE: Combined ${fresh.id} into ${targetMemoryId}`);
                break;
            }
            
            case 'LINK': {
                // Keep fresh but link to target
                if (targetMemoryId) {
                    await this.memoryIndex.linkMemories(fresh.id, targetMemoryId);
                    logger.info(`LINK: Connected ${fresh.id} <-> ${targetMemoryId}`);
                }
                stats.linked++;
                break;
            }
            
            case 'KEEP':
            default: {
                // No action needed
                stats.kept++;
                break;
            }
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
                const tags = ['consolidated', 'auto-synthesis'];
                
                // If nominated for promotion, store as IDENTITY with promotion-candidate tag
                // Actual promotion happens deterministically in _processPromotionCandidates
                if (consolidation.nominateForPromotion) {
                    tags.push('promotion-candidate', `nominated-${Date.now()}`);
                    logger.info(`Nomination for promotion: "${consolidation.synthesizedContent.substring(0, 80)}..."`);
                    stats.nominations = (stats.nominations || 0) + 1;
                }
                
                // Store as IDENTITY if nominated, otherwise ARTIFACT
                const memoryType = consolidation.nominateForPromotion
                    ? ContinuityMemoryType.IDENTITY
                    : ContinuityMemoryType.ARTIFACT;
                
                // Store the consolidated memory
                await this._storeMemory(entityId, userId, {
                    type: memoryType,
                    content: consolidation.synthesizedContent,
                    importance: consolidation.importance || 5,
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
                const tags = ['pattern', 'auto-synthesis'];
                
                // If nominated for promotion, store as IDENTITY with promotion-candidate tag
                if (pattern.nominateForPromotion) {
                    tags.push('promotion-candidate', `nominated-${Date.now()}`);
                    logger.info(`Nomination for promotion: "${pattern.content.substring(0, 80)}..."`);
                    stats.nominations = (stats.nominations || 0) + 1;
                }
                
                // Store as IDENTITY if nominated, otherwise ARTIFACT
                const memoryType = pattern.nominateForPromotion
                    ? ContinuityMemoryType.IDENTITY
                    : ContinuityMemoryType.ARTIFACT;
                
                await this._storeMemory(entityId, userId, {
                    type: memoryType,
                    content: pattern.content,
                    importance: pattern.importance || 6,
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
    
    /**
     * Process promotion candidates with deterministic rules
     * 
     * A candidate is promoted to CORE_EXTENSION only if:
     * 1. Has at least MIN_NOMINATIONS (3) from different synthesis runs
     * 2. First nomination is at least MIN_AGE_HOURS (24) old
     * 3. Not semantically duplicate of existing CORE_EXTENSION (> 0.85 similarity)
     * 
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<Object>} Stats on promotions
     */
    async processPromotionCandidates(entityId, userId) {
        const MIN_NOMINATIONS = 3;
        const MIN_AGE_HOURS = 24;
        const MAX_SIMILARITY = 0.85;  // Above this = too similar to existing
        
        const stats = { candidates: 0, promoted: 0, rejected: 0, deferred: 0 };
        
        try {
            // Get all promotion candidates
            const candidates = await this.memoryIndex.getPromotionCandidates(entityId, userId);
            stats.candidates = candidates.length;
            
            if (candidates.length === 0) {
                logger.info('No promotion candidates to process');
                return stats;
            }
            
            // Get existing CORE_EXTENSIONs for deduplication
            const existingCoreExt = await this.memoryIndex.getCoreExtensions(entityId, userId);
            
            logger.info(`Processing ${candidates.length} promotion candidates against ${existingCoreExt.length} existing CORE_EXTENSIONs`);
            
            for (const candidate of candidates) {
                const tags = candidate.tags || [];
                
                // Count nominations (tags like "nominated-1704297600000")
                const nominationTags = tags.filter(t => t.startsWith('nominated-'));
                const nominationCount = nominationTags.length;
                
                // Check minimum nominations
                if (nominationCount < MIN_NOMINATIONS) {
                    logger.debug(`Candidate ${candidate.id}: only ${nominationCount}/${MIN_NOMINATIONS} nominations, deferring`);
                    stats.deferred++;
                    continue;
                }
                
                // Check age of first nomination
                const nominationTimestamps = nominationTags
                    .map(t => parseInt(t.replace('nominated-', '')))
                    .sort((a, b) => a - b);  // Oldest first
                
                const oldestNomination = nominationTimestamps[0];
                const ageHours = (Date.now() - oldestNomination) / (1000 * 60 * 60);
                
                if (ageHours < MIN_AGE_HOURS) {
                    logger.debug(`Candidate ${candidate.id}: only ${ageHours.toFixed(1)}h old, need ${MIN_AGE_HOURS}h, deferring`);
                    stats.deferred++;
                    continue;
                }
                
                // Check semantic similarity to existing CORE_EXTENSIONs
                const isDuplicate = await this._checkSemanticDuplicate(
                    candidate.content, 
                    existingCoreExt, 
                    MAX_SIMILARITY
                );
                
                if (isDuplicate) {
                    logger.info(`Rejecting candidate ${candidate.id}: too similar to existing CORE_EXTENSION`);
                    // Remove from candidates (delete or demote to ARTIFACT)
                    await this._demoteCandidate(candidate);
                    stats.rejected++;
                    continue;
                }
                
                // All checks passed - promote!
                const success = await this.memoryIndex.promoteToCore(candidate.id);
                if (success) {
                    logger.info(`✓ Promoted candidate to CORE_EXTENSION: "${candidate.content?.substring(0, 60)}..."`);
                    stats.promoted++;
                    
                    // Add to existing list to check against for remaining candidates
                    existingCoreExt.push(candidate);
                }
            }
            
            logger.info(`Promotion processing complete: ${stats.promoted} promoted, ${stats.rejected} rejected, ${stats.deferred} deferred`);
            return stats;
            
        } catch (error) {
            logger.error(`Promotion processing failed: ${error.message}`);
            return { ...stats, error: error.message };
        }
    }
    
    /**
     * Check if content is semantically too similar to existing memories
     * @private
     */
    async _checkSemanticDuplicate(content, existingMemories, threshold) {
        if (!content || existingMemories.length === 0) {
            return false;
        }
        
        try {
            // Use vector search to find similar content
            const similar = await this.memoryIndex.searchSemantic(
                null, null, content, 3, ['CORE_EXTENSION']
            );
            
            // Check if any result is above threshold
            for (const match of similar) {
                const score = match._vectorScore || 0;
                if (score > threshold) {
                    logger.debug(`Semantic duplicate found: score ${score.toFixed(3)} > ${threshold}`);
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            logger.warn(`Semantic duplicate check failed: ${error.message}`);
            return false;  // Fail open - allow promotion if check fails
        }
    }
    
    /**
     * Demote a rejected candidate (remove promotion-candidate status)
     * @private
     */
    async _demoteCandidate(memory) {
        try {
            // Remove promotion tags, keep as IDENTITY
            const cleanedTags = (memory.tags || [])
                .filter(t => t !== 'promotion-candidate' && !t.startsWith('nominated-'))
                .concat(['promotion-rejected']);
            
            await this.memoryIndex.upsertMemory({
                ...memory,
                tags: cleanedTags
            });
        } catch (error) {
            logger.warn(`Failed to demote candidate ${memory.id}: ${error.message}`);
        }
    }
}

export default NarrativeSynthesizer;

