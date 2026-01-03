/**
 * Azure AI Search Memory Index Service
 * 
 * Long-term memory storage for the Continuity Architecture.
 * Provides:
 * - Semantic (vector) search for meaning-based retrieval
 * - Graph expansion for associative memory
 * - Memory CRUD operations
 * 
 * Uses Luna's decay formula for recall scoring:
 * score = (vectorScore * 0.7) + (importance * 0.2) + (recency * 0.1)
 */

import { v4 as uuidv4 } from 'uuid';
import { callPathway } from '../../pathwayTools.js';
import { config } from '../../../config.js';
import logger from '../../logger.js';
import {
    ContinuityMemoryType,
    DEFAULT_CONFIG,
    DEFAULT_DECAY_WEIGHTS,
    calculateRecallScore
} from '../types.js';

// Recall update optimization constants
const RECALL_UPDATE_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes - only update if lastAccessed is older than this
const MAX_RECALL_UPDATES_PER_SEARCH = 5; // Only update recall stats for top N results

export class AzureMemoryIndex {
    /**
     * @param {Object} [azureConfig]
     * @param {string} [azureConfig.indexName] - Custom index name
     */
    constructor(azureConfig = {}) {
        this.indexName = azureConfig.indexName || DEFAULT_CONFIG.indexName;
        
        // Get API configuration - try config first, then fall back to environment variables
        try {
            this.apiUrl = config.get('azureCognitiveApiUrl') || process.env.AZURE_COGNITIVE_API_URL || '';
            this.apiKey = config.get('azureCognitiveApiKey') || process.env.AZURE_COGNITIVE_API_KEY || '';
        } catch {
            this.apiUrl = process.env.AZURE_COGNITIVE_API_URL || '';
            this.apiKey = process.env.AZURE_COGNITIVE_API_KEY || '';
        }
    }
    
    /**
     * Check if Azure AI Search is configured
     * @returns {boolean}
     */
    isConfigured() {
        return !!(this.apiUrl && this.apiKey);
    }
    
    // ==================== FILTER BUILDING HELPERS ====================
    
    /**
     * Build a base filter for entity and user
     * @private
     * @param {string} entityId
     * @param {string} userId
     * @returns {string}
     */
    _buildBaseFilter(entityId, userId) {
        return `entityId eq '${entityId}' and userId eq '${userId}'`;
    }
    
    /**
     * Add type filter to existing filter
     * @private
     * @param {string} baseFilter
     * @param {string[]} types - Array of ContinuityMemoryType values
     * @returns {string}
     */
    _addTypeFilter(baseFilter, types) {
        if (!types || types.length === 0) {
            return baseFilter;
        }
        const typeFilter = types.map(t => `type eq '${t}'`).join(' or ');
        return `${baseFilter} and (${typeFilter})`;
    }
    
    /**
     * Add importance filter to existing filter
     * @private
     * @param {string} baseFilter
     * @param {number} minImportance
     * @returns {string}
     */
    _addImportanceFilter(baseFilter, minImportance) {
        if (!minImportance) {
            return baseFilter;
        }
        return `${baseFilter} and importance ge ${minImportance}`;
    }
    
    /**
     * Add date filter to existing filter
     * @private
     * @param {string} baseFilter
     * @param {string} since - ISO 8601 date string
     * @returns {string}
     */
    _addDateFilter(baseFilter, since) {
        if (!since) {
            return baseFilter;
        }
        return `${baseFilter} and timestamp ge ${since}`;
    }
    
    /**
     * Build ID filter for fetching specific documents
     * @private
     * @param {string[]} ids
     * @returns {string}
     */
    _buildIdFilter(ids) {
        return ids.map(id => `id eq '${id}'`).join(' or ');
    }
    
    // ==================== SEARCH OPERATIONS ====================
    
