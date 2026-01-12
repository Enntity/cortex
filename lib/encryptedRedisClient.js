/**
 * Encrypted Redis Client
 * 
 * Provides double-layer encryption for Redis operations:
 * - System-level: Uses redisEncryptionKey (transparent at driver level)
 * - User-level: Uses contextKey from registry (looked up by userId)
 * 
 * Replaces keyv for simpler, centralized Redis access with encryption.
 */

import Redis from 'ioredis';
import { encrypt, decrypt } from './crypto.js';
import { getContextKey } from './contextKeyRegistry.js';
import { config } from '../config.js';
import logger from './logger.js';

let systemKey = null;
let storageConnectionString = null;
let cortexId = null;

try {
    systemKey = config.get('redisEncryptionKey') || null;
    storageConnectionString = config.get('storageConnectionString') || null;
    cortexId = config.get('cortexId') || 'cortex';
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
 * Double encrypt: user-level (inner) + system-level (outer)
 * @param {string} value - Value to encrypt
 * @param {string} userId - User ID for contextKey lookup
 */
function doubleEncrypt(value, userId) {
    if (value === null || value === undefined || value === '') return value;
    let result = typeof value === 'string' ? value : JSON.stringify(value);
    
    // Inner layer: user-level encryption (if contextKey registered)
    const contextKey = getContextKey(userId);
    if (contextKey) {
        result = encrypt(result, contextKey) ?? result;
    }
    
    // Outer layer: system-level encryption
    if (systemKey) {
        result = encrypt(result, systemKey) ?? result;
    }
    
    return result;
}

/**
 * Double decrypt: system-level (outer) + user-level (inner)
 * @param {string} value - Value to decrypt
 * @param {string} userId - User ID for contextKey lookup
 */
function doubleDecrypt(value, userId) {
    if (value === null || value === undefined || value === '') return value;
    let result = value;
    
    // Outer layer: system-level decryption
    if (systemKey) {
        result = decrypt(result, systemKey) ?? result;
    }
    
    // Inner layer: user-level decryption (if contextKey registered)
    const contextKey = getContextKey(userId);
    if (contextKey) {
        result = decrypt(result, contextKey) ?? result;
    }
    
    return result;
}

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

// ==================== KEY-VALUE OPERATIONS (replaces keyv) ====================

const namespace = `${cortexId}-cortex-context`;

function prefixKey(key) {
    return `${namespace}:${key}`;
}

/**
 * Get a value from Redis with double decryption
 * @param {string} key - Redis key
 * @param {string} userId - User ID for contextKey lookup
 */
async function getv(key, userId = null) {
    const redis = getClient();
    if (!redis) return null;
    
    try {
        const value = await redis.get(prefixKey(key));
        if (value === null) return null;
        
        const decrypted = doubleDecrypt(value, userId);
        
        // Try to parse as JSON
        try {
            return JSON.parse(decrypted);
        } catch {
            return decrypted;
        }
    } catch (error) {
        logger.error(`getv failed for ${key}: ${error.message}`);
        return null;
    }
}

/**
 * Set a value in Redis with double encryption
 * @param {string} key - Redis key
 * @param {*} value - Value to store
 * @param {string} userId - User ID for contextKey lookup
 */
async function setv(key, value, userId = null) {
    const redis = getClient();
    if (!redis) return false;
    
    try {
        // Handle null/undefined - store as special marker
        if (value === null || value === undefined) {
            await redis.del(prefixKey(key));
            return true;
        }
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        const encrypted = doubleEncrypt(stringValue, userId);
        await redis.set(prefixKey(key), encrypted);
        return true;
    } catch (error) {
        logger.error(`setv failed for ${key}: ${error.message}`);
        return false;
    }
}

/**
 * Delete a key from Redis
 * @param {string} key - Redis key
 */
async function delv(key) {
    const redis = getClient();
    if (!redis) return false;
    
    try {
        await redis.del(prefixKey(key));
        return true;
    } catch (error) {
        logger.error(`delv failed for ${key}: ${error.message}`);
        return false;
    }
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
    getv,
    setv,
    delv,
    createEncryptedClient,
    systemEncrypt,
    systemDecrypt,
    doubleEncrypt,
    doubleDecrypt,
    getClient
};
