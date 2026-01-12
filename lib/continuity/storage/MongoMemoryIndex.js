/**
 * MongoDB Atlas Memory Index Service
 * 
 * Long-term memory storage for the Continuity Architecture using MongoDB Atlas.
 * Provides:
 * - Vector search via Atlas Vector Search
 * - Graph expansion for associative memory
 * - Memory CRUD operations
 * - Client-Side Field Level Encryption (CSFLE) for content field
 * 
 * Uses Luna's decay formula for recall scoring:
 * score = (vectorScore * 0.7) + (importance * 0.2) + (recency * 0.1)
 * 
 * CSFLE Configuration (optional):
 * - MONGO_ENCRYPTION_KEY: Base64-encoded 96-byte encryption key (shared with concierge)
 * - MONGO_DATAKEY_UUID: UUID of the data encryption key (auto-discovered if not provided)
 * - MONGOCRYPT_PATH: Path to mongocrypt shared library (optional)
 */

import { v4 as uuidv4 } from 'uuid';
import { MongoClient, UUID } from 'mongodb';
import { callPathway } from '../../pathwayTools.js';
import logger from '../../logger.js';
import {
    ContinuityMemoryType,
    DEFAULT_CONFIG,
    DEFAULT_DECAY_WEIGHTS,
    calculateRecallScore
} from '../types.js';

// CSFLE configuration from environment
const { MONGO_ENCRYPTION_KEY, MONGO_DATAKEY_UUID, MONGOCRYPT_PATH } = process.env;

// Recall update optimization constants
const RECALL_UPDATE_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RECALL_UPDATES_PER_SEARCH = 5;

// Default collection name
const DEFAULT_COLLECTION = 'continuity_memories';

// Vector search index name (must match Atlas Search index)
const VECTOR_INDEX_NAME = 'continuity_vector_index';

export class MongoMemoryIndex {
    /**
     * @param {Object} [mongoConfig]
     * @param {string} [mongoConfig.collectionName] - Custom collection name
     * @param {string} [mongoConfig.databaseName] - Database name (defaults to URI database)
     */
    constructor(mongoConfig = {}) {
        this.collectionName = mongoConfig.collectionName || DEFAULT_COLLECTION;
        this.databaseName = mongoConfig.databaseName || null;
        
        // Get connection string from environment
        this.connectionString = process.env.MONGO_URI || '';
        
        // Connection state
        this._client = null;
        this._db = null;
        this._collection = null;
        this._connected = false;
    }
    
    /**
     * Check if MongoDB is configured
     * @returns {boolean}
     */
    isConfigured() {
        return !!this.connectionString;
    }
    
