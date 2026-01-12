/**
 * Key-Value Storage Client
 * 
 * Backward compatibility layer - now delegates to encryptedRedisClient.
 * 
 * All encryption is handled centrally:
 * - System-level: redisEncryptionKey (automatic)
 * - User-level: contextKey from registry (looked up by userId)
 * 
 * To use: register contextKey via registerContextKey(userId, contextKey) at request start,
 * then just pass userId to get/set operations.
 */

import { getv, setv, delv, getClient } from './encryptedRedisClient.js';

// Re-export the main functions
export { getv, setv, delv };

// Legacy aliases for backward compatibility
const setvWithDoubleEncryption = setv;
const getvWithDoubleDecryption = getv;

// Legacy keyValueStorageClient reference (for code that checks if it exists)
// NOTE: This legacy API does NOT support user-level encryption (no userId param).
// Use getv/setv directly with userId for user-encrypted data.
const keyValueStorageClient = {
    get: (key) => getv(key),
    set: (key, value) => setv(key, value),
    delete: (key) => delv(key),
    on: () => {} // No-op for event handlers
};

export {
    keyValueStorageClient,
    setvWithDoubleEncryption,
    getvWithDoubleDecryption
};
