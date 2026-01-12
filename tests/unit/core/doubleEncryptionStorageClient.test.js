// doubleEncryptionStorageClient.test.js
// Tests for context key encryption integration in keyValueStorageClient

import test from 'ava';
import { setvWithDoubleEncryption, getvWithDoubleDecryption, setv, getv } from '../../../lib/keyValueStorageClient.js';
import { registerContextKey, clearAllContextKeys } from '../../../lib/contextKeyRegistry.js';
import { encrypt, decrypt } from '../../../lib/crypto.js';

// Test data
const testData = { message: 'Hello, this is test data!', number: 42, array: [1, 2, 3] };
const systemKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
const userKey = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'; // 64 hex chars
const testUserId = 'test-user-1';

// Mock the config to provide test keys
import { config } from '../../../config.js';
const originalGet = config.get;
const mockGet = (key) => {
    switch (key) {
        case 'storageConnectionString':
            return 'redis://localhost:6379'; // Use in-memory Redis for tests
        case 'cortexId':
            return 'test-cortex';
        case 'redisEncryptionKey':
            return systemKey;
        default:
            return originalGet(key);
    }
};
config.get = mockGet;

// Helper function to clear storage between tests
async function clearStorage() {
    // Clear context key registry
    clearAllContextKeys();
    // Clear any existing test data
    try {
        await setv('test-key', null);
    } catch (error) {
        // Ignore errors when clearing
    }
}

test.beforeEach(async t => {
    await clearStorage();
});

// Test 1: Double encryption/decryption with both contextKey and redisEncryptionKey
test('should store and retrieve data with double encryption when both keys provided', async t => {
    const key = 'test-double-encryption';
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    // Store with double encryption
    await setvWithDoubleEncryption(key, testData, testUserId);
    
    // Retrieve with double decryption
    const retrieved = await getvWithDoubleDecryption(key, testUserId);
    
    t.deepEqual(retrieved, testData);
});

// Test 2: Double encryption/decryption with only redisEncryptionKey (no contextKey)
test('should store and retrieve data with single encryption when no contextKey provided', async t => {
    const key = 'test-single-encryption';
    
    // Store with single encryption (no contextKey registered)
    await setvWithDoubleEncryption(key, testData, null);
    
    // Retrieve with single decryption
    const retrieved = await getvWithDoubleDecryption(key, null);
    
    t.deepEqual(retrieved, testData);
});

// Test 3: Reading single-encrypted data (from keyValueStorageClient) with doubleDecryption
test('should read single-encrypted data from keyValueStorageClient with doubleDecryption', async t => {
    const key = 'test-single-to-double';
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    // Store using keyValueStorageClient (single encryption)
    await setv(key, testData);
    
    // Read using doubleEncryptionStorageClient (should handle single-encrypted data)
    const retrieved = await getvWithDoubleDecryption(key, testUserId);
    
    t.deepEqual(retrieved, testData);
});

// Test 4: Reading single-encrypted data without contextKey
test('should read single-encrypted data from keyValueStorageClient without contextKey', async t => {
    const key = 'test-single-to-double-no-context';
    
    // Store using keyValueStorageClient (single encryption)
    await setv(key, testData);
    
    // Read using doubleEncryptionStorageClient without contextKey
    const retrieved = await getvWithDoubleDecryption(key, null);
    
    t.deepEqual(retrieved, testData);
});

// Test 5: Reading unencrypted data with doubleDecryption
test('should read unencrypted data with doubleDecryption', async t => {
    const key = 'test-unencrypted';
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    // Store unencrypted data using keyValueStorageClient with no encryption key
    const originalRedisKey = config.get('redisEncryptionKey');
    config.get = (key) => {
        switch (key) {
            case 'storageConnectionString':
                return 'redis://localhost:6379';
            case 'cortexId':
                return 'test-cortex';
            case 'redisEncryptionKey':
                return null; // No encryption
            default:
                return originalGet(key);
        }
    };
    
    // Store unencrypted data
    await setv(key, testData);
    
    // Restore mock config
    config.get = mockGet;
    
    // Read using doubleEncryptionStorageClient (should handle unencrypted data)
    const retrieved = await getvWithDoubleDecryption(key, testUserId);
    
    t.deepEqual(retrieved, testData);
});