    /**
     * Get or create MongoDB connection with optional CSFLE
     * @private
     * @returns {Promise<import('mongodb').Collection>}
     */
    async _getCollection() {
        if (this._collection && this._connected) {
            return this._collection;
        }
        
        if (!this.isConfigured()) {
            throw new Error('MongoDB not configured - MONGO_URI not set');
        }
        
        try {
            // Build connection options with optional CSFLE
            const clientOptions = await this._buildClientOptions();
            
            this._client = new MongoClient(this.connectionString, clientOptions);
            await this._client.connect();
            
            // Get database - priority: explicit config > URI path > fallback
            // When db() is called without args, it uses the database from the URI
            if (this.databaseName) {
                this._db = this._client.db(this.databaseName);
            } else {
                // Try to get db from URI - client.db() without args uses URI's database
                this._db = this._client.db();
            }
            
            // Verify we have a database name (db() without URI database returns undefined name)
            const dbName = this._db.databaseName || 'cortex';
            if (!this._db.databaseName) {
                this._db = this._client.db('cortex');
            }
            
            this._collection = this._db.collection(this.collectionName);
            this._connected = true;
            
            const encryptionStatus = MONGO_ENCRYPTION_KEY ? 'with CSFLE' : 'without encryption';
            logger.info(`Connected to MongoDB: ${this._db.databaseName}.${this.collectionName} (${encryptionStatus})`);
            return this._collection;
        } catch (error) {
            logger.error(`MongoDB connection failed: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Build MongoClient options with optional CSFLE configuration
     * @private
     * @returns {Promise<Object>}
     */
    async _buildClientOptions() {
        // If no encryption key, return empty options (no CSFLE)
        if (!MONGO_ENCRYPTION_KEY) {
            return {};
        }
        
        try {
            // Import mongodb-client-encryption to ensure it's available
            await import('mongodb-client-encryption');
            
            const keyVaultNamespace = 'encryption.__keyVault';
            const kmsProviders = {
                local: {
                    key: Buffer.from(MONGO_ENCRYPTION_KEY, 'base64'),
                },
            };
            
            // Get the data key UUID
            let dataKeyId;
            if (MONGO_DATAKEY_UUID) {
                // Use provided UUID
                dataKeyId = new UUID(MONGO_DATAKEY_UUID);
                logger.info('CSFLE: Using provided data key UUID');
            } else {
                // Discover existing key from key vault
                dataKeyId = await this._discoverOrCreateDataKey(kmsProviders, keyVaultNamespace);
            }
            
            if (!dataKeyId) {
                logger.warn('CSFLE: No data key available, encryption disabled');
                return {};
            }
            
            // Extract database name from URI for schema map
            const uriPath = new URL(this.connectionString).pathname.split('/').filter(Boolean);
            const dbName = this.databaseName || uriPath[0] || 'cortex';
            
            // Build schema map for continuity_memories collection
            const schemaMap = {
                [`${dbName}.${this.collectionName}`]: {
                    bsonType: 'object',
                    properties: {
                        content: {
                            encrypt: {
                                bsonType: 'string',
                                algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random',
                            },
                        },
                    },
                    encryptMetadata: {
                        keyId: [dataKeyId],
                    },
                },
            };
            
            const autoEncryptionOptions = {
                keyVaultNamespace,
                kmsProviders,
                schemaMap,
            };
            
            // Add crypt shared library path if provided
            if (MONGOCRYPT_PATH) {
                autoEncryptionOptions.extraOptions = {
                    cryptSharedLibPath: MONGOCRYPT_PATH,
                };
            }
            
            logger.info(`CSFLE: Enabled for ${dbName}.${this.collectionName} (content field)`);
            
            return { autoEncryption: autoEncryptionOptions };
        } catch (error) {
            logger.error(`CSFLE setup failed: ${error.message}`);
            logger.warn('Falling back to unencrypted connection');
            return {};
        }
    }
    
    /**
     * Discover existing data key from key vault or create new one
     * @private
     * @param {Object} kmsProviders
     * @param {string} keyVaultNamespace
     * @returns {Promise<UUID|null>}
     */
    async _discoverOrCreateDataKey(kmsProviders, keyVaultNamespace) {
        let tempClient;
        try {
            const { ClientEncryption } = await import('mongodb');
            
            // Create temporary connection to discover/create key
            tempClient = new MongoClient(this.connectionString);
            await tempClient.connect();
            
            const encryption = new ClientEncryption(tempClient, {
                keyVaultNamespace,
                kmsProviders,
            });
            
            // Check for existing keys
            const existingKeys = await encryption.getKeys().toArray();
            
            if (existingKeys && existingKeys.length > 0) {
                logger.info('CSFLE: Using existing data key from key vault');
                return existingKeys[0]._id;
            }
            
            // Create new key if none exists
            logger.info('CSFLE: Creating new data key');
            const newKeyId = await encryption.createDataKey('local');
            return newKeyId;
        } catch (error) {
            logger.error(`CSFLE key discovery/creation failed: ${error.message}`);
            return null;
        } finally {
            if (tempClient) {
                await tempClient.close();
            }
        }
    }
    
    /**
     * Close MongoDB connection
     */
    async close() {
        if (this._client) {
            await this._client.close();
            this._client = null;
            this._db = null;
            this._collection = null;
            this._connected = false;
        }
    }
    
    // ==================== FILTER BUILDING HELPERS ====================
    
    /**
     * Build a base filter for entity and associated entities
     * @private
     * @param {string} entityId
     * @param {string} assocEntityId - Single associated entity ID to filter by
     * @returns {Object}
     */
    _buildBaseFilter(entityId, assocEntityId) {
        // MongoDB array contains: equality on array field matches if array contains the value
        return { entityId, assocEntityIds: assocEntityId };
    }
    
    /**
     * Add type filter to existing filter
     * @private
     * @param {Object} baseFilter
     * @param {string[]} types
     * @returns {Object}
     */
    _addTypeFilter(baseFilter, types) {
        if (!types || types.length === 0) {
            return baseFilter;
        }
        return { ...baseFilter, type: { $in: types } };
    }
    
    /**
     * Add importance filter to existing filter
     * @private
     * @param {Object} baseFilter
     * @param {number} minImportance
     * @returns {Object}
     */
    _addImportanceFilter(baseFilter, minImportance) {
        if (!minImportance) {
            return baseFilter;
        }
        return { ...baseFilter, importance: { $gte: minImportance } };
    }
    
    /**
     * Add date filter to existing filter
     * @private
     * @param {Object} baseFilter
     * @param {string} since - ISO 8601 date string
     * @returns {Object}
     */
    _addDateFilter(baseFilter, since) {
        if (!since) {
            return baseFilter;
        }
        return { ...baseFilter, timestamp: { $gte: since } };
    }
    
    // ==================== SEARCH OPERATIONS ====================
    
    /**
     * Semantic vector search for similar memories
     * Uses Atlas Vector Search with pre-filter
     * @param {string} entityId
     * @param {string} userId
     * @param {string} query - Text query
     * @param {number} [limit=5] - Max results
     * @param {string[]} [types=null] - Optional type filter
     * @param {number[]} [precomputedEmbedding=null] - Optional pre-computed embedding
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async searchSemantic(entityId, userId, query, limit = 5, types = null, precomputedEmbedding = null) {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured for continuity memory');
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            // Use pre-computed embedding if provided, otherwise generate
            const embedding = precomputedEmbedding?.length > 0 
                ? precomputedEmbedding 
                : await this._getEmbedding(query);
            
            if (!embedding || embedding.length === 0) {
                logger.warn('Failed to get embedding for semantic search');
                return [];
            }
            
            // Build pre-filter for vector search
            let preFilter = this._buildBaseFilter(entityId, userId);
            preFilter = this._addTypeFilter(preFilter, types);
            
            // Atlas Vector Search aggregation pipeline
            const pipeline = [
                {
                    $vectorSearch: {
                        index: VECTOR_INDEX_NAME,
                        path: 'contentVector',
                        queryVector: embedding,
                        numCandidates: limit * 10, // Cast a wider net for better results
                        limit: limit * 2, // Fetch more for re-ranking
                        filter: preFilter
                    }
                },
                {
                    $addFields: {
                        // Atlas Vector Search provides score in the 'score' metadata
                        _vectorScore: { $meta: 'vectorSearchScore' }
                    }
                }
            ];
            
            const results = await collection.aggregate(pipeline).toArray();
            
            
            // Re-rank using Luna's decay formula
            const reranked = this._rerankResults(results, embedding);
            
            // Update recall count for top N accessed memories only (fire and forget)
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
            const collection = await this._getCollection();
            
            let filter = this._buildBaseFilter(entityId, userId);
            filter = this._addTypeFilter(filter, options.types);
            filter = this._addImportanceFilter(filter, options.minImportance);
            filter = this._addDateFilter(filter, options.since);
            
            // Add text search if query is provided and not wildcard
            if (query && query !== '*') {
                filter.$text = { $search: query };
            }
            
            const results = await collection
                .find(filter)
                .limit(options.limit || 10)
                .skip(options.skip || 0)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Full-text search failed: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Search all memories with a custom filter (for admin/cleanup operations)
     * @param {Object} filter - MongoDB filter object
     * @param {Object} [options]
     * @param {number} [options.limit=1000] - Max results
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async searchAllWithFilter(filter, options = {}) {
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            const results = await collection
                .find(filter)
                .limit(options.limit || 1000)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
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
     * Upsert a memory node
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @returns {Promise<string>} The memory ID
     */
    async upsertMemory(entityId, userId, memory) {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured - cannot store memory');
            return null;
        }
        
        try {
            const collection = await this._getCollection();
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
                assocEntityIds: [userId],
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
                // MongoDB stores objects natively - no JSON stringification needed
                emotionalState: memory.emotionalState || null,
                relationalContext: memory.relationalContext || null,
                synthesizedFrom: memory.synthesizedFrom || [],
                synthesisType: memory.synthesisType || null
            };
            
            // Upsert by id field
            await collection.updateOne(
                { id },
                { $set: doc },
                { upsert: true }
            );
            
            return id;
        } catch (error) {
            logger.error(`Failed to upsert memory: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Batch upsert multiple memories
     * More efficient than individual upserts for bulk imports
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>[]} memories
     * @returns {Promise<string[]>} Array of memory IDs
     */
    async upsertMemories(entityId, userId, memories) {
        if (!this.isConfigured() || memories.length === 0) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            const now = new Date().toISOString();
            const ids = [];
            
            // Build bulk operations
            const operations = memories.map(memory => {
                const id = memory.id || uuidv4();
                ids.push(id);
                
                const doc = {
                    id,
                    entityId,
                    assocEntityIds: [userId],
                    type: memory.type || ContinuityMemoryType.ANCHOR,
                    content: memory.content || '',
                    contentVector: memory.contentVector || [],
                    relatedMemoryIds: memory.relatedMemoryIds || [],
                    parentMemoryId: memory.parentMemoryId || null,
                    tags: memory.tags || [],
                    timestamp: memory.timestamp || now,
                    lastAccessed: now,
                    recallCount: memory.recallCount || 0,
                    importance: memory.importance ?? 5,
                    confidence: memory.confidence ?? 0.8,
                    decayRate: memory.decayRate ?? 0.1,
                    emotionalState: memory.emotionalState || null,
                    relationalContext: memory.relationalContext || null,
                    synthesizedFrom: memory.synthesizedFrom || [],
                    synthesisType: memory.synthesisType || null
                };
                
                return {
                    updateOne: {
                        filter: { id },
                        update: { $set: doc },
                        upsert: true
                    }
                };
            });
            
            // Execute bulk write
            await collection.bulkWrite(operations, { ordered: false });
            
            return ids;
        } catch (error) {
            logger.error(`Batch upsert failed: ${error.message}`);
            return [];
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
            const collection = await this._getCollection();
            
            const results = await collection
                .find({ id: { $in: ids } })
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
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
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getByType(entityId, userId, type, limit = 50, options = {}) {
        try {
            const collection = await this._getCollection();
            
            const results = await collection
                .find({ entityId, assocEntityIds: userId, type })
                .sort({ importance: -1, lastAccessed: -1 })
                .limit(limit)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get memories by type: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get top memories by importance (not query-dependent)
     * Used for bootstrap context
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getTopByImportance(entityId, userId, options = {}) {
        const { types = null, limit = 10, minImportance = 5 } = options;
        
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            let filter = this._buildBaseFilter(entityId, userId);
            filter = this._addTypeFilter(filter, types);
            filter = this._addImportanceFilter(filter, minImportance);
            
            const results = await collection
                .find(filter)
                .sort({ importance: -1, timestamp: -1 })
                .limit(limit)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get top memories by importance: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get unprocessed memories for sleep synthesis
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getUnprocessedMemories(entityId, userId, options = {}) {
        const { limit = 20, skip = 0, since = null, orderBy = 'timestamp desc' } = options;
        
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            let filter = this._buildBaseFilter(entityId, userId);
            filter.tags = { $nin: ['sleep-processed'] };
            
            if (since) {
                filter.timestamp = { $gte: since };
            }
            
            // Parse orderBy to MongoDB sort
            const sort = this._parseOrderBy(orderBy);
            
            const results = await collection
                .find(filter)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get unprocessed memories: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Mark a memory as processed by adding the 'sleep-processed' tag
     * @param {string} memoryId
     * @returns {Promise<boolean>}
     */
    async markAsProcessed(memoryId) {
        try {
            const collection = await this._getCollection();
            
            await collection.updateOne(
                { id: memoryId },
                { $addToSet: { tags: 'sleep-processed' } }
            );
            
            return true;
        } catch (error) {
            logger.error(`Failed to mark memory as processed: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Get count of unprocessed memories
     * @param {string} entityId
     * @param {string} userId
     * @param {string} [since]
     * @returns {Promise<number>}
     */
    async getUnprocessedCount(entityId, userId, since = null) {
        if (!this.isConfigured()) {
            return 0;
        }
        
        try {
            const collection = await this._getCollection();
            
            let filter = this._buildBaseFilter(entityId, userId);
            filter.tags = { $nin: ['sleep-processed'] };
            
            if (since) {
                filter.timestamp = { $gte: since };
            }
            
            return await collection.countDocuments(filter);
        } catch (error) {
            logger.error(`Failed to get unprocessed count: ${error.message}`);
            return 0;
        }
    }
    
    /**
     * Get promotion candidates - IDENTITY memories with promotion-candidate tag
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getPromotionCandidates(entityId, userId, options = {}) {
        const { limit = 100 } = options;
        
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            const results = await collection
                .find({
                    entityId,
                    assocEntityIds: userId,
                    type: 'IDENTITY',
                    tags: 'promotion-candidate'
                })
                .sort({ timestamp: 1 }) // Oldest first
                .limit(limit)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get promotion candidates: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get all CORE_EXTENSION memories for deduplication checks
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getCoreExtensions(entityId, userId, options = {}) {
        const { limit = 100 } = options;
        
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            const results = await collection
                .find({ entityId, assocEntityIds: userId, type: 'CORE_EXTENSION' })
                .sort({ importance: -1 })
                .limit(limit)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get CORE_EXTENSION memories: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Promote a memory to CORE_EXTENSION type
     * @param {string} memoryId
     * @returns {Promise<boolean>}
     */
    async promoteToCore(memoryId) {
        if (!this.isConfigured()) {
            return false;
        }
        
        try {
            const collection = await this._getCollection();
            
            // Fetch the existing memory
            const memory = await collection.findOne({ id: memoryId });
            if (!memory) {
                logger.warn(`Cannot promote memory ${memoryId}: not found`);
                return false;
            }
            
            // Update type and tags
            const updatedTags = (memory.tags || [])
                .filter(t => t !== 'promotion-candidate' && !t.startsWith('nominated-'))
                .concat(['promoted', 'identity-hardened']);
            
            await collection.updateOne(
                { id: memoryId },
                {
                    $set: {
                        type: 'CORE_EXTENSION',
                        tags: updatedTags,
                        importance: Math.max(memory.importance || 5, 8)
                    }
                }
            );
            
            logger.info(`Promoted memory ${memoryId} to CORE_EXTENSION`);
            return true;
        } catch (error) {
            logger.error(`Failed to promote memory ${memoryId}: ${error.message}`);
            return false;
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
            const collection = await this._getCollection();
            const count = await collection.countDocuments({ entityId, assocEntityIds: userId }, { limit: 1 });
            return count > 0;
        } catch (error) {
            logger.error(`Failed to check for memories: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Delete a memory
     * @param {string} id
     */
    async deleteMemory(id) {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured - cannot delete memory');
            return;
        }
        
        try {
            const collection = await this._getCollection();
            await collection.deleteOne({ id });
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
        
        try {
            const collection = await this._getCollection();
            await collection.deleteMany({ id: { $in: ids } });
        } catch (error) {
            logger.error(`Batch delete failed: ${error.message}`);
        }
    }
    
    /**
     * Cascading delete for "forget me" requests
     * @param {string} entityId
     * @param {string} userId
     */
    async cascadingForget(entityId, userId) {
        try {
            const collection = await this._getCollection();
            
            // Get all memories associated with this entity
            const allMemories = await collection.find({ entityId, assocEntityIds: userId }).toArray();
            
            const toDelete = [];
            const toAnonymize = [];
            
            for (const memory of allMemories) {
                if (memory.type === ContinuityMemoryType.ANCHOR) {
                    toDelete.push(memory.id);
                } else if (memory.synthesizedFrom && memory.synthesizedFrom.length > 0) {
                    toAnonymize.push(memory);
                } else {
                    toDelete.push(memory.id);
                }
            }
            
            // Batch delete
            if (toDelete.length > 0) {
                await collection.deleteMany({ id: { $in: toDelete } });
            }
            
            // Anonymize synthesized artifacts
            for (const memory of toAnonymize) {
                await collection.updateOne(
                    { id: memory.id },
                    {
                        $set: {
                            assocEntityIds: ['anonymized'],
                            synthesizedFrom: [],
                            relationalContext: null,
                            emotionalState: null
                        }
                    }
                );
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
            const collection = await this._getCollection();
            
            // Add bidirectional links using atomic operations
            await Promise.all([
                collection.updateOne(
                    { id: memoryId1 },
                    { $addToSet: { relatedMemoryIds: memoryId2 } }
                ),
                collection.updateOne(
                    { id: memoryId2 },
                    { $addToSet: { relatedMemoryIds: memoryId1 } }
                )
            ]);
        } catch (error) {
            logger.error(`Failed to link memories: ${error.message}`);
        }
    }
    
    /**
     * Get total memory count for an entity/user
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<number>}
     */
    async getMemoryCount(entityId, userId) {
        try {
            const collection = await this._getCollection();
            return await collection.countDocuments({ entityId, assocEntityIds: userId });
        } catch (error) {
            logger.error(`Failed to get memory count: ${error.message}`);
            return 0;
        }
    }
    
    /**
     * Get all memories for export
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getAllMemories(entityId, userId, options = {}) {
        const { limit = 10000 } = options;
        
        try {
            const collection = await this._getCollection();
            
            const results = await collection
                .find({ entityId, assocEntityIds: userId })
                .limit(limit)
                .toArray();
            
            return results.map(m => this._deserializeMemory(m));
        } catch (error) {
            logger.error(`Failed to get all memories: ${error.message}`);
            return [];
        }
    }
    
    // ==================== PRIVATE HELPERS ====================
    
    /**
     * Generate embedding for text
     * @private
     */
    async _getEmbedding(text) {
        try {
            const response = await callPathway('embeddings', { 
                text,
                model: 'oai-text-embedding-3-small'
            });
            const embeddings = JSON.parse(response);
            return embeddings[0] || [];
        } catch (error) {
            logger.warn(`Failed to generate embedding: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Increment recall count for a memory (debounced)
     * @private
     */
    async _incrementRecallCount(id) {
        try {
            const collection = await this._getCollection();
            
            const memory = await collection.findOne({ id });
            if (!memory) return;
            
            const now = Date.now();
            
            // Check if we should debounce this update
            if (memory.lastAccessed) {
                const lastAccessedTime = new Date(memory.lastAccessed).getTime();
                if (now - lastAccessedTime < RECALL_UPDATE_DEBOUNCE_MS) {
                    return; // Skip - accessed recently
                }
            }
            
            await collection.updateOne(
                { id },
                {
                    $inc: { recallCount: 1 },
                    $set: { lastAccessed: new Date().toISOString() }
                }
            );
        } catch {
            // Silently fail - this is a best-effort operation
        }
    }
    
    /**
     * Re-rank results using Luna's decay formula
     * @private
     */
    _rerankResults(results, queryEmbedding = null) {
        if (!results || results.length === 0) {
            return [];
        }
        
        return results
            .map(result => {
                const deserialized = this._deserializeMemory(result);
                
                // Use the vector score from Atlas, or calculate if we have embeddings
                let vectorScore = deserialized._vectorScore || 0;
                
                if (queryEmbedding && deserialized.contentVector && Array.isArray(deserialized.contentVector)) {
                    const trueSimilarity = this._cosineSimilarity(queryEmbedding, deserialized.contentVector);
                    if (trueSimilarity > 0) {
                        vectorScore = trueSimilarity;
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
                    _vectorScore: Math.min(1, Math.max(0, vectorScore))
                };
            })
            .sort((a, b) => b._recallScore - a._recallScore);
    }
    
    /**
     * Calculate cosine similarity between two vectors
     * @private
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
     * Deserialize memory from MongoDB
     * @private
     */
    _deserializeMemory(memory) {
        if (!memory) return memory;
        
        // Remove MongoDB's internal _id if present
        const { _id, ...result } = memory;
        return result;
    }
    
    /**
     * Parse orderBy string to MongoDB sort object
     * @private
     * @param {string} orderBy - e.g., "timestamp desc" or "importance desc, timestamp asc"
     * @returns {Object}
     */
    _parseOrderBy(orderBy) {
        const sort = {};
        const parts = orderBy.split(',').map(p => p.trim());
        
        for (const part of parts) {
            const [field, direction] = part.split(' ');
            sort[field] = direction?.toLowerCase() === 'asc' ? 1 : -1;
        }
        
        return sort;
    }
}

export default MongoMemoryIndex;

