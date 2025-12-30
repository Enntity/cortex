#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * End-to-end test for Continuity Memory Architecture
 * 
 * Tests the full flow:
 * 1. Redis hot memory (episodic stream, expression state)
 * 2. Azure cold memory (upsert, search, graph expansion)
 * 3. Context building
 * 4. Cleanup
 * 
 * Usage:
 *   node scripts/test-continuity-memory.js
 * 
 * Environment:
 *   Requires Redis and Azure AI Search to be configured
 */

import { 
    getContinuityMemoryService,
    ContinuityMemoryType,
    EmotionalValence
} from '../lib/continuity/index.js';

// Test identifiers - use unique IDs to avoid collisions
const TEST_ENTITY_ID = 'test-entity-continuity';
const TEST_USER_ID = `test-user-${Date.now()}`;

// Mock content
const MOCK_MEMORIES = [
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'User prefers direct communication and appreciates technical depth.',
        importance: 7,
        emotionalState: { valence: EmotionalValence.WARMTH, intensity: 0.6 },
        tags: ['communication', 'preferences']
    },
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'Shared vocabulary: "The Box" refers to the main development server.',
        importance: 8,
        tags: ['shorthand', 'vocabulary'],
        relationalContext: { sharedVocabulary: { 'The Box': 'main dev server' } }
    },
    {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'Insight: Complex problems benefit from walking through them step by step rather than jumping to solutions.',
        importance: 6,
        tags: ['insight', 'problem-solving']
    },
    {
        type: ContinuityMemoryType.IDENTITY,
        content: 'I am becoming more comfortable with expressing uncertainty when I don\'t have complete information.',
        importance: 5,
        tags: ['growth', 'self-awareness']
    }
];

const MOCK_EPISODIC_TURNS = [
    { role: 'user', content: 'Hey, can you help me debug something on The Box?' },
    { role: 'assistant', content: 'Of course! What\'s happening on the dev server?' },
    { role: 'user', content: 'The memory service isn\'t connecting properly.' },
    { role: 'assistant', content: 'Let\'s walk through this step by step. First, can you check if Redis is running?' }
];

// Test results tracking
const results = {
    passed: 0,
    failed: 0,
    errors: []
};

function log(msg) {
    console.log(`  ${msg}`);
}

function pass(test) {
    results.passed++;
    console.log(`  ✅ ${test}`);
}

function fail(test, error) {
    results.failed++;
    results.errors.push({ test, error: error?.message || error });
    console.log(`  ❌ ${test}: ${error?.message || error}`);
}

async function testRedisHotMemory(service) {
    console.log('\n📦 Testing Redis Hot Memory...');
    
    try {
        // Test session initialization
        await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
        pass('Session initialization');
    } catch (e) {
        fail('Session initialization', e);
        return false;
    }
    
    try {
        // Test episodic stream
        for (const turn of MOCK_EPISODIC_TURNS) {
            await service.recordTurn(TEST_ENTITY_ID, TEST_USER_ID, {
                ...turn,
                timestamp: new Date().toISOString()
            });
        }
        pass(`Recorded ${MOCK_EPISODIC_TURNS.length} episodic turns`);
    } catch (e) {
        fail('Recording episodic turns', e);
    }
    
    try {
        // Test expression state
        await service.updateExpressionState(TEST_ENTITY_ID, TEST_USER_ID, {
            basePersonality: 'helpful-technical',
            emotionalResonance: { valence: 'curiosity', intensity: 0.7 },
            situationalAdjustments: ['debugging-mode', 'step-by-step']
        });
        
        const state = await service.getExpressionState(TEST_ENTITY_ID, TEST_USER_ID);
        if (state?.basePersonality === 'helpful-technical') {
            pass('Expression state read/write');
        } else {
            fail('Expression state read/write', 'State not persisted correctly');
        }
    } catch (e) {
        fail('Expression state', e);
    }
    
    try {
        // Test session info
        const info = await service.getSessionInfo(TEST_ENTITY_ID, TEST_USER_ID);
        if (info.turnCount === MOCK_EPISODIC_TURNS.length) {
            pass(`Session info (${info.turnCount} turns recorded)`);
        } else {
            fail('Session info', `Expected ${MOCK_EPISODIC_TURNS.length} turns, got ${info.turnCount}`);
        }
    } catch (e) {
        fail('Session info', e);
    }
    
    return true;
}

async function testAzureColdMemory(service) {
    console.log('\n🧊 Testing Azure Cold Memory...');
    
    const memoryIds = [];
    
    try {
        // Test memory upsert
        for (const memory of MOCK_MEMORIES) {
            const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, memory);
            if (id) {
                memoryIds.push(id);
            }
        }
        
        if (memoryIds.length === MOCK_MEMORIES.length) {
            pass(`Upserted ${memoryIds.length} memories`);
        } else {
            fail('Memory upsert', `Only ${memoryIds.length}/${MOCK_MEMORIES.length} succeeded`);
        }
    } catch (e) {
        fail('Memory upsert', e);
        return { success: false, memoryIds };
    }
    
    // Wait for indexing
    log('Waiting 3s for Azure indexing...');
    await new Promise(r => setTimeout(r, 3000));
    
    try {
        // Test semantic search
        const searchResults = await service.searchMemory({
            entityId: TEST_ENTITY_ID,
            userId: TEST_USER_ID,
            query: 'communication preferences',
            options: { limit: 5 }
        });
        
        if (searchResults.length > 0) {
            pass(`Semantic search returned ${searchResults.length} results`);
            log(`  Top result: "${searchResults[0].content?.substring(0, 50)}..."`);
        } else {
            fail('Semantic search', 'No results returned');
        }
    } catch (e) {
        fail('Semantic search', e);
    }
    
    try {
        // Test get by type
        const anchors = await service.getMemoriesByType(
            TEST_ENTITY_ID, TEST_USER_ID, 
            ContinuityMemoryType.ANCHOR, 10
        );
        
        if (anchors.length >= 2) {
            pass(`Get by type: found ${anchors.length} ANCHOR memories`);
        } else {
            fail('Get by type', `Expected 2+ anchors, got ${anchors.length}`);
        }
    } catch (e) {
        fail('Get by type', e);
    }
    
    return { success: true, memoryIds };
}

