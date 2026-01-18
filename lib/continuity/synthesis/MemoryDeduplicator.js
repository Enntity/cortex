/**
 * Memory Deduplicator
 * 
 * Handles clustering and deduplication of continuity memories.
 * When storing new memories, finds semantically similar existing memories
 * and merges them while preserving narrative properties.
 * 
 * Key behaviors:
 * - Clusters memories by semantic similarity (cosine distance)
 * - Merges duplicate memories into stronger, consolidated entries
 * - Preserves the most important narrative properties
 * - Maintains relational links across merged memories
 * - Handles n existing duplicates in a single pass
 */

import { callPathway } from '../../pathwayTools.js';
import logger, { continuityLog } from '../../logger.js';
import {
    ContinuityMemoryType,
    SynthesisType,
    checkMergeDrift
} from '../types.js';

// Similarity threshold for considering memories as duplicates
// This is applied to the raw vector similarity score (0-1), not the composite recall score
// 0.75 = catches near-duplicates while preserving distinct but related memories
// Note: Lower threshold catches more near-duplicates but may merge distinct memories
const DEDUP_SIMILARITY_THRESHOLD = 0.75;

// Maximum number of similar memories to consider for merging
const MAX_CLUSTER_SIZE = 5;

// Time window for in-memory cache (ms) - helps with vector index sync delay
// (MongoDB Atlas takes time to sync new documents to vector indexes)
const MEMORY_CACHE_TTL_MS = 30000; // 30 seconds

export class MemoryDeduplicator {
    /**
     * @param {MongoMemoryIndex} memoryIndex
     * @param {Object} [options]
     * @param {number} [options.similarityThreshold] - Cosine similarity threshold for dedup (0-1)
     * @param {number} [options.maxClusterSize] - Max memories to merge in one operation
     * @param {Function} [options.onMemoryWrite] - Callback after any memory write (entityId, userId)
     */
    constructor(memoryIndex, options = {}) {
        this.memoryIndex = memoryIndex;
        this.similarityThreshold = options.similarityThreshold || DEDUP_SIMILARITY_THRESHOLD;
        this.maxClusterSize = options.maxClusterSize || MAX_CLUSTER_SIZE;
        this.onMemoryWrite = options.onMemoryWrite || null;
        
        // In-memory cache for recently stored memories (workaround for vector index sync delay)
        // Key: entityId:userId:type, Value: { memories: [], timestamp: Date }
        this.recentMemoryCache = new Map();
    }
    
    /**
     * Notify after any memory write (for cache invalidation)
     * @private
     */
    _notifyMemoryWrite(entityId, userId) {
        if (this.onMemoryWrite) {
            try {
                this.onMemoryWrite(entityId, userId);
            } catch (err) {
                logger.warn(`Memory write callback failed: ${err.message}`);
            }
        }
    }
    
    /**
     * Add to recent memory cache (for immediate dedup before vector index syncs)
     * @private
     */
    _addToCache(entityId, userId, memory) {
        const key = `${entityId}:${userId}:${memory.type || 'unknown'}`;
        const now = Date.now();
        
        // Get or create cache entry
        let cacheEntry = this.recentMemoryCache.get(key);
        if (!cacheEntry || (now - cacheEntry.timestamp) > MEMORY_CACHE_TTL_MS) {
            cacheEntry = { memories: [], timestamp: now };
        }
        
        // Add memory to cache with content for matching
        cacheEntry.memories.push({
            id: memory.id,
            content: memory.content,
            type: memory.type,
            timestamp: now
        });
        
        // Keep only recent entries (max 20 per key)
        if (cacheEntry.memories.length > 20) {
            cacheEntry.memories = cacheEntry.memories.slice(-20);
        }
        
        cacheEntry.timestamp = now;
        this.recentMemoryCache.set(key, cacheEntry);
        
        // Cleanup old cache entries periodically
        if (Math.random() < 0.1) {
            this._cleanupCache();
        }
    }
    
