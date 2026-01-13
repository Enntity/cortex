/**
 * MongoDB Entity Store
 * 
 * Manages entity configurations in MongoDB with UUID-based identifiers.
 * Entities define AI personas with their identity, tools, and resources.
 * 
 * Schema:
 * - id: UUID (primary identifier)
 * - name: String (human-readable name, e.g., "Labeeb", "Jarvis")
 * - isDefault: Boolean (default entity for this deployment)
 * - isSystem: Boolean (system entity - hidden from normal entity lists, e.g., "Enntity")
 * - useMemory: Boolean (enable memory systems)
 * - memoryBackend: String ("continuity" or "legacy")
 * - description: String (entity description for display)
 * - identity: String (core identity/persona - renamed from "instructions")
 * - avatar: Object (optional visual representation)
 *   - text: String (optional - text/emoji representation)
 *   - image: Object (optional - { url, gcs, name })
 *   - video: Object (optional - { url, gcs, name })
 * - tools: [String] (tool names or ["*"] for all)
 * - resources: [{ url, gcs, name, type }] (attached media/documents)
 * - customTools: Object (entity-specific tool definitions)
 * - assocUserIds: [String] (user IDs associated with this entity - for private entities)
 * - createdBy: String (userId who created this entity)
 * - baseModel: String (optional - base model for the entity, e.g., "gemini-flash-3-vision")
 * - reasoningEffort: String (optional - reasoning effort level, e.g., "high", "low")
 * - createdAt: Date
 * - updatedAt: Date
 */

import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';
import logger from './logger.js';
import { config } from '../config.js';

// Default collection name
const DEFAULT_COLLECTION = 'entities';

/**
 * Singleton instance
 * @type {MongoEntityStore|null}
 */
let instance = null;

export class MongoEntityStore {
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
        
