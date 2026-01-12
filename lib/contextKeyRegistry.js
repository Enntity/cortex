/**
 * Context Key Registry
 * 
 * Global in-memory registry for user-level encryption keys.
 * Populated once per request (in pathwayResolver.executePathway), 
 * then looked up by userId when encryption/decryption is needed.
 * 
 * This enables double-layer encryption:
 * - Outer layer: System-level (redisEncryptionKey) - protects all data at rest
 * - Inner layer: User-level (contextKey) - per-user encryption for PII
 * 
 * Used by:
 * - encryptedRedisClient.js (keyv double encryption)
 * - RedisHotMemory.js (continuity hot memory encryption)
 * 
 * Lifecycle:
 * - Keys are registered at request start via registerContextKey()
 * - Keys persist in memory until process restart or explicit clear
 * - Re-registering same userId overwrites previous key (idempotent)
 * 
 * @module contextKeyRegistry
 */

/** @type {Map<string, string>} Maps userId -> contextKey */
const registry = new Map();

/**
 * Register a contextKey for a user (call once per request)
 * @param {string} userId
 * @param {string} contextKey
 */
export function registerContextKey(userId, contextKey) {
    if (userId && contextKey) {
        registry.set(userId, contextKey);
    }
}

/**
 * Get the registered contextKey for a user
 * @param {string} userId
 * @returns {string|null}
 */
export function getContextKey(userId) {
    return registry.get(userId) || null;
}

/**
 * Clear a user's contextKey from registry
 * @param {string} userId
 */
export function clearContextKey(userId) {
    registry.delete(userId);
}

/**
 * Clear all registered keys (for testing)
 */
export function clearAllContextKeys() {
    registry.clear();
}
