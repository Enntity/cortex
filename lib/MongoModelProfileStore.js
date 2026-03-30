import { MongoClient } from 'mongodb';
import logger from './logger.js';

const DEFAULT_COLLECTION = 'modelprofiles';

let instance = null;

function resolveDatabaseName(connectionString = '') {
    try {
        const url = new URL(connectionString);
        const pathname = url.pathname.split('/').filter(Boolean);
        return pathname[0] || process.env.MONGO_DB_NAME || 'concierge';
    } catch {
        return process.env.MONGO_DB_NAME || 'concierge';
    }
}

export class MongoModelProfileStore {
    constructor({ collectionName = DEFAULT_COLLECTION, databaseName = null } = {}) {
        this.collectionName = collectionName;
        this.databaseName = databaseName;
        this.connectionString = process.env.MONGO_URI || '';

        this._client = null;
        this._db = null;
        this._collection = null;
        this._connected = false;

        this._cache = new Map();
        this._cacheTimestamps = new Map();
        this._cacheTTL = 10000;
    }

    static getInstance(options = {}) {
        if (!instance) {
            instance = new MongoModelProfileStore(options);
        }
        return instance;
    }

    isConfigured() {
        return !!this.connectionString;
    }

    async _getCollection() {
        if (this._collection && this._connected) {
            return this._collection;
        }

        if (!this.isConfigured()) {
            throw new Error('MongoDB not configured - MONGO_URI not set');
        }

        this._client = new MongoClient(this.connectionString);
        await this._client.connect();

        this._db = this.databaseName
            ? this._client.db(this.databaseName)
            : this._client.db(resolveDatabaseName(this.connectionString));
        this._collection = this._db.collection(this.collectionName);
        this._connected = true;

        logger.info(`Connected to MongoDB model profiles: ${this._db.databaseName}.${this.collectionName}`);
        return this._collection;
    }

    async getProfileBySlug(slug, { fresh = false } = {}) {
        if (!slug) return null;

        const cachedAt = this._cacheTimestamps.get(slug);
        if (!fresh && cachedAt && (Date.now() - cachedAt) < this._cacheTTL) {
            return this._cache.get(slug) || null;
        }

        try {
            const collection = await this._getCollection();
            const profile = await collection.findOne({ slug });
            const normalized = profile
                ? {
                    ...profile,
                    id: profile._id?.toString?.() || profile.id || slug,
                    slug: profile.slug,
                    modelPolicy: profile.modelPolicy || {},
                }
                : null;

            this._cache.set(slug, normalized);
            this._cacheTimestamps.set(slug, Date.now());
            return normalized;
        } catch (error) {
            logger.warn(`Failed to load model profile "${slug}" from MongoDB: ${error.message}`);
            return null;
        }
    }
}

export function getModelProfileStore(options = {}) {
    return MongoModelProfileStore.getInstance(options);
}