        // Cache for entities (loaded on startup)
        this._entityCache = new Map();
        this._cacheLoaded = false;
    }
    
    /**
     * Get or create singleton instance
     * @param {Object} [options]
     * @returns {MongoEntityStore}
     */
    static getInstance(options = {}) {
        if (!instance) {
            instance = new MongoEntityStore(options);
        }
        return instance;
    }
    
    /**
     * Check if MongoDB is configured
     * @returns {boolean}
     */
    isConfigured() {
        return !!this.connectionString;
    }
    
    /**
     * Get or create MongoDB connection
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
            // Use default connection options - mongodb+srv:// automatically handles TLS
            // No explicit TLS options needed (same approach as concierge)
            this._client = new MongoClient(this.connectionString);
            await this._client.connect();
            
            // Get database - priority: explicit config > URI path > fallback
            if (this.databaseName) {
                this._db = this._client.db(this.databaseName);
            } else {
                this._db = this._client.db();
            }
            
            // Verify we have a database name
            if (!this._db.databaseName) {
                this._db = this._client.db('cortex');
            }
            
            this._collection = this._db.collection(this.collectionName);
            this._connected = true;
            
            logger.info(`Connected to MongoDB entities: ${this._db.databaseName}.${this.collectionName}`);
            return this._collection;
        } catch (error) {
            logger.error(`MongoDB entity store connection failed: ${error.message}`);
            throw error;
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
        this._entityCache.clear();
        this._cacheLoaded = false;
    }
    
    // ==================== ENTITY CRUD OPERATIONS ====================
    
    /**
     * Load all entities into cache (called on startup)
     * @returns {Promise<Object>} Entity config object keyed by UUID
     */
    async loadAllEntities() {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured - entities will not be available');
            return null;
        }
        
        try {
            const collection = await this._getCollection();
            const entities = await collection.find({}).toArray();
            
            // Build cache keyed by UUID
            const entityConfig = {};
            
            for (const entity of entities) {
                const { _id, ...entityData } = entity;
                
                // Cache by UUID only
                this._entityCache.set(entity.id, entityData);
                
                // Config object keyed by UUID
                entityConfig[entity.id] = entityData;
            }
            
            this._cacheLoaded = true;
            logger.info(`Loaded ${entities.length} entities from MongoDB`);
            
            return entityConfig;
        } catch (error) {
            logger.error(`Failed to load entities from MongoDB: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Get entity by UUID
     * @param {string} entityId - Entity UUID
     * @returns {Promise<Object|null>}
     */
    async getEntity(entityId) {
        if (!entityId) return null;
        
        // Check cache first
        if (this._cacheLoaded && this._entityCache.has(entityId)) {
            return this._entityCache.get(entityId);
        }
        
        if (!this.isConfigured()) {
            return null;
        }
        
        try {
            const collection = await this._getCollection();
            
            // Find by UUID only
            const entity = await collection.findOne({ id: entityId });
            
            if (entity) {
                const { _id, ...entityData } = entity;
                // Update cache
                this._entityCache.set(entity.id, entityData);
                return entityData;
            }
            
            return null;
        } catch (error) {
            logger.error(`Failed to get entity ${entityId}: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Get the default entity
     * @returns {Promise<Object|null>}
     */
    async getDefaultEntity() {
        // Check cache first
        if (this._cacheLoaded) {
            for (const entity of this._entityCache.values()) {
                if (entity.isDefault) return entity;
            }
        }
        
        if (!this.isConfigured()) {
            return null;
        }
        
        try {
            const collection = await this._getCollection();
            const entity = await collection.findOne({ isDefault: true });
            
            if (entity) {
                const { _id, ...entityData } = entity;
                return entityData;
            }
            
            // Fall back to first entity if no default
            const firstEntity = await collection.findOne({});
            if (firstEntity) {
                const { _id, ...entityData } = firstEntity;
                return entityData;
            }
            
            return null;
        } catch (error) {
            logger.error(`Failed to get default entity: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Get all entities (for sys_get_entities)
     * @param {Object} [options]
     * @param {boolean} [options.includeSystem=false] - Include system entities (like Enntity)
     * @param {string} [options.userId] - Filter to entities associated with this user
     * @returns {Promise<Object[]>}
     */
    async getAllEntities(options = {}) {
        const { includeSystem = false, userId } = options;
        
        // Return from cache if loaded
        if (this._cacheLoaded) {
            const entities = [];
            const seenIds = new Set();
            
            for (const entity of this._entityCache.values()) {
                if (entity.id && !seenIds.has(entity.id)) {
                    // Filter out system entities unless requested
                    if (!includeSystem && entity.isSystem) {
                        continue;
                    }
                    // Filter by userId if provided
                    // System entities: always included
                    // Non-system entities: must have userId in assocUserIds array
                    if (userId) {
                        if (entity.isSystem) {
                            // System entities are always accessible
                        } else {
                            // Non-system entities must have userId in assocUserIds
                            const hasValidAssocUserIds = entity.assocUserIds && 
                                                        Array.isArray(entity.assocUserIds) && 
                                                        entity.assocUserIds.length > 0;
                            if (!hasValidAssocUserIds || !entity.assocUserIds.includes(userId)) {
                                continue; // Skip this entity
                            }
                        }
                    }
                    seenIds.add(entity.id);
                    entities.push(entity);
                }
            }
            return entities;
        }
        
        if (!this.isConfigured()) {
            return [];
        }
        
        try {
            const collection = await this._getCollection();
            
            // Build query
            const query = {};
            if (!includeSystem) {
                query.isSystem = { $ne: true };
            }
            if (userId) {
                // For system entities, no assocUserIds check needed
                // For non-system entities, must have userId in assocUserIds array
                query.$or = [
                    { isSystem: true }, // System entities always accessible
                    { 
                        isSystem: { $ne: true },
                        assocUserIds: { 
                            $exists: true,
                            $ne: [],
                            $in: [userId]
                        }
                    }
                ];
            }
            
            const entities = await collection.find(query).toArray();
            return entities.map(e => {
                const { _id, ...entityData } = e;
                return entityData;
            });
        } catch (error) {
            logger.error(`Failed to get all entities: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get system entity by name (for special entities like "Enntity")
     * @param {string} name - System entity name
     * @returns {Promise<Object|null>}
     */
    async getSystemEntity(name) {
        // Check cache first
        if (this._cacheLoaded) {
            for (const entity of this._entityCache.values()) {
                if (entity.isSystem && entity.name?.toLowerCase() === name.toLowerCase()) {
                    return entity;
                }
            }
        }
        
        if (!this.isConfigured()) {
            return null;
        }
        
        try {
            const collection = await this._getCollection();
            const entity = await collection.findOne({ 
                name: { $regex: new RegExp(`^${name}$`, 'i') },
                isSystem: true 
            });
            
            if (entity) {
                const { _id, ...entityData } = entity;
                // Update cache
                this._entityCache.set(entity.id, entityData);
                return entityData;
            }
            
            return null;
        } catch (error) {
            logger.error(`Failed to get system entity ${name}: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Get entities for a specific user
     * @param {string} userId - User ID
     * @returns {Promise<Object[]>}
     */
    async getEntitiesForUser(userId) {
        return this.getAllEntities({ userId, includeSystem: false });
    }
    
    /**
     * Add a user association to an entity
     * @param {string} entityId - Entity UUID
     * @param {string} userId - User ID to associate
     * @returns {Promise<boolean>}
     */
    async addUserToEntity(entityId, userId) {
        if (!this.isConfigured() || !entityId || !userId) {
            return false;
        }
        
        try {
            const collection = await this._getCollection();
            
            await collection.updateOne(
                { id: entityId },
                { 
                    $addToSet: { assocUserIds: userId },
                    $set: { updatedAt: new Date() }
                }
            );
            
            // Update both caches to keep them in sync
            // 1. Update MongoEntityStore cache
            if (this._entityCache.has(entityId)) {
                const entity = this._entityCache.get(entityId);
                entity.assocUserIds = entity.assocUserIds || [];
                if (!entity.assocUserIds.includes(userId)) {
                    entity.assocUserIds.push(userId);
                }
            }
            
            // 2. Update global config cache (used by getAvailableEntities)
            const entityConfig = config.get('entityConfig') || {};
            if (entityConfig[entityId]) {
                const entity = entityConfig[entityId];
                entity.assocUserIds = entity.assocUserIds || [];
                if (!entity.assocUserIds.includes(userId)) {
                    entity.assocUserIds.push(userId);
                    config.set('entityConfig', entityConfig);
                    logger.debug(`Updated global config cache for entity ${entityId}`);
                }
            }
            
            logger.info(`Added user ${userId} to entity ${entityId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to add user to entity: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Remove a user association from an entity
     * @param {string} entityId - Entity UUID
     * @param {string} userId - User ID to disassociate
     * @returns {Promise<boolean>}
     */
    async removeUserFromEntity(entityId, userId) {
        if (!this.isConfigured() || !entityId || !userId) {
            return false;
        }
        
        try {
            const collection = await this._getCollection();
            
            await collection.updateOne(
                { id: entityId },
                { 
                    $pull: { assocUserIds: userId },
                    $set: { updatedAt: new Date() }
                }
            );
            
            // Update both caches to keep them in sync
            // 1. Update MongoEntityStore cache
            if (this._entityCache.has(entityId)) {
                const entity = this._entityCache.get(entityId);
                if (entity.assocUserIds && Array.isArray(entity.assocUserIds)) {
                    entity.assocUserIds = entity.assocUserIds.filter(id => id !== userId);
                }
            }
            
            // 2. Update global config cache (used by getAvailableEntities)
            const entityConfig = config.get('entityConfig') || {};
            if (entityConfig[entityId]) {
                const entity = entityConfig[entityId];
                if (entity.assocUserIds && Array.isArray(entity.assocUserIds)) {
                    entity.assocUserIds = entity.assocUserIds.filter(id => id !== userId);
                    config.set('entityConfig', entityConfig);
                    logger.debug(`Updated global config cache for entity ${entityId}`);
                }
            }
            
            logger.info(`Removed user ${userId} from entity ${entityId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to remove user from entity: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Create or update an entity
     * @param {Object} entity - Entity data
     * @param {string} [entity.id] - UUID (generated if not provided)
     * @param {string} entity.name - Human-readable name
     * @param {boolean} [entity.isDefault] - Default entity flag
     * @param {boolean} [entity.isSystem] - System entity flag (hidden from normal lists)
     * @param {boolean} [entity.useMemory] - Enable memory
     * @param {string} [entity.memoryBackend] - Memory backend type
     * @param {string} [entity.description] - Entity description
     * @param {string} [entity.identity] - Core identity/persona
     * @param {string[]} [entity.tools] - Tool access list
     * @param {Object[]} [entity.resources] - Attached resources
     * @param {Object} [entity.customTools] - Custom tool definitions
     * @param {string[]} [entity.assocUserIds] - Associated user IDs
     * @param {string} [entity.createdBy] - User who created this entity
     * @returns {Promise<string|null>} Entity ID
     */
    async upsertEntity(entity) {
        if (!this.isConfigured()) {
            logger.warn('MongoDB not configured - cannot store entity');
            return null;
        }
        
        try {
            const collection = await this._getCollection();
            const now = new Date();
            
            // Generate UUID if not provided
            const id = entity.id || uuidv4();
            
            const doc = {
                id,
                name: entity.name || 'Unnamed Entity',
                isDefault: entity.isDefault ?? false,
                isSystem: entity.isSystem ?? false,
                useMemory: entity.useMemory ?? true,
                memoryBackend: entity.memoryBackend || 'continuity',
                description: entity.description || '',
                identity: entity.identity || entity.instructions || '', // Support both field names
                avatar: entity.avatar || null, // Optional: { text, image: {url, gcs, name}, video: {url, gcs, name} }
                tools: entity.tools || ['*'],
                resources: entity.resources || entity.files || [], // Support both field names
                customTools: entity.customTools || {},
                assocUserIds: entity.assocUserIds || [],
                createdBy: entity.createdBy || null,
                baseModel: entity.baseModel || null, // Optional: base model for the entity
                reasoningEffort: entity.reasoningEffort || null, // Optional: reasoning effort level
                updatedAt: now
                // Note: createdAt is handled separately via $setOnInsert
            };
            
            // If setting as default, unset other defaults first
            if (doc.isDefault) {
                await collection.updateMany(
                    { isDefault: true, id: { $ne: id } },
                    { $set: { isDefault: false } }
                );
            }
            
            // Check if entity exists to preserve createdAt on updates
            const existingEntity = this._entityCache.get(id) || await this.getEntity(id);
            const createdAt = existingEntity?.createdAt || entity.createdAt || now;
            
            // Upsert by id
            // $setOnInsert only sets createdAt on insert (not update)
            // $set updates all fields including updatedAt on both insert and update
            await collection.updateOne(
                { id },
                { 
                    $set: doc,
                    $setOnInsert: { createdAt }
                },
                { upsert: true }
            );
            
            // Update cache (preserve existing createdAt on updates)
            const cachedDoc = {
                ...doc,
                createdAt
            };
            this._entityCache.set(id, cachedDoc);
            
            logger.info(`Upserted entity: ${doc.name} (${id})`);
            return id;
        } catch (error) {
            logger.error(`Failed to upsert entity: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Delete an entity by UUID
     * @param {string} entityId - Entity UUID
     * @returns {Promise<boolean>}
     */
    async deleteEntity(entityId) {
        if (!this.isConfigured() || !entityId) {
            return false;
        }
        
        try {
            const collection = await this._getCollection();
            
            // Get entity for logging
            const entity = await this.getEntity(entityId);
            if (!entity) {
                return false;
            }
            
            await collection.deleteOne({ id: entityId });
            
            // Remove from cache
            this._entityCache.delete(entityId);
            
            logger.info(`Deleted entity: ${entity.name} (${entityId})`);
            return true;
        } catch (error) {
            logger.error(`Failed to delete entity: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Invalidate cache (force reload on next access)
     */
    invalidateCache() {
        this._entityCache.clear();
        this._cacheLoaded = false;
    }
    
    /**
     * Check if entities exist in MongoDB
     * @returns {Promise<boolean>}
     */
    async hasEntities() {
        if (!this.isConfigured()) {
            return false;
        }
        
        try {
            const collection = await this._getCollection();
            const count = await collection.countDocuments({}, { limit: 1 });
            return count > 0;
        } catch (error) {
            return false;
        }
    }
}

/**
 * Get singleton instance
 * @param {Object} [options]
 * @returns {MongoEntityStore}
 */
export function getEntityStore(options = {}) {
    return MongoEntityStore.getInstance(options);
}

export default MongoEntityStore;
