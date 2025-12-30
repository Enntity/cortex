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

export class AzureMemoryIndex {
    /**
     * @param {Object} [azureConfig]
     * @param {string} [azureConfig.indexName] - Custom index name
     */
    constructor(azureConfig = {}) {
        this.indexName = azureConfig.indexName || DEFAULT_CONFIG.indexName;
        
        // Get API configuration - try config first, then fall back to environment variables
        // (matches pattern used by setup scripts and Python tools)
        try {
            this.apiUrl = config.get('azureCognitiveApiUrl') || process.env.AZURE_COGNITIVE_API_URL || '';
            this.apiKey = config.get('azureCognitiveApiKey') || process.env.AZURE_COGNITIVE_API_KEY || '';
        } catch {
            // Config not available, use environment variables directly
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
            let filter = `entityId eq '${entityId}' and userId eq '${userId}'`;
            if (types && types.length > 0) {
                const typeFilter = types.map(t => `type eq '${t}'`).join(' or ');
                filter += ` and (${typeFilter})`;
            }
            
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
            const reranked = this._rerankResults(results);
            
            // Update recall count for accessed memories (fire and forget)
            for (const result of reranked.slice(0, limit)) {
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
            let filter = `entityId eq '${entityId}' and userId eq '${userId}'`;
            
            if (options.types && options.types.length > 0) {
                const typeFilter = options.types.map(t => `type eq '${t}'`).join(' or ');
                filter += ` and (${typeFilter})`;
            }
            
            if (options.minImportance) {
                filter += ` and importance ge ${options.minImportance}`;
            }
            
            if (options.since) {
                filter += ` and timestamp ge ${options.since}`;
            }
            
            const response = await callPathway('cognitive_search', {
                text: query,
                indexName: this.indexName,
                filter,
                top: options.limit || 10
            });
            
            const parsed = JSON.parse(response);
            // Deserialize JSON string fields
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Full-text search failed: ${error.message}`);
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
     * Upsert a memory node
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
            
            await callPathway('cognitive_insert', {
                text: JSON.stringify(doc),
                indexName: this.indexName,
                docId: id
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
            const filter = ids.map(id => `id eq '${id}'`).join(' or ');
            
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                top: ids.length
            });
            
            const parsed = JSON.parse(response);
            // Deserialize JSON string fields
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
            const filter = `entityId eq '${entityId}' and userId eq '${userId}' and type eq '${type}'`;
            
            const response = await callPathway('cognitive_search', {
                text: '*',
                indexName: this.indexName,
                filter,
                top: limit
            });
            
            const parsed = JSON.parse(response);
            // Deserialize JSON string fields
            return (parsed.value || []).map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get memories by type: ${error.message}`);
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
            const filter = `entityId eq '${entityId}' and userId eq '${userId}'`;
            
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
     * Delete a memory (for "forget me" requests)
     * @param {string} id
     */
    async deleteMemory(id) {
        try {
            await callPathway('cognitive_insert', {
                text: JSON.stringify({ id }),
                indexName: this.indexName,
                mode: 'delete',
                docId: id
            });
        } catch (error) {
            logger.error(`Failed to delete memory: ${error.message}`);
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
            
            for (const memory of allMemories) {
                if (memory.type === ContinuityMemoryType.ANCHOR) {
                    // Delete relational anchors completely
                    await this.deleteMemory(memory.id);
                } else if (memory.synthesizedFrom && memory.synthesizedFrom.length > 0) {
                    // Anonymize synthesized artifacts - keep the insight, remove the source
                    await this.upsertMemory(entityId, 'anonymized', {
                        ...memory,
                        userId: 'anonymized',
                        synthesizedFrom: [],
                        relationalContext: null,
                        emotionalState: null
                    });
                    await this.deleteMemory(memory.id);
                } else {
                    // Delete other memories
                    await this.deleteMemory(memory.id);
                }
            }
            
            logger.info(`Completed cascading forget for ${entityId}/${userId}`);
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
     * @private
     */
    async _incrementRecallCount(id) {
        try {
            const memories = await this.getByIds([id]);
            if (memories.length > 0) {
                const memory = memories[0];
                await this.upsertMemory(memory.entityId, memory.userId, {
                    ...memory,
                    recallCount: (memory.recallCount || 0) + 1,
                    lastAccessed: new Date().toISOString()
                });
            }
        } catch (error) {
            // Silently fail - this is a best-effort operation
        }
    }
    
    /**
     * Re-rank results using Luna's decay formula
     * @private
     */
    _rerankResults(results) {
        if (!results || results.length === 0) {
            return [];
        }
        
        return results
            .map(result => {
                // Deserialize JSON string fields
                const deserialized = this._deserializeMemory(result);
                
                // Extract vector score from Azure's @search.score
                const vectorScore = (deserialized['@search.score'] || 0) / 10; // Normalize to 0-1
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
                    _recallScore: recallScore
                };
            })
            .sort((a, b) => b._recallScore - a._recallScore);
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