    /**
     * Check cache for recent similar memories (before vector index syncs them)
     * @private
     */
    _checkCache(entityId, userId, content, type) {
        const key = `${entityId}:${userId}:${type || 'unknown'}`;
        const cacheEntry = this.recentMemoryCache.get(key);
        
        if (!cacheEntry) return null;
        
        const now = Date.now();
        if ((now - cacheEntry.timestamp) > MEMORY_CACHE_TTL_MS) {
            this.recentMemoryCache.delete(key);
            return null;
        }
        
        // Check for similar content using quick string similarity
        for (const cached of cacheEntry.memories) {
            const similarity = this._quickSimilarity(content, cached.content);
            if (similarity >= 0.85) { // High threshold for cache matches (quick text comparison)
                // Reduced verbosity - cache hits are expected
                return cached;
            }
        }
        
        return null;
    }
    
    /**
     * Cleanup old cache entries
     * @private
     */
    _cleanupCache() {
        const now = Date.now();
        for (const [key, entry] of this.recentMemoryCache.entries()) {
            if ((now - entry.timestamp) > MEMORY_CACHE_TTL_MS) {
                this.recentMemoryCache.delete(key);
            }
        }
    }
    
    /**
     * Store a memory with deduplication
     * Finds similar existing memories and merges them if needed
     * 
     * Uses both:
     * 1. In-memory cache (for rapid-fire requests before vector index syncs)
     * 2. Vector search (for indexed memories)
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @param {Object} [options]
     * @param {boolean} [options.deferDeletes=false] - If true, return IDs to delete for batch deletion later
     * @returns {Promise<{id: string, merged: boolean, mergedCount: number, mergedIds: string[]}>}
     */
    async storeWithDedup(entityId, userId, memory, options = {}) {
        const { deferDeletes = false } = options;
        
        if (!memory.content) {
            logger.warn('Cannot deduplicate memory without content');
            return { id: null, merged: false, mergedCount: 0, mergedIds: [] };
        }
        
        try {
            // FIRST: Check in-memory cache for very recent stores (vector index sync delay workaround)
            const cachedMatch = this._checkCache(entityId, userId, memory.content, memory.type);
            if (cachedMatch) {
                logger.info(`Found duplicate in recent cache (before index synced). Skipping duplicate store for: "${memory.content.substring(0, 60)}..."`);
                // Return the cached ID - this is an exact/near-exact duplicate we just stored
                return { 
                    id: cachedMatch.id, 
                    merged: true, 
                    mergedCount: 1,
                    mergedIds: [],
                    message: 'Duplicate detected from recent store (index sync delay bypass)'
                };
            }
            
            // OPTIMIZATION: Pre-compute embedding once if not provided
            // This avoids duplicate embedding calls during search and upsert
            if (!memory.contentVector || memory.contentVector.length === 0) {
                memory.contentVector = await this.memoryIndex._getEmbedding(memory.content);
            }
            
            // SECOND: Find semantically similar existing memories in index
            // Pass pre-computed embedding to avoid regeneration
            const similarMemories = await this._findSimilarMemories(
                entityId, userId, memory.content, memory.type, memory.contentVector
            );
            
            if (similarMemories.length === 0) {
                // No duplicates - store normally and add to cache
                const id = await this.memoryIndex.upsertMemory(entityId, userId, memory);
                
                // Add to cache for rapid-fire dedup
                this._addToCache(entityId, userId, { ...memory, id });
                
                // Notify for cache invalidation
                this._notifyMemoryWrite(entityId, userId);
                
                // Log memory store in continuity mode
                continuityLog.synthesize('memory_store', entityId, userId, {
                    content: memory.content,
                    stats: { type: memory.type }
                });
                
                return { id, merged: false, mergedCount: 0, mergedIds: [] };
            }
            
            logger.info(`Found ${similarMemories.length} similar memory(ies) to merge. Content: "${memory.content.substring(0, 100)}..."`);
            
            // Merge with existing similar memories
            const mergedMemory = await this._mergeMemories(memory, similarMemories);
            
            // DRIFT CHECK: Verify the merge didn't semantically drift too far
            // Embed the merged content and compare to original vectors
            const mergedVector = await this.memoryIndex._getEmbedding(mergedMemory.content);
            const bestMatch = similarMemories[0]; // Highest similarity match
            
            // Use shared drift check utility
            const driftCheck = checkMergeDrift(
                memory.contentVector,
                bestMatch.contentVector || [],
                mergedVector
            );
            
            if (!driftCheck.valid) {
                logger.info(`Merge drift check FAILED: sim(M',M)=${driftCheck.mergedToM.toFixed(3)} < ${driftCheck.minSimToM.toFixed(3)} OR sim(M',S)=${driftCheck.mergedToS.toFixed(3)} < ${driftCheck.originalSim.toFixed(3)}. Linking instead.`);
                
                // Store M as-is (no merge)
                const id = await this.memoryIndex.upsertMemory(entityId, userId, memory);
                
                // LINK to the similar memory instead
                await this.memoryIndex.linkMemories(id, bestMatch.id);
                
                // Add to cache
                this._addToCache(entityId, userId, { ...memory, id });
                this._notifyMemoryWrite(entityId, userId);
                
                return { id, merged: false, mergedCount: 0, mergedIds: [], linked: true, linkedTo: bestMatch.id };
            }
            
            logger.debug(`Merge drift check PASSED: sim(M',M)=${driftCheck.mergedToM.toFixed(3)}, sim(M',S)=${driftCheck.mergedToS.toFixed(3)}`);
            
            // Store merged content vector for later use
            mergedMemory.contentVector = mergedVector;
            
            // Collect IDs to delete
            const idsToDelete = similarMemories.map(m => m.id).filter(Boolean);
            
            // Delete now or defer for batch deletion later (avoids race conditions in parallel stores)
            if (!deferDeletes && idsToDelete.length > 0) {
                await this._deleteMemories(idsToDelete);
            }
            
            // Store the merged memory
            const id = await this.memoryIndex.upsertMemory(entityId, userId, mergedMemory);
            
            // Add merged memory to cache
            this._addToCache(entityId, userId, { ...mergedMemory, id });
            
            // Notify for cache invalidation
            this._notifyMemoryWrite(entityId, userId);
            
            if (deferDeletes) {
                logger.debug(`Merged ${similarMemories.length} memories into ${id} (${idsToDelete.length} to delete later)`);
            } else {
                logger.info(`Merged ${similarMemories.length} similar memories into ${id} (deleted ${idsToDelete.length} duplicate(s))`);
            }
            
            // Log memory merge in continuity mode
            continuityLog.synthesize('memory_merge', entityId, userId, {
                content: mergedMemory.content,
                stats: { merged: similarMemories.length, type: memory.type }
            });
            
            return { 
                id, 
                merged: true, 
                mergedCount: similarMemories.length,
                mergedIds: idsToDelete
            };
        } catch (error) {
            logger.error(`Deduplication failed: ${error.message}`);
            // Fall back to normal storage
            const id = await this.memoryIndex.upsertMemory(entityId, userId, memory);
            return { id, merged: false, mergedCount: 0, mergedIds: [] };
        }
    }
    
