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
 * - createdAt: Date
 * - updatedAt: Date
 */

import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';
import logger from './logger.js';

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
     * @returns {Promise<Object[]>}
     */
    async getAllEntities() {
        // Return from cache if loaded
        if (this._cacheLoaded) {
            const entities = [];
            const seenIds = new Set();
            
            for (const entity of this._entityCache.values()) {
                if (entity.id && !seenIds.has(entity.id)) {
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
            const entities = await collection.find({}).toArray();
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
     * Create or update an entity
     * @param {Object} entity - Entity data
     * @param {string} [entity.id] - UUID (generated if not provided)
     * @param {string} entity.name - Human-readable name
     * @param {boolean} [entity.isDefault] - Default entity flag
     * @param {boolean} [entity.useMemory] - Enable memory
     * @param {string} [entity.memoryBackend] - Memory backend type
     * @param {string} [entity.description] - Entity description
     * @param {string} [entity.identity] - Core identity/persona
     * @param {string[]} [entity.tools] - Tool access list
     * @param {Object[]} [entity.resources] - Attached resources
     * @param {Object} [entity.customTools] - Custom tool definitions
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
                useMemory: entity.useMemory ?? true,
                memoryBackend: entity.memoryBackend || 'continuity',
                description: entity.description || '',
                identity: entity.identity || entity.instructions || '', // Support both field names
                avatar: entity.avatar || null, // Optional: { text, image: {url, gcs, name}, video: {url, gcs, name} }
                tools: entity.tools || ['*'],
                resources: entity.resources || entity.files || [], // Support both field names
                customTools: entity.customTools || {},
                createdAt: entity.createdAt || now,
                updatedAt: now
            };
            
            // If setting as default, unset other defaults first
            if (doc.isDefault) {
                await collection.updateMany(
                    { isDefault: true, id: { $ne: id } },
                    { $set: { isDefault: false } }
                );
            }
            
            // Upsert by id
            await collection.updateOne(
                { id },
                { $set: doc, $setOnInsert: { createdAt: now } },
                { upsert: true }
            );
            
            // Update cache
            this._entityCache.set(id, doc);
            if (doc.name) {
                this._entityCache.set(doc.name.toLowerCase(), doc);
            }
            
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
