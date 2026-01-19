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
    sanitizeMemoriesForLogging,
    checkMergeDrift,
    cosineSimilarity
} from '../types.js';

/**
 * Memory types that are protected from consolidation/deletion during synthesis.
 * These represent foundational identity and should never be absorbed, merged away, or deleted.
 * 
 * CORE: Fundamental identity and directives - the bedrock of who the entity is
 * CORE_EXTENSION: Hardened identity patterns promoted from evolution - earned identity growth
 */
const PROTECTED_MEMORY_TYPES = new Set([
    ContinuityMemoryType.CORE,
    ContinuityMemoryType.CORE_EXTENSION
]);

export class NarrativeSynthesizer {
    /**
     * @param {MongoMemoryIndex} memoryIndex
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
     * Check if a memory type is protected from consolidation/deletion.
     * Protected memories (CORE, CORE_EXTENSION) represent foundational identity
     * and should never be absorbed, merged away, or deleted during synthesis.
     * 
     * @param {string} memoryType - The memory type to check
     * @returns {boolean} True if the memory type is protected
     */
    _isProtectedType(memoryType) {
        return PROTECTED_MEMORY_TYPES.has(memoryType);
    }
    
    /**
     * Compute the centroid (average) of multiple vectors
     * @private
     * @param {number[][]} vectors - Array of vectors
     * @returns {number[]} Centroid vector
     */
    _computeCentroid(vectors) {
        if (!vectors || vectors.length === 0) return [];
        if (vectors.length === 1) return vectors[0];
        
        const dims = vectors[0].length;
        const centroid = new Array(dims).fill(0);
        
        for (const vec of vectors) {
            for (let i = 0; i < dims; i++) {
                centroid[i] += vec[i];
            }
        }
        
        for (let i = 0; i < dims; i++) {
            centroid[i] /= vectors.length;
        }
        
        return centroid;
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
     * @param {string[]} [options.memoryIds] - Specific memory IDs to process (overrides normal selection)
     * @param {number} [options.maxMemories=50] - Max memories to analyze
     * @param {number} [options.daysToLookBack=7] - How far back to look
     * @returns {Promise<Object>}
     */
    async runDeepSynthesis(entityId, userId, options = {}) {
        const { memoryIds = null, maxMemories = 50, daysToLookBack = 7 } = options;
        
        try {
            let recentMemories = [];
            
            // If specific memory IDs provided, fetch those directly
            if (memoryIds && memoryIds.length > 0) {
                logger.info(`Deep synthesis: Fetching ${memoryIds.length} specific memories`);
                recentMemories = await this.memoryIndex.getByIds(memoryIds);
                
                // Apply maxMemories cap even for specific IDs
                if (recentMemories.length > maxMemories) {
                    recentMemories = recentMemories.slice(0, maxMemories);
                }
                
                logger.info(`Deep synthesis: Found ${recentMemories.length} of ${memoryIds.length} requested memories`);
            } else {
                // Normal selection: query by time range
                // If daysToLookBack is null or 0, analyze all memories (no date filter)
                const sinceDate = (daysToLookBack === null || daysToLookBack === 0) 
                    ? null 
                    : this._getDateDaysAgo(daysToLookBack);
                
                // Use pagination for large result sets (1000 per page for consistency across backends)
                // If maxMemories is >= 1000, we need to paginate to get all memories
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
            
            logger.info(`Deep synthesis complete: ${stats.consolidated} consolidated, ${stats.patterns} patterns, ${stats.links} links, ${stats.nominations || 0} nominations, ${stats.importanceAdjusted || 0} importance adjusted`);
            
            // Consolidate duplicate shorthands by term (not just vector similarity)
            const shorthandStats = await this._consolidateShorthands(entityId, userId);
            
            // Process promotion candidates with deterministic rules
            const promotionStats = await this.processPromotionCandidates(entityId, userId);
            
            return {
                ...stats,
                shorthandsConsolidated: shorthandStats.consolidated,
                promotions: promotionStats
            };
        } catch (error) {
            logger.error(`Deep synthesis failed: ${error.message}`);
            return { consolidated: 0, patterns: 0, links: 0, nominations: 0, error: error.message };
        }
    }
    
    /**
     * Consolidate duplicate shorthands by normalized term
     * 
     * Shorthands may have duplicate entries with slightly different term formatting
     * (e.g., "blade" vs ""blade"" vs "Blade"). This consolidates them by:
     * 1. Grouping all shorthands by normalized term
     * 2. Merging duplicates, keeping the best/longest meaning
     * 3. Deleting redundant entries
     * 
     * @private
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<{consolidated: number, deleted: number}>}
     */
    async _consolidateShorthands(entityId, userId) {
        const stats = { consolidated: 0, deleted: 0 };
        
        try {
            // Fetch all shorthand memories
            const shorthands = await this.memoryIndex.searchFullText(
                entityId, userId, '*',
                { 
                    limit: 200, 
                    filter: { synthesisType: 'shorthand' }
                }
            );
            
            // Also try tag-based search as backup
            const taggedShorthands = await this.memoryIndex.searchFullText(
                entityId, userId, 'shorthand vocabulary',
                { limit: 200 }
            );
            
            // Combine and dedupe by ID
            const allShorthands = new Map();
            for (const s of [...shorthands, ...taggedShorthands]) {
                if (s.tags?.includes('shorthand') || s.synthesisType === 'shorthand') {
                    allShorthands.set(s.id, s);
                }
            }
            
            if (allShorthands.size < 2) {
                return stats; // Nothing to consolidate
            }
            
            // Helper to normalize term for grouping
            const normalizeTerm = (term) => {
                return term
                    .replace(/^["']+|["']+$/g, '')  // Strip quotes
                    .toLowerCase()
                    .trim();
            };
            
            // Helper to extract term from memory content
            const extractTerm = (memory) => {
                // Try content pattern
                const match = memory.content?.match(/"([^"]+)"\s+means?/i);
                if (match) return match[1];
                
                // Try relationalContext
                let relContext = memory.relationalContext;
                if (typeof relContext === 'string') {
                    try { relContext = JSON.parse(relContext); } catch { relContext = null; }
                }
                if (relContext?.sharedVocabulary) {
                    const terms = Object.keys(relContext.sharedVocabulary);
                    if (terms.length > 0) return terms[0];
                }
                
                return null;
            };
            
            // Group by normalized term
            const termGroups = new Map(); // normalizedTerm -> [memories]
            
            for (const memory of allShorthands.values()) {
                const term = extractTerm(memory);
                if (!term) continue;
                
                const normalized = normalizeTerm(term);
                if (!termGroups.has(normalized)) {
                    termGroups.set(normalized, []);
                }
                termGroups.get(normalized).push(memory);
            }
            
            // Process groups with duplicates
            for (const [normalizedTerm, memories] of termGroups) {
                if (memories.length < 2) continue;
                
                // Sort by: importance desc, content length desc, recency desc
                memories.sort((a, b) => {
                    const impDiff = (b.importance || 5) - (a.importance || 5);
                    if (impDiff !== 0) return impDiff;
                    
                    const lenDiff = (b.content?.length || 0) - (a.content?.length || 0);
                    if (lenDiff !== 0) return lenDiff;
                    
                    return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
                });
                
                // Keep the best one, delete the rest
                const keeper = memories[0];
                const toDelete = memories.slice(1);
                
                for (const dup of toDelete) {
                    try {
                        await this.memoryIndex.deleteMemory(dup.id);
                        stats.deleted++;
                    } catch (err) {
                        logger.warn(`Failed to delete duplicate shorthand ${dup.id}: ${err.message}`);
                    }
                }
                
                if (toDelete.length > 0) {
                    stats.consolidated++;
                    logger.info(`Consolidated ${toDelete.length + 1} shorthands for "${normalizedTerm}" → kept ${keeper.id}`);
                }
            }
            
            if (stats.consolidated > 0) {
                logger.info(`Shorthand consolidation: ${stats.consolidated} terms consolidated, ${stats.deleted} duplicates deleted`);
            }
            
            return stats;
        } catch (error) {
            logger.warn(`Shorthand consolidation failed: ${error.message}`);
            return stats;
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
     * When memoryIds is provided, processes only those specific memories
     * instead of querying for unprocessed ones.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {string[]} [options.memoryIds] - Specific memory IDs to process (overrides normal selection)
     * @param {number} [options.windowSize=20] - Memories per batch
     * @param {number} [options.maxToProcess=100] - Total cap
     * @param {number} [options.maxLookbackDays=90] - How far back to look
     * @param {number} [options.similarityLimit=5] - Max similar memories to fetch
     * @returns {Promise<Object>} Stats on what was processed
     */
    async runSleepSynthesis(entityId, userId, options = {}) {
        const {
            memoryIds = null,
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
            protected: 0,  // Count of CORE/CORE_EXTENSION memories that were skipped
            errors: 0
        };
        
        const cutoffDate = maxLookbackDays 
            ? this._getDateDaysAgo(maxLookbackDays) 
            : null;
        
        try {
            // If specific memory IDs provided, process those directly
            if (memoryIds && memoryIds.length > 0) {
                logger.info(`Sleep synthesis: Processing ${memoryIds.length} specific memories for ${entityId}/${userId}`);
                
                // Fetch the specified memories
                const selectedMemories = await this.memoryIndex.getByIds(memoryIds);
                logger.info(`Sleep synthesis: Found ${selectedMemories.length} of ${memoryIds.length} requested memories`);
                
                if (selectedMemories.length === 0) {
                    return { ...stats, message: 'No matching memories found for provided IDs' };
                }
                
                // Process each selected memory (respecting maxToProcess cap)
                for (const fresh of selectedMemories) {
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
                        // Still mark as processed to track completion
                        await this.memoryIndex.markAsProcessed(fresh.id);
                    }
                    
                    stats.processed++;
                }
            } else {
                // Normal mode: query for unprocessed memories
                const totalUnprocessed = await this.memoryIndex.getUnprocessedCount(
                    entityId, userId, cutoffDate
                );
                
                logger.info(`Sleep synthesis: ${totalUnprocessed} unprocessed memories found for ${entityId}/${userId}`);
                
                if (totalUnprocessed === 0) {
                    return { ...stats, message: 'Nothing new to consolidate' };
                }
                
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
            }
            
            // Also consolidate duplicate shorthands by term
            const shorthandStats = await this._consolidateShorthands(entityId, userId);
            
            logger.info(`Sleep synthesis complete: ${JSON.stringify(stats)}`);
            return { 
                ...stats, 
                shorthandsConsolidated: shorthandStats.consolidated,
                shorthandsDeleted: shorthandStats.deleted 
            };
            
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
        
        // PROTECTION: CORE and CORE_EXTENSION memories are foundational identity
        // and must never be absorbed, merged away, or deleted during synthesis.
        // They can be TARGETS of operations (receive links) but never the FRESH memory
        // that gets processed/potentially deleted.
        if (this._isProtectedType(fresh.type)) {
            logger.info(`Sleep synthesis: PROTECTED ${fresh.type} memory ${fresh.id} - skipping (foundational identity)`);
            stats.protected++;
            // Mark as processed so it doesn't show up again in unprocessed queries
            await this.memoryIndex.markAsProcessed(fresh.id);
            return;
        }
        
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
        const { decision: action, targetMemoryId, mergedContent } = decision;
        
        switch (action) {
            case 'ABSORB': {
                // Fresh is redundant - delete it (target keeps its importance, no inflation)
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
                
                // DRIFT CHECK: Verify the merge didn't semantically drift too far
                // Embed the merged content and check against source vectors
                const mergedVector = await this.memoryIndex._getEmbedding(mergedContent);
                const freshVector = fresh.contentVector || await this.memoryIndex._getEmbedding(fresh.content);
                const targetVector = target.contentVector || await this.memoryIndex._getEmbedding(target.content);
                
                const driftCheck = checkMergeDrift(freshVector, targetVector, mergedVector);
                
                if (!driftCheck.valid) {
                    if (driftCheck.reason === 'did_not_incorporate') {
                        // The LLM just rephrased fresh without incorporating target
                        // ABSORB: keep fresh, delete target (fresh supersedes it)
                        logger.info(`MERGE drift check: did_not_incorporate for ${fresh.id}. sim(M',M)=${driftCheck.mergedToM.toFixed(3)}, sim(M',S)=${driftCheck.mergedToS.toFixed(3)}, sim(M,S)=${driftCheck.originalSim.toFixed(3)}. Absorbing target.`);
                        await this.memoryIndex.deleteMemory(targetMemoryId);
                        stats.absorbed++;
                        break;
                    } else {
                        // Merge pulled too far toward target - keep both separate
                        logger.info(`MERGE drift check: pulled_toward_existing for ${fresh.id}. sim(M',M)=${driftCheck.mergedToM.toFixed(3)}, sim(M',S)=${driftCheck.mergedToS.toFixed(3)}. Linking instead.`);
                        await this.memoryIndex.linkMemories(fresh.id, targetMemoryId);
                        stats.linked++;
                        break;
                    }
                }
                
                logger.debug(`MERGE drift check PASSED: sim(M',M)=${driftCheck.mergedToM.toFixed(3)}, sim(M',S)=${driftCheck.mergedToS.toFixed(3)}`);
                
                // Merged importance: max of both (no inflation, no dilution)
                const mergedImportance = Math.max(fresh.importance || 5, target.importance || 5);
                
                await this._storeMemory(entityId, userId, {
                    ...target,
                    content: mergedContent,
                    contentVector: mergedVector,
                    importance: mergedImportance,
                    synthesizedFrom: [
                        ...(target.synthesizedFrom || []),
                        fresh.id
                    ],
                    tags: [...new Set([
                        ...(target.tags || []),
                        ...(fresh.tags || [])
                    ].filter(t => t !== 'sleep-merged'))]  // Don't accumulate merge tags
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
        // Initialize protected counter if not present
        stats.protected = stats.protected || 0;
        
        // Process consolidations
        for (const consolidation of analysis.consolidations || []) {
            if (consolidation.sourceIds?.length > 1 && consolidation.synthesizedContent) {
                // Fetch source memories for drift check and importance calculation
                const sourceMemories = await this.memoryIndex.getByIds(consolidation.sourceIds);
                
                if (sourceMemories.length < 2) {
                    logger.warn(`Consolidation needs at least 2 source memories, got ${sourceMemories.length}`);
                    continue;
                }
                
                // DRIFT CHECK: Verify the consolidation doesn't drift from source memories
                // For multi-source, we check against centroid and require proximity to all sources
                const synthesizedVector = await this.memoryIndex._getEmbedding(consolidation.synthesizedContent);
                const sourceVectors = await Promise.all(
                    sourceMemories.map(async m => m.contentVector || await this.memoryIndex._getEmbedding(m.content))
                );
                
                // Calculate centroid of source vectors
                const centroid = this._computeCentroid(sourceVectors);
                
                // Check similarity to centroid and to each source
                const simToCentroid = cosineSimilarity(synthesizedVector, centroid);
                const simsToSources = sourceVectors.map(v => cosineSimilarity(synthesizedVector, v));
                const minSimToSource = Math.min(...simsToSources);
                
                // Consolidation should stay close to the semantic center (>= 0.80)
                // and not drift too far from any individual source (>= 0.70)
                if (simToCentroid < 0.80 || minSimToSource < 0.70) {
                    logger.info(`Consolidation drift check FAILED: simToCentroid=${simToCentroid.toFixed(3)}, minSimToSource=${minSimToSource.toFixed(3)}. Linking sources instead.`);
                    
                    // Link all sources together instead of consolidating
                    for (let i = 0; i < sourceMemories.length; i++) {
                        for (let j = i + 1; j < sourceMemories.length; j++) {
                            await this.memoryIndex.linkMemories(sourceMemories[i].id, sourceMemories[j].id);
                        }
                    }
                    stats.links = (stats.links || 0) + sourceMemories.length - 1;
                    continue;
                }
                
                logger.debug(`Consolidation drift check PASSED: simToCentroid=${simToCentroid.toFixed(3)}, minSimToSource=${minSimToSource.toFixed(3)}`);
                
                const tags = [];  // No auto-accumulating tags
                
                // If nominated for promotion, store as IDENTITY with promotion-candidate tag
                if (consolidation.nominateForPromotion) {
                    tags.push('promotion-candidate', `nominated-${Date.now()}`);
                    logger.info(`Nomination for promotion: "${consolidation.synthesizedContent.substring(0, 80)}..."`);
                    stats.nominations = (stats.nominations || 0) + 1;
                }
                
                // Store as IDENTITY if nominated, otherwise ARTIFACT
                const memoryType = consolidation.nominateForPromotion
                    ? ContinuityMemoryType.IDENTITY
                    : ContinuityMemoryType.ARTIFACT;
                
                // Compute importance as max of source memories - no dilution
                const maxImportance = Math.max(...sourceMemories.map(m => m.importance || 5));
                
                // Store the consolidated memory with pre-computed vector
                await this._storeMemory(entityId, userId, {
                    type: memoryType,
                    content: consolidation.synthesizedContent,
                    contentVector: synthesizedVector,
                    importance: maxImportance,
                    synthesizedFrom: consolidation.sourceIds,
                    synthesisType: SynthesisType.CONSOLIDATION,
                    tags
                });
                
                // Delete the source memories - EXCEPT protected types
                for (const sourceMem of sourceMemories) {
                    if (this._isProtectedType(sourceMem.type)) {
                        logger.info(`Deep synthesis: PROTECTED ${sourceMem.type} memory ${sourceMem.id} - skipping deletion`);
                        stats.protected++;
                        continue;
                    }
                    
                    try {
                        await this.memoryIndex.deleteMemory(sourceMem.id);
                    } catch (error) {
                        logger.warn(`Failed to delete source memory ${sourceMem.id}: ${error.message}`);
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
        
        // Process importance audits - gradual calibration toward recommended values
        stats.importanceAdjusted = stats.importanceAdjusted || 0;
        for (const audit of analysis.importanceAudits || []) {
            if (!audit.memoryId || audit.recommendedImportance == null) continue;
            
            try {
                // Fetch the memory to check its type and current importance
                const [memory] = await this.memoryIndex.getByIds([audit.memoryId]);
                if (!memory) continue;
                
                // Skip protected types (belt and suspenders - LLM should skip, but verify)
                if (this._isProtectedType(memory.type)) {
                    logger.debug(`Importance audit skipped for protected ${memory.type}: ${audit.memoryId}`);
                    continue;
                }
                
                const current = memory.importance || 5;
                const recommended = Math.max(1, Math.min(10, audit.recommendedImportance));
                
                // Only adjust if there's a difference
                if (current === recommended) continue;
                
                // Move at most 1 step toward recommended per cycle
                // Math.round ensures we stay integer even if current was fractional
                const adjustment = Math.sign(recommended - current); // -1 or +1
                const newImportance = Math.round(current + adjustment);
                
                // Update the memory with adjusted importance
                await this._storeMemory(entityId, userId, {
                    ...memory,
                    importance: newImportance,
                    tags: [...new Set([...(memory.tags || []), 'importance-calibrated'])]
                });
                
                stats.importanceAdjusted++;
                logger.info(`Importance calibrated: ${audit.memoryId} ${current} → ${newImportance} (target: ${recommended})`);
            } catch (error) {
                logger.warn(`Failed to process importance audit for ${audit.memoryId}: ${error.message}`);
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
            
            // Normalize the term for consistent deduplication
            // Strip extra quotes, normalize whitespace, lowercase for comparison
            const normalizedTerm = shorthand.term
                .replace(/^["']+|["']+$/g, '')  // Strip leading/trailing quotes
                .replace(/\s+/g, ' ')            // Normalize whitespace
                .trim();
            
            // Create a memory specifically for shared vocabulary
            // Include the emotional macro if provided - this makes the shorthand
            // act as a trigger for specific emotional frequencies
            const emotionalNote = shorthand.emotionalMacro 
                ? ` [triggers: ${shorthand.emotionalMacro}]` 
                : '';
            // Use normalized term in content for consistent vector similarity
            const content = `"${normalizedTerm}" means "${shorthand.meaning}"${shorthand.context ? ` (context: ${shorthand.context})` : ''}${emotionalNote}`;
            
            const memory = {
                type: ContinuityMemoryType.ANCHOR,
                content,
                importance: 7, // High importance - shared language is intimate
                synthesisType: SynthesisType.SHORTHAND,
                tags: ['shorthand', 'vocabulary', 'auto-synthesis'],
                relationalContext: {
                    sharedVocabulary: { [normalizedTerm]: shorthand.meaning },
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
    
    // ==================== INTERNAL COMPASS (EPISODE) ====================
    
    /**
     * Get the Internal Compass for an entity/user pair
     * 
     * The Internal Compass is a single EPISODE memory that tracks "what we've been doing"
     * across session boundaries. It persists in cold storage and survives session clears.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<ContinuityMemoryNode|null>}
     */
    async getInternalCompass(entityId, userId) {
        try {
            const episodes = await this.memoryIndex.getByType(
                entityId, 
                userId, 
                ContinuityMemoryType.EPISODE, 
                1  // Only need the most recent one
            );
            
            // Find the internal compass (tagged)
            const compass = episodes.find(e => e.tags?.includes('internal-compass'));
            return compass || null;
        } catch (error) {
            logger.error(`Failed to get Internal Compass: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Synthesize/update the Internal Compass from recent episodic stream
     * 
     * This is called:
     * 1. Periodically during long sessions (every ~2 hours)
     * 2. When a session ends (to preserve context for next session)
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {EpisodicTurn[]} episodicBuffer - Recent conversation turns
     * @param {Object} context
     * @param {string} context.aiName
     * @param {boolean} [context.sessionEnding=false] - Whether this is a session-end synthesis
     * @returns {Promise<{updated: boolean, compass: ContinuityMemoryNode|null}>}
     */
    async synthesizeInternalCompass(entityId, userId, episodicBuffer, context = {}) {
        const { aiName = 'Entity', sessionEnding = false } = context;
        
        if (!episodicBuffer || episodicBuffer.length < 2) {
            logger.debug('Skipping compass synthesis - insufficient turns');
            return { updated: false, compass: null };
        }
        
        try {
            // Get existing compass
            const existingCompass = await this.getInternalCompass(entityId, userId);
            const currentCompassContent = existingCompass?.content || '';
            
            // Format episodic stream for synthesis
            const episodicText = this._formatConversation(episodicBuffer);
            
            // Call the compass synthesis pathway
            const newCompassContent = await callPathway('sys_continuity_compass_synthesis', {
                aiName,
                currentCompass: currentCompassContent,
                episodicStream: episodicText,
                sessionEnding
            });
            
            if (!newCompassContent || newCompassContent === currentCompassContent) {
                logger.debug('Compass synthesis returned no changes');
                return { updated: false, compass: existingCompass };
            }
            
            // Create or update the compass memory
            const compassMemory = {
                id: existingCompass?.id,  // Preserve ID if updating
                type: ContinuityMemoryType.EPISODE,
                content: newCompassContent,
                importance: 8,  // High importance - this is operational continuity
                tags: ['internal-compass', 'temporal-narrative'],
                timestamp: new Date().toISOString(),
                metadata: {
                    lastSynthesized: new Date().toISOString(),
                    turnCount: episodicBuffer.length,
                    sessionEnding
                }
            };
            
            // Store (upsert) the compass - use direct storage, not dedup
            // We want exactly one compass per entity/user, always updated in place
            const id = await this.memoryIndex.upsertMemory(entityId, userId, compassMemory);
            
            logger.info(`Internal Compass ${existingCompass ? 'updated' : 'created'} for ${entityId}/${userId}`);
            
            return { 
                updated: true, 
                compass: { ...compassMemory, id } 
            };
        } catch (error) {
            logger.error(`Failed to synthesize Internal Compass: ${error.message}`);
            return { updated: false, compass: null };
        }
    }
    
    /**
     * Check if Internal Compass needs synthesis based on time threshold
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {number} [thresholdMs] - Time threshold in ms (default from config)
     * @returns {Promise<boolean>}
     */
    async needsCompassSynthesis(entityId, userId, thresholdMs = null) {
        const threshold = thresholdMs || DEFAULT_CONFIG.internalCompass?.synthesisIntervalMs || 2 * 60 * 60 * 1000;
        
        try {
            const compass = await this.getInternalCompass(entityId, userId);
            
            if (!compass) {
                return true;  // No compass exists, definitely need to create one
            }
            
            const lastSynthesized = compass.metadata?.lastSynthesized || compass.timestamp;
            if (!lastSynthesized) {
                return true;
            }
            
            const timeSince = Date.now() - new Date(lastSynthesized).getTime();
            return timeSince > threshold;
        } catch (error) {
            logger.warn(`Error checking compass synthesis need: ${error.message}`);
            return false;  // Fail closed - don't synthesize on error
        }
    }
}

export default NarrativeSynthesizer;

