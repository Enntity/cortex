/**
 * Encrypted Redis Client
 *
 * Provides system-level encryption for Redis operations via redisEncryptionKey.
 * Used by RedisHotMemory (via createEncryptedClient) and code help pathways (via getClient).
 */

import Redis from 'ioredis';
import { encrypt, decrypt } from './crypto.js';
import { config } from '../config.js';
import logger from './logger.js';

let systemKey = null;
let storageConnectionString = null;

try {
    systemKey = config.get('redisEncryptionKey') || null;
    storageConnectionString = config.get('storageConnectionString') || null;
} catch {
    // Config not available
}

// Singleton Redis client
let client = null;

/**
 * Get or create the Redis client
 */
function getClient() {
    if (client) return client;
    if (!storageConnectionString) return null;
    
    try {
        client = new Redis(storageConnectionString, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            lazyConnect: false,
            connectTimeout: 10000
        });
        
        client.on('error', (error) => {
            logger.error(`EncryptedRedisClient error: ${error.message}`);
        });
        
        return client;
    } catch (error) {
        logger.error(`Failed to create Redis client: ${error.message}`);
        return null;
    }
}

// ==================== ENCRYPTION HELPERS ====================

/**
 * System-level encrypt only (for hot memory where user encryption is separate)
 */
function systemEncrypt(value) {
    if (!systemKey || value === null || value === undefined || value === '') {
        return value;
    }
    return encrypt(value, systemKey) ?? value;
}

/**
 * System-level decrypt only (for hot memory where user encryption is separate)
 */
function systemDecrypt(value) {
    if (!systemKey || value === null || value === undefined || value === '') {
        return value;
    }
    return decrypt(value, systemKey) ?? value;
}

// ==================== RAW CLIENT WRAPPER (for hot memory) ====================

/**
 * Create an encrypted wrapper around an ioredis client.
 * Handles system-level encryption only (user-level done at application layer).
 * 
 * @param {Redis} rawClient - ioredis client instance
 * @returns {Object} Wrapped client with encrypted operations
 */
function createEncryptedClient(rawClient) {
    if (!rawClient) return null;
    
    return {
        // Expose the underlying client for operations that don't need encryption
        _raw: rawClient,
        
        // Pass through status and event methods
        get status() { return rawClient.status; },
        on: (...args) => rawClient.on(...args),
        once: (...args) => rawClient.once(...args),
        removeListener: (...args) => rawClient.removeListener(...args),
        disconnect: () => rawClient.disconnect(),
        
        // ==================== STRING OPERATIONS ====================
        
        async get(key) {
            const value = await rawClient.get(key);
            return systemDecrypt(value);
        },
        
        async set(key, value, ...args) {
            return rawClient.set(key, systemEncrypt(value), ...args);
        },
        
        async setex(key, ttl, value) {
            return rawClient.setex(key, ttl, systemEncrypt(value));
        },
        
        // ==================== LIST OPERATIONS ====================
        
        async lrange(key, start, stop) {
            const items = await rawClient.lrange(key, start, stop);
            return items.map(item => systemDecrypt(item));
        },
        
        async rpush(key, ...values) {
            const encrypted = values.map(v => systemEncrypt(v));
            return rawClient.rpush(key, ...encrypted);
        },
        
        async ltrim(key, start, stop) {
            return rawClient.ltrim(key, start, stop);
        },
        
        // ==================== HASH OPERATIONS ====================
        
        async hgetall(key) {
            const data = await rawClient.hgetall(key);
            if (!data) return data;
            const result = {};
            for (const [field, value] of Object.entries(data)) {
                result[field] = systemDecrypt(value);
            }
            return result;
        },
        
        async hget(key, field) {
            const value = await rawClient.hget(key, field);
            return systemDecrypt(value);
        },
        
        async hset(key, ...args) {
            // hset can be called as hset(key, field, value) or hset(key, {field: value, ...})
            if (args.length === 1 && typeof args[0] === 'object') {
                const encrypted = {};
                for (const [field, value] of Object.entries(args[0])) {
                    encrypted[field] = systemEncrypt(value);
                }
                return rawClient.hset(key, encrypted);
            } else if (args.length === 2) {
                return rawClient.hset(key, args[0], systemEncrypt(args[1]));
            }
            return rawClient.hset(key, ...args);
        },
        
        // ==================== KEY OPERATIONS (no encryption needed) ====================
        
        async del(key) {
            return rawClient.del(key);
        },
        
        async expire(key, ttl) {
            return rawClient.expire(key, ttl);
        },
        
        async exists(key) {
            return rawClient.exists(key);
        },
        
        async keys(pattern) {
            return rawClient.keys(pattern);
        }
    };
}

export {
    createEncryptedClient,
    systemEncrypt,
    systemDecrypt,
    getClient
};