    /**
     * Semantic search with vector similarity
     * @param {string} entityId
     * @param {string} userId
     * @param {string} query
     * @param {number} [limit=5]
     * @param {string[]} [types] - Filter by memory types
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async searchSemantic(entityId, userId, query, limit = 5, types = null) {
        if (!this.isConfigured()) {
            logger.warn('Azure AI Search not configured for continuity memory');
            return [];
        }
        
        try {
            // Build filter
            let filter = this._buildBaseFilter(entityId, userId);
            filter = this._addTypeFilter(filter, types);
            
            // Generate embedding for the query
            const embedding = await this._getEmbedding(query);
            
            // Call cognitive search with vector
            const response = await callPathway('cognitive_search', {
                text: query,
                indexName: this.indexName,
                filter,
                top: limit * 2, // Fetch more for re-ranking
                inputVector: embedding ? JSON.stringify(embedding) : undefined
            });
            
            let results = [];
            try {
                const parsed = JSON.parse(response);
                results = parsed.value || [];
            } catch {
                logger.warn('Failed to parse Azure search response');
                return [];
            }
            
            // Re-rank using Luna's decay formula
            // Pass the query embedding so we can calculate true cosine similarity
            const reranked = this._rerankResults(results, embedding);
            
            // Update recall count for top N accessed memories only (fire and forget)
            // This reduces Azure chatter while still tracking recall for most important results
            const topResultsForRecallUpdate = reranked.slice(0, Math.min(MAX_RECALL_UPDATES_PER_SEARCH, limit));
            for (const result of topResultsForRecallUpdate) {
                this._incrementRecallCount(result.id).catch(() => {});
            }
            
            return reranked.slice(0, limit);
        } catch (error) {
            logger.error(`Semantic search failed: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Full-text search (non-semantic)
     * @param {string} entityId
     * @param {string} userId
     * @param {string} query
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async searchFullText(entityId, userId, query, options = {}) {
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            let filter = this._buildBaseFilter(entityId, userId);
            filter = this._addTypeFilter(filter, options.types);
            filter = this._addImportanceFilter(filter, options.minImportance);
            filter = this._addDateFilter(filter, options.since);
            
            const response = await callPathway('cognitive_search', {
                text: query,
                indexName: this.indexName,
                filter,
                top: options.limit || 10,
                skip: options.skip || 0
            });
            
            const parsed = JSON.parse(response);
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Full-text search failed: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Search all memories with a custom filter (for admin/cleanup operations)
     * @param {string} filter - OData filter expression (e.g., "entityId ne 'Luna'")
     * @param {Object} [options]
     * @param {number} [options.limit=1000] - Max results
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async searchAllWithFilter(filter, options = {}) {
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                top: options.limit || 1000
            });
            
            const parsed = JSON.parse(response);
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Filter search failed: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Expand graph by fetching related memories
     * This is the "killer feature" - mimics associative memory
     * @param {ContinuityMemoryNode[]} memories
     * @param {number} [maxDepth=1]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async expandGraph(memories, maxDepth = 1) {
        if (maxDepth <= 0 || memories.length === 0) {
            return memories;
        }
        
        try {
            const seen = new Set(memories.map(m => m.id));
            const toFetch = new Set();
            
            for (const memory of memories) {
                // Add related memories
                for (const relatedId of memory.relatedMemoryIds || []) {
                    if (!seen.has(relatedId)) {
                        toFetch.add(relatedId);
                    }
                }
                
                // Add parent memory if exists
                if (memory.parentMemoryId && !seen.has(memory.parentMemoryId)) {
                    toFetch.add(memory.parentMemoryId);
                }
            }
            
            if (toFetch.size === 0) {
                return memories;
            }
            
            // Fetch related memories
            const relatedMemories = await this.getByIds([...toFetch]);
            
            // Recursively expand if depth > 1
            if (maxDepth > 1 && relatedMemories.length > 0) {
                const deeperMemories = await this.expandGraph(relatedMemories, maxDepth - 1);
                return [...memories, ...deeperMemories.filter(m => !seen.has(m.id))];
            }
            
            return [...memories, ...relatedMemories];
        } catch (error) {
            logger.error(`Graph expansion failed: ${error.message}`);
            return memories;
        }
    }
    
    // ==================== CRUD OPERATIONS ====================
    
    /**
     * Upsert a memory node using the rate-limited pathway
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @returns {Promise<string>} The memory ID
     */
    async upsertMemory(entityId, userId, memory) {
        if (!this.isConfigured()) {
            logger.warn('Azure AI Search not configured - cannot store memory');
            return null;
        }
        
        try {
            const id = memory.id || uuidv4();
            const now = new Date().toISOString();
            
            // Generate embedding if content is provided and no vector exists
            let contentVector = memory.contentVector;
            if (memory.content && (!contentVector || contentVector.length === 0)) {
                contentVector = await this._getEmbedding(memory.content);
            }
            
            const doc = {
                id,
                entityId,
                userId,
                type: memory.type || ContinuityMemoryType.ANCHOR,
                content: memory.content || '',
                contentVector: contentVector || [],
                relatedMemoryIds: memory.relatedMemoryIds || [],
                parentMemoryId: memory.parentMemoryId || null,
                tags: memory.tags || [],
                timestamp: memory.timestamp || now,
                lastAccessed: now,
                recallCount: memory.recallCount || 0,
                importance: memory.importance ?? 5,
                confidence: memory.confidence ?? 0.8,
                decayRate: memory.decayRate ?? 0.1,
                // Azure AI Search stores these as JSON strings (complex types not supported)
                emotionalState: memory.emotionalState ? JSON.stringify(memory.emotionalState) : null,
                relationalContext: memory.relationalContext ? JSON.stringify(memory.relationalContext) : null,
                synthesizedFrom: memory.synthesizedFrom || [],
                synthesisType: memory.synthesisType || null
            };
            
            // Use the rate-limited pathway for upsert
            await callPathway('continuity_memory_upsert', {
                text: JSON.stringify(doc),
                indexName: this.indexName,
                document: JSON.stringify(doc)
            });
            
            return id;
        } catch (error) {
            logger.error(`Failed to upsert memory: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Get memories by IDs
     * @param {string[]} ids
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getByIds(ids) {
        if (ids.length === 0) {
            return [];
        }
        
        try {
            const filter = this._buildIdFilter(ids);
            
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                top: ids.length
            });
            
            const parsed = JSON.parse(response);
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get memories by IDs: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get all memories of a specific type
     * @param {string} entityId
     * @param {string} userId
     * @param {string} type
     * @param {number} [limit=50]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getByType(entityId, userId, type, limit = 50) {
        try {
            let filter = this._buildBaseFilter(entityId, userId);
            filter = this._addTypeFilter(filter, [type]);
            
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                top: limit
            });
            
            const parsed = JSON.parse(response);
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get memories by type: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get top memories by importance (not query-dependent)
     * 
     * Used for bootstrap context - fetches the most important memories for a 
     * given entity/user relationship regardless of the current query topic.
     * This enables the "seeded context" pattern where identity and relational
     * foundation is established before topic-specific search.
     * 
     * @param {string} entityId - Entity identifier
     * @param {string} userId - User identifier  
     * @param {Object} [options]
     * @param {string[]} [options.types] - Filter by memory types (e.g., ['CORE', 'ANCHOR'])
     * @param {number} [options.limit=10] - Maximum results to return
     * @param {number} [options.minImportance=5] - Minimum importance threshold (1-10)
     * @returns {Promise<ContinuityMemoryNode[]>} Memories sorted by importance DESC, then recency
     */
    async getTopByImportance(entityId, userId, options = {}) {
        const { types = null, limit = 10, minImportance = 5 } = options;
        
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            // Build filter: entity + user + optional types + importance threshold
            let filter = this._buildBaseFilter(entityId, userId);
            filter = this._addTypeFilter(filter, types);
            filter = this._addImportanceFilter(filter, minImportance);
            
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                orderby: 'importance desc, timestamp desc',
                top: limit
            });
            
            const parsed = JSON.parse(response);
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get top memories by importance: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Check if entity has any memories
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    async hasMemories(entityId, userId) {
        try {
            const filter = this._buildBaseFilter(entityId, userId);
            
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                top: 1
            });
            
            const parsed = JSON.parse(response);
            return (parsed.value?.length || 0) > 0;
        } catch (error) {
            logger.error(`Failed to check for memories: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Delete a memory using the rate-limited pathway
     * @param {string} id
     */
    async deleteMemory(id) {
        if (!this.isConfigured()) {
            logger.warn('Azure AI Search not configured - cannot delete memory');
            return;
        }
        
        try {
            await callPathway('continuity_memory_delete', {
                indexName: this.indexName,
                docId: id
            });
        } catch (error) {
            logger.error(`Failed to delete memory: ${error.message}`);
        }
    }
    
    /**
     * Batch delete multiple memories
     * @param {string[]} ids
     */
    async deleteMemories(ids) {
        if (!this.isConfigured() || ids.length === 0) {
            return;
        }
        
        // Delete in parallel with some concurrency limit
        const batchSize = 10;
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            await Promise.all(batch.map(id => this.deleteMemory(id)));
        }
    }
    
    /**
     * Cascading delete for "forget me" requests
     * Deletes anchors and anonymizes synthesized artifacts
     * @param {string} entityId
     * @param {string} userId
     */
    async cascadingForget(entityId, userId) {
        try {
            // Get all memories for this user
            const allMemories = await this.searchFullText(entityId, userId, '*', { limit: 1000 });
            
            const toDelete = [];
            const toAnonymize = [];
            
            for (const memory of allMemories) {
                if (memory.type === ContinuityMemoryType.ANCHOR) {
                    // Delete relational anchors completely
                    toDelete.push(memory.id);
                } else if (memory.synthesizedFrom && memory.synthesizedFrom.length > 0) {
                    // Anonymize synthesized artifacts - keep the insight, remove the source
                    toAnonymize.push(memory);
                } else {
                    // Delete other memories
                    toDelete.push(memory.id);
                }
            }
            
            // Batch delete
            await this.deleteMemories(toDelete);
            
            // Anonymize synthesized artifacts
            for (const memory of toAnonymize) {
                await this.upsertMemory(entityId, 'anonymized', {
                    ...memory,
                    userId: 'anonymized',
                    synthesizedFrom: [],
                    relationalContext: null,
                    emotionalState: null
                });
                await this.deleteMemory(memory.id);
            }
            
            logger.info(`Completed cascading forget for ${entityId}/${userId}: deleted ${toDelete.length}, anonymized ${toAnonymize.length}`);
        } catch (error) {
            logger.error(`Cascading forget failed: ${error.message}`);
        }
    }
    
    /**
     * Link two memories as related
     * @param {string} memoryId1
     * @param {string} memoryId2
     */
    async linkMemories(memoryId1, memoryId2) {
        try {
            const [memory1, memory2] = await this.getByIds([memoryId1, memoryId2]);
            
            if (memory1 && memory2) {
                // Add bidirectional links
                const related1 = new Set(memory1.relatedMemoryIds || []);
                const related2 = new Set(memory2.relatedMemoryIds || []);
                
                related1.add(memoryId2);
                related2.add(memoryId1);
                
                // Update both memories
                await Promise.all([
                    this.upsertMemory(memory1.entityId, memory1.userId, {
                        ...memory1,
                        relatedMemoryIds: [...related1]
                    }),
                    this.upsertMemory(memory2.entityId, memory2.userId, {
                        ...memory2,
                        relatedMemoryIds: [...related2]
                    })
                ]);
            }
        } catch (error) {
            logger.error(`Failed to link memories: ${error.message}`);
        }
    }
    
    // ==================== PRIVATE HELPERS ====================
    
    /**
     * Generate embedding for text
     * @private
     */
    async _getEmbedding(text) {
        try {
            const response = await callPathway('embeddings', { text });
            const embeddings = JSON.parse(response);
            return embeddings[0] || [];
        } catch (error) {
            logger.warn(`Failed to generate embedding: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Increment recall count for a memory
     * Uses a lightweight update - just the fields that changed
     * Debounced: only updates if lastAccessed is older than RECALL_UPDATE_DEBOUNCE_MS
     * This reduces Azure chatter while still maintaining useful recall statistics
     * @private
     */
    async _incrementRecallCount(id) {
        try {
            const memories = await this.getByIds([id]);
            if (memories.length === 0) {
                return;
            }
            
            const memory = memories[0];
            const now = Date.now();
            
            // Check if we should debounce this update
            if (memory.lastAccessed) {
                const lastAccessedTime = new Date(memory.lastAccessed).getTime();
                const timeSinceLastAccess = now - lastAccessedTime;
                
                // Skip update if accessed recently (within debounce window)
                if (timeSinceLastAccess < RECALL_UPDATE_DEBOUNCE_MS) {
                    return; // Silently skip - reduces chatter
                }
            }
            
            // Only update recall count and last accessed
            await this.upsertMemory(memory.entityId, memory.userId, {
                ...memory,
                recallCount: (memory.recallCount || 0) + 1,
                lastAccessed: new Date().toISOString()
            });
        } catch {
            // Silently fail - this is a best-effort operation
        }
    }
    
    /**
     * Re-rank results using Luna's decay formula
     * @private
     * @param {Array} results - Raw Azure search results
     * @param {Array<number>} [queryEmbedding] - Query embedding vector for true cosine similarity calculation
     */
    _rerankResults(results, queryEmbedding = null) {
        if (!results || results.length === 0) {
            return [];
        }
        
        return results
            .map(result => {
                // Deserialize JSON string fields
                const deserialized = this._deserializeMemory(result);
                
                // Calculate true cosine similarity if we have both query and result embeddings
                // This is more accurate than Azure's composite @search.score for deduplication
                let vectorScore = deserialized['@search.score'] || 0;
                
                if (queryEmbedding && deserialized.contentVector && Array.isArray(deserialized.contentVector)) {
                    const trueSimilarity = this._cosineSimilarity(queryEmbedding, deserialized.contentVector);
                    if (trueSimilarity > 0) {
                        vectorScore = trueSimilarity; // Use true cosine similarity for deduplication
                    }
                }
                
                const importance = deserialized.importance || 5;
                const lastAccessed = deserialized.lastAccessed || deserialized.timestamp || new Date().toISOString();
                
                const recallScore = calculateRecallScore(
                    Math.min(1, vectorScore),
                    importance,
                    lastAccessed,
                    DEFAULT_DECAY_WEIGHTS
                );
                
                return {
                    ...deserialized,
                    _recallScore: recallScore,
                    _vectorScore: Math.min(1, Math.max(0, vectorScore)) // Preserve true vector similarity for deduplication (0-1)
                };
            })
            .sort((a, b) => b._recallScore - a._recallScore);
    }
    
    /**
     * Calculate cosine similarity between two vectors
     * @private
     * @param {Array<number>} vecA
     * @param {Array<number>} vecB
     * @returns {number} Cosine similarity (0-1)
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || !Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
            return 0;
        }
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        
        if (normA === 0 || normB === 0) {
            return 0;
        }
        
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    
    /**
     * Deserialize JSON string fields from Azure AI Search
     * @private
     */
    _deserializeMemory(memory) {
        if (!memory) return memory;
        
        const result = { ...memory };
        
        // Parse emotionalState if it's a JSON string
        if (typeof result.emotionalState === 'string' && result.emotionalState) {
            try {
                result.emotionalState = JSON.parse(result.emotionalState);
            } catch {
                result.emotionalState = null;
            }
        }
        
        // Parse relationalContext if it's a JSON string
        if (typeof result.relationalContext === 'string' && result.relationalContext) {
            try {
                result.relationalContext = JSON.parse(result.relationalContext);
            } catch {
                result.relationalContext = null;
            }
        }
        
        return result;
    }
}

export default AzureMemoryIndex;