// Test 6: Reading unencrypted data without contextKey
test('should read unencrypted data without contextKey', async t => {
    const key = 'test-unencrypted-no-context';
    
    // Store unencrypted data using keyValueStorageClient with no encryption key
    const originalRedisKey = config.get('redisEncryptionKey');
    config.get = (key) => {
        switch (key) {
            case 'storageConnectionString':
                return 'redis://localhost:6379';
            case 'cortexId':
                return 'test-cortex';
            case 'redisEncryptionKey':
                return null; // No encryption
            default:
                return originalGet(key);
        }
    };
    
    // Store unencrypted data
    await setv(key, testData);
    
    // Restore mock config
    config.get = mockGet;
    
    // Read using doubleEncryptionStorageClient without contextKey
    const retrieved = await getvWithDoubleDecryption(key, null);
    
    t.deepEqual(retrieved, testData);
});

// Test 7: Mixed data types - some double-encrypted, some single-encrypted
test('should handle mixed encryption states in storage', async t => {
    const doubleKey = 'test-mixed-double';
    const singleKey = 'test-mixed-single';
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    // Store with different encryption methods
    await setvWithDoubleEncryption(doubleKey, testData, testUserId); // Double encrypted
    await setv(singleKey, testData); // Single encrypted
    
    // Both should be readable with doubleDecryption
    const doubleRetrieved = await getvWithDoubleDecryption(doubleKey, testUserId);
    const singleRetrieved = await getvWithDoubleDecryption(singleKey, testUserId);
    
    t.deepEqual(doubleRetrieved, testData, 'Double-encrypted data should be readable');
    t.deepEqual(singleRetrieved, testData, 'Single-encrypted data should be readable');
});

// Test 8: Edge case - null/undefined data handling
test('should handle null and undefined data gracefully', async t => {
    const key1 = 'test-null-data';
    const key2 = 'test-undefined-data';
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    // Store null data
    await setvWithDoubleEncryption(key1, null, testUserId);
    const retrieved1 = await getvWithDoubleDecryption(key1, testUserId);
    t.is(retrieved1, null);
    
    // Store undefined data
    await setvWithDoubleEncryption(key2, undefined, testUserId);
    const retrieved2 = await getvWithDoubleDecryption(key2, testUserId);
    t.is(retrieved2, null); // undefined becomes null when stored
});

// Test 9: Edge case - empty object handling
test('should handle empty objects', async t => {
    const key = 'test-empty-object';
    const emptyData = {};
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    await setvWithDoubleEncryption(key, emptyData, testUserId);
    const retrieved = await getvWithDoubleDecryption(key, testUserId);
    
    t.deepEqual(retrieved, emptyData);
});

// Test 10: Context key changes between operations
test('should handle context key changes between operations', async t => {
    const key1 = 'test-context-change-1';
    const key2 = 'test-context-change-2';
    const newUserKey = '1111111111111111111111111111111111111111111111111111111111111111';
    const testUserId2 = 'test-user-2';
    
    // Register first user's contextKey
    registerContextKey(testUserId, userKey);
    
    // Store with first context key
    await setvWithDoubleEncryption(key1, testData, testUserId);
    
    // Retrieve with same context key
    const retrieved1 = await getvWithDoubleDecryption(key1, testUserId);
    t.deepEqual(retrieved1, testData);
    
    // Register second user's contextKey
    registerContextKey(testUserId2, newUserKey);
    
    // Store with different context key (different key to avoid conflicts)
    await setvWithDoubleEncryption(key2, testData, testUserId2);
    
    // Retrieve with new context key
    const retrieved2 = await getvWithDoubleDecryption(key2, testUserId2);
    t.deepEqual(retrieved2, testData);
    
    // Verify that data encrypted with one key cannot be decrypted with another
    const wrongKeyRetrieved = await getvWithDoubleDecryption(key1, testUserId2);
    t.notDeepEqual(wrongKeyRetrieved, testData, 'Data encrypted with one key should not be readable with different key');
});

// Test 11: Large data handling
test('should handle large data objects', async t => {
    const key = 'test-large-data';
    const largeData = {
        message: 'Large data test',
        array: Array(1000).fill(0).map((_, i) => i),
        nested: {
            level1: {
                level2: {
                    level3: Array(100).fill('test')
                }
            }
        }
    };
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    await setvWithDoubleEncryption(key, largeData, testUserId);
    const retrieved = await getvWithDoubleDecryption(key, testUserId);
    
    t.deepEqual(retrieved, largeData);
});

// Test 12: Special characters and unicode
test('should handle special characters and unicode', async t => {
    const key = 'test-special-chars';
    const specialData = {
        message: 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?',
        unicode: 'Unicode: 🚀 🌟 ñáéíóú 中文 العربية',
        emoji: '😀😁😂🤣😃😄😅😆😉😊'
    };
    
    // Register the user's contextKey
    registerContextKey(testUserId, userKey);
    
    await setvWithDoubleEncryption(key, specialData, testUserId);
    const retrieved = await getvWithDoubleDecryption(key, testUserId);
    
    t.deepEqual(retrieved, specialData);
});