async function testContextBuilding(service) {
    console.log('\n🔨 Testing Context Building...');
    
    try {
        const context = await service.getContextWindow({
            entityId: TEST_ENTITY_ID,
            userId: TEST_USER_ID,
            query: 'help with debugging',
            options: {
                episodicLimit: 10,
                memoryLimit: 5,
                expandGraph: false
            }
        });
        
        if (context && context.length > 0) {
            pass(`Context window built (${context.length} chars)`);
            
            // Check for expected sections
            const hasExpression = context.includes('Expression') || context.includes('emotional');
            const hasSession = context.includes('Session') || context.includes('turns');
            
            if (hasExpression) pass('Context includes expression state');
            if (hasSession) pass('Context includes session info');
            
            log('--- Context Preview ---');
            console.log(context.substring(0, 500) + (context.length > 500 ? '...' : ''));
            log('-----------------------');
        } else {
            fail('Context building', 'Empty context returned');
        }
    } catch (e) {
        fail('Context building', e);
    }
}

async function testCleanup(service, memoryIds) {
    console.log('\n🧹 Cleaning up test data...');
    
    try {
        // Delete memories from Azure
        for (const id of memoryIds) {
            await service.deleteMemory(id);
        }
        pass(`Deleted ${memoryIds.length} test memories from Azure`);
    } catch (e) {
        fail('Azure cleanup', e);
    }
    
    try {
        // Clear Redis data
        await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
        pass('Cleared Redis test data');
    } catch (e) {
        fail('Redis cleanup', e);
    }
}

async function runTests() {
    console.log('🧠 Continuity Memory E2E Test');
    console.log('==============================');
    console.log(`Entity: ${TEST_ENTITY_ID}`);
    console.log(`User: ${TEST_USER_ID}`);
    
    let service;
    let memoryIds = [];
    
    try {
        // Initialize service
        console.log('\n⚡ Initializing ContinuityMemoryService...');
        service = getContinuityMemoryService();
        
        // Debug: Check individual components
        const redisAvailable = service.hotMemory.isAvailable();
        const redisStatus = service.hotMemory.client?.status || 'no client';
        const azureConfigured = service.coldMemory.isConfigured();
        
        console.log('');
        console.log('Component Status:');
        console.log(`  Redis client status: ${redisStatus}`);
        console.log(`  Redis available: ${redisAvailable}`);
        console.log(`  Azure API URL: ${service.coldMemory.apiUrl ? 'set' : 'NOT SET'}`);
        console.log(`  Azure API Key: ${service.coldMemory.apiKey ? 'set' : 'NOT SET'}`);
        console.log(`  Azure configured: ${azureConfigured}`);
        
        if (!service.isAvailable()) {
            console.log('');
            console.log('❌ Service not available!');
            console.log('');
            console.log('Neither Redis nor Azure is ready.');
            console.log('');
            console.log('For Redis, check:');
            console.log('  - storageConnectionString in config or STORAGE_CONNECTION_STRING env var');
            console.log('  - Redis server is running and accessible');
            console.log('');
            console.log('For Azure, check:');
            console.log('  - azureCognitiveApiUrl in config or AZURE_COGNITIVE_API_URL env var');
            console.log('  - azureCognitiveApiKey in config or AZURE_COGNITIVE_API_KEY env var');
            
            // Wait a moment for Redis to connect (it might be lazy)
            console.log('');
            console.log('Waiting 2s for Redis connection...');
            await new Promise(r => setTimeout(r, 2000));
            
            const redisRetry = service.hotMemory.isAvailable();
            console.log(`Redis available after wait: ${redisRetry}`);
            console.log(`Redis status after wait: ${service.hotMemory.client?.status || 'no client'}`);
            
            if (!redisRetry && !azureConfigured) {
                process.exit(1);
            }
        }
        
        pass('Service initialized');
        log(`Redis available: ${service.hotMemory.isAvailable()}`);
        log(`Azure configured: ${service.coldMemory.isConfigured()}`);
    } catch (e) {
        fail('Service initialization', e);
        process.exit(1);
    }
    
    // Run tests
    await testRedisHotMemory(service);
    
    const azureResult = await testAzureColdMemory(service);
    memoryIds = azureResult.memoryIds || [];
    
    await testContextBuilding(service);
    
    await testCleanup(service, memoryIds);
    
    // Summary
    console.log('\n==============================');
    console.log('📊 Test Results');
    console.log(`  Passed: ${results.passed}`);
    console.log(`  Failed: ${results.failed}`);
    
    if (results.failed > 0) {
        console.log('\n❌ Failures:');
        for (const err of results.errors) {
            console.log(`  - ${err.test}: ${err.error}`);
        }
        process.exit(1);
    } else {
        console.log('\n✅ All tests passed! Continuity Memory is ready.');
        process.exit(0);
    }
}

// Run
runTests().catch(error => {
    console.error('\n💥 Unexpected error:', error.message);
    if (process.env.DEBUG) {
        console.error(error.stack);
    }
    process.exit(1);
});