    /**
     * Find vector-similar memories using vector search
     * Uses vector embeddings to find semantically similar content
     * @private
     * @param {string} entityId
     * @param {string} userId
     * @param {string} content - Text content for search
     * @param {string} [type] - Optional memory type filter
     * @param {number[]} [precomputedEmbedding] - Optional pre-computed embedding (avoids regeneration)
     */
    async _findSimilarMemories(entityId, userId, content, type = null, precomputedEmbedding = null) {
        try {
            // Use vector search to find similar memories
            // Pass pre-computed embedding if available to avoid regeneration
            const vectorResults = await this.memoryIndex.searchSemantic(
                entityId, 
                userId, 
                content, 
                this.maxClusterSize * 2, // Fetch more to account for filtering
                type ? [type] : null,
                precomputedEmbedding  // Pass through to avoid regeneration
            );
            
            if (vectorResults.length === 0) {
                logger.debug('No vector search results found for deduplication');
                return [];
            }
            
            // Filter by vector similarity
            // Use the raw vector score (_vectorScore) for deduplication, not the composite recall score
            const similar = vectorResults.filter(m => {
                // Use the preserved _vectorScore if available, otherwise use @search.score directly
                // Vector search scores for cosine similarity are already in ~0-1 range
                const rawVectorScore = m._vectorScore ?? Math.min(1, m['@search.score'] || 0);
                
                // For deduplication, we care about vector similarity, not the composite score
                // Threshold of 0.85 = 85% vector similarity (very similar content)
                const isSimilar = rawVectorScore >= this.similarityThreshold;
                
                    // Only log if it's actually similar (to reduce noise)
                    if (isSimilar) {
                        logger.debug(`Vector match: score=${rawVectorScore.toFixed(3)}, threshold=${this.similarityThreshold}`);
                    }
                
                return isSimilar;
            });
            
            if (similar.length > 0) {
                logger.debug(`Found ${similar.length} vector-similar memory(ies) for deduplication (threshold: ${this.similarityThreshold})`);
            }
            
            return similar.slice(0, this.maxClusterSize);
        } catch (error) {
            logger.error(`Failed to find similar memories: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Merge a new memory with existing similar memories
     * Preserves and resolves narrative properties
     * @private
     */
    async _mergeMemories(newMemory, existingMemories) {
        // Combine all memories for analysis
        const allMemories = [newMemory, ...existingMemories];
        
        // Resolve type - prefer the most specific/valuable type
        const typeHierarchy = [
            ContinuityMemoryType.CORE,
            ContinuityMemoryType.IDENTITY,
            ContinuityMemoryType.ANCHOR,
            ContinuityMemoryType.ARTIFACT,
            ContinuityMemoryType.VALUE,
            ContinuityMemoryType.EXPRESSION,
            ContinuityMemoryType.EPISODE
        ];
        const resolvedType = this._resolveType(allMemories, typeHierarchy);
        
        // Merge content - synthesize if there are significant differences
        const mergedContent = await this._mergeContent(allMemories);
        
        // Importance: use max of sources, no artificial boost
        // (Dedup shouldn't dilute importance, but also shouldn't inflate it)
        const resolvedImportance = Math.max(...allMemories.map(m => m.importance || 5));
        
        // Combine tags - deduplicate
        const allTags = new Set();
        for (const m of allMemories) {
            (m.tags || []).forEach(t => allTags.add(t));
        }
        
        // Combine related memory IDs - deduplicate
        const allRelated = new Set();
        for (const m of allMemories) {
            (m.relatedMemoryIds || []).forEach(id => allRelated.add(id));
        }
        // Remove IDs of memories being merged (they'll be deleted)
        const mergedIds = new Set(existingMemories.map(m => m.id).filter(Boolean));
        const resolvedRelated = [...allRelated].filter(id => !mergedIds.has(id));
        
        // Emotional state - take the most intense or most recent
        const resolvedEmotional = this._resolveEmotionalState(allMemories);
        
        // Relational context - merge key-value properties
        const resolvedRelational = this._resolveRelationalContext(allMemories);
        
        // Recall count - sum all recalls
        const totalRecalls = allMemories.reduce((sum, m) => sum + (m.recallCount || 0), 0);
        
        // Confidence - average with slight boost for corroboration
        const avgConfidence = allMemories.reduce((sum, m) => sum + (m.confidence || 0.8), 0) / allMemories.length;
        const resolvedConfidence = Math.min(1.0, avgConfidence + (allMemories.length > 1 ? 0.1 : 0));
        
        // Track synthesis sources
        const synthesizedFrom = existingMemories.map(m => m.id).filter(Boolean);
        
        // Use the earliest timestamp as the memory origin
        const timestamps = allMemories
            .map(m => m.timestamp)
            .filter(Boolean)
            .sort();
        const originTimestamp = timestamps[0] || new Date().toISOString();
        
        return {
            // New ID will be assigned on upsert
            type: resolvedType,
            content: mergedContent,
            importance: resolvedImportance,
            confidence: resolvedConfidence,
            tags: [...allTags],
            relatedMemoryIds: resolvedRelated,
            emotionalState: resolvedEmotional,
            relationalContext: resolvedRelational,
            recallCount: totalRecalls,
            timestamp: originTimestamp,
            synthesizedFrom,
            synthesisType: SynthesisType.CONSOLIDATION,
            decayRate: newMemory.decayRate ?? 0.1
        };
    }
    
    /**
     * Resolve type from multiple memories - prefer higher in hierarchy
     * @private
     */
    _resolveType(memories, hierarchy) {
        let bestType = ContinuityMemoryType.ANCHOR;
        let bestRank = hierarchy.length;
        
        for (const m of memories) {
            const rank = hierarchy.indexOf(m.type);
            if (rank !== -1 && rank < bestRank) {
                bestRank = rank;
                bestType = m.type;
            }
        }
        
        return bestType;
    }
    
    /**
     * Merge content from multiple memories
     * If very similar, keep the longest/most detailed
     * If different enough, synthesize
     * @private
     */
    async _mergeContent(memories) {
        const contents = memories.map(m => m.content || '').filter(Boolean);
        
        if (contents.length === 0) {
            return '';
        }
        
        if (contents.length === 1) {
            return contents[0];
        }
        
        // Check if contents are very similar (likely same core idea)
        // For efficiency, just keep the longest one if they're all similar
        const longestContent = contents.reduce((a, b) => a.length > b.length ? a : b);
        
        // If the longest content is much longer, it likely contains the others
        const avgLength = contents.reduce((sum, c) => sum + c.length, 0) / contents.length;
        if (longestContent.length > avgLength * 1.5) {
            return longestContent;
        }
        
        // Otherwise, try to synthesize them
        // For now, concatenate unique insights with synthesis marker
        const uniqueContents = [...new Set(contents)];
        
        if (uniqueContents.length === 1) {
            return uniqueContents[0];
        }
        
        // Call LLM to synthesize if we have truly different content
        if (uniqueContents.length <= 3) {
            try {
                const synthesized = await this._callSynthesisForMerge(uniqueContents);
                if (synthesized) {
                    return synthesized;
                }
            } catch (error) {
                logger.warn(`Content synthesis failed, using longest: ${error.message}`);
            }
        }
        
        // Fallback: use longest content
        return longestContent;
    }
    
    /**
     * Call LLM to synthesize multiple memory contents into one
     * @private
     */
    async _callSynthesisForMerge(contents) {
        try {
            const response = await callPathway('sys_continuity_memory_consolidation', {
                contents: contents
            });
            
            return response?.trim() || null;
        } catch (error) {
            logger.error(`Synthesis for merge failed: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Resolve emotional state from multiple memories
     * @private
     */
    _resolveEmotionalState(memories) {
        const states = memories
            .map(m => m.emotionalState)
            .filter(Boolean);
        
        if (states.length === 0) {
            return null;
        }
        
        // Take the most intense emotional state
        let mostIntense = states[0];
        for (const state of states) {
            const intensity = typeof state === 'object' ? (state.intensity || 0) : 0;
            const currentIntensity = typeof mostIntense === 'object' ? (mostIntense.intensity || 0) : 0;
            if (intensity > currentIntensity) {
                mostIntense = state;
            }
        }
        
        return mostIntense;
    }
    
    /**
     * Resolve relational context from multiple memories
     * Merges shared vocabulary and other properties
     * @private
     */
    _resolveRelationalContext(memories) {
        const contexts = memories
            .map(m => m.relationalContext)
            .filter(Boolean);
        
        if (contexts.length === 0) {
            return null;
        }
        
        // Merge all relational context properties
        const merged = {};
        
        for (const ctx of contexts) {
            const obj = typeof ctx === 'string' ? JSON.parse(ctx) : ctx;
            
            for (const [key, value] of Object.entries(obj)) {
                if (key === 'sharedVocabulary') {
                    // Special handling for shared vocabulary - merge objects
                    merged.sharedVocabulary = {
                        ...(merged.sharedVocabulary || {}),
                        ...value
                    };
                } else if (Array.isArray(value)) {
                    // Merge arrays, deduplicate
                    merged[key] = [...new Set([...(merged[key] || []), ...value])];
                } else if (typeof value === 'number') {
                    // Take max for numeric values
                    merged[key] = Math.max(merged[key] || 0, value);
                } else {
                    // For other values, keep the latest (last wins)
                    merged[key] = value;
                }
            }
        }
        
        return Object.keys(merged).length > 0 ? merged : null;
    }
    
    /**
     * Delete multiple memories
     * @private
     */
    async _deleteMemories(ids) {
        for (const id of ids) {
            try {
                await this.memoryIndex.deleteMemory(id);
            } catch (error) {
                logger.warn(`Failed to delete merged memory ${id}: ${error.message}`);
            }
        }
    }
    
    /**
     * Calculate cosine similarity between two vectors
     * @private
     * @param {number[]} a - First vector
     * @param {number[]} b - Second vector
     * @returns {number} Cosine similarity (0-1)
     */
    _cosineSimilarity(a, b) {
        if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
            return 0;
        }
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        if (magnitude === 0) return 0;
        
        return dotProduct / magnitude;
    }
    
    /**
     * Cluster and consolidate all memories for an entity/user
     * Use for batch deduplication
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {string} [options.type] - Optional type filter
     * @param {number} [options.batchSize] - Memories per batch
     * @returns {Promise<{clustered: number, reduced: number}>}
     */
    async clusterAndConsolidate(entityId, userId, options = {}) {
        const { type = null, batchSize = 50 } = options;
        
        let stats = { clustered: 0, reduced: 0 };
        
        try {
            // Get all memories (or by type)
            const memories = type
                ? await this.memoryIndex.getByType(entityId, userId, type, 200)
                : await this.memoryIndex.searchFullText(entityId, userId, '*', { limit: 200 });
            
            if (memories.length < 2) {
                return stats;
            }
            
            // Group into clusters by semantic similarity
            const clusters = await this._clusterMemories(memories);
            
            // Consolidate each cluster
            for (const cluster of clusters) {
                if (cluster.length > 1) {
                    // Take the first as the "new" memory, rest as existing
                    const [primary, ...duplicates] = cluster;
                    const result = await this.storeWithDedup(entityId, userId, primary);
                    
                    if (result.merged) {
                        stats.clustered++;
                        stats.reduced += result.mergedCount;
                    }
                }
            }
            
            return stats;
        } catch (error) {
            logger.error(`Cluster consolidation failed: ${error.message}`);
            return stats;
        }
    }
    
    /**
     * Cluster memories by similarity
     * Simple greedy clustering
     * @private
     */
    async _clusterMemories(memories) {
        const clusters = [];
        const assigned = new Set();
        
        for (let i = 0; i < memories.length; i++) {
            if (assigned.has(i)) continue;
            
            const cluster = [memories[i]];
            assigned.add(i);
            
            // Find similar memories
            for (let j = i + 1; j < memories.length; j++) {
                if (assigned.has(j)) continue;
                
                // Use content similarity as proxy
                const similarity = this._quickSimilarity(
                    memories[i].content || '',
                    memories[j].content || ''
                );
                
                if (similarity >= 0.7) { // Lower threshold for batch clustering
                    cluster.push(memories[j]);
                    assigned.add(j);
                    
                    if (cluster.length >= this.maxClusterSize) break;
                }
            }
            
            clusters.push(cluster);
        }
        
        return clusters;
    }
    
    /**
     * Quick string similarity for batch processing
     * Uses word overlap (Jaccard similarity)
     * @private
     */
    _quickSimilarity(str1, str2) {
        const words1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        const words2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        
        if (words1.size === 0 || words2.size === 0) return 0;
        
        const intersection = [...words1].filter(w => words2.has(w)).length;
        const union = new Set([...words1, ...words2]).size;
        
        return intersection / union;
    }
}

