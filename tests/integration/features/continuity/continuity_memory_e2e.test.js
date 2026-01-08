// continuity_memory_e2e.test.js
// End-to-end integration tests for Continuity Memory Architecture

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType,
    EmotionalValence
} from '../../../../lib/continuity/index.js';

const TEST_ENTITY_ID = 'test-entity-continuity-e2e';
const TEST_USER_ID = `test-user-${Date.now()}`;

// Mock content - all tagged with 'test' for cleanup
const MOCK_MEMORIES = [
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'User prefers direct communication and appreciates technical depth.',
        importance: 7,
        emotionalState: { valence: EmotionalValence.WARMTH, intensity: 0.6 },
        tags: ['test', 'communication', 'preferences']
    },
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'Shared vocabulary: "The Box" refers to the main development server.',
        importance: 8,
        tags: ['test', 'shorthand', 'vocabulary'],
        relationalContext: { sharedVocabulary: { 'The Box': 'main dev server' } }
    },
    {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'Insight: Complex problems benefit from walking through them step by step rather than jumping to solutions.',
        importance: 6,
        tags: ['test', 'insight', 'problem-solving']
    },
    {
        type: ContinuityMemoryType.IDENTITY,
        content: 'I am becoming more comfortable with expressing uncertainty when I don\'t have complete information.',
        importance: 5,
        tags: ['test', 'growth', 'self-awareness']
    }
];

const MOCK_EPISODIC_TURNS = [
    { role: 'user', content: 'Hey, can you help me debug something on The Box?' },
    { role: 'assistant', content: 'Of course! What\'s happening on the dev server?' },
    { role: 'user', content: 'The memory service isn\'t connecting properly.' },
    { role: 'assistant', content: 'Let\'s walk through this step by step. First, can you check if Redis is running?' }
];

let testServer;
let service;
let memoryIds = [];

test.before(async (t) => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;
    
    // Initialize service
    service = getContinuityMemoryService();
    
    // Check service availability
    const redisAvailable = service.hotMemory.isAvailable();
    const redisStatus = service.hotMemory.client?.status || 'no client';
    const mongoConfigured = service.coldMemory.isConfigured();
    
    t.log(`Redis client status: ${redisStatus}`);
    t.log(`Redis available: ${redisAvailable}`);
    t.log(`MongoDB configured: ${mongoConfigured}`);
    
    // Wait for Redis if needed
    if (!redisAvailable) {
        t.log('Waiting for Redis connection...');
        await new Promise(r => setTimeout(r, 2000));
    }
    
    // Wait for Redis to be ready
    const redisReady = await service.hotMemory.waitForReady(5000);
    if (!redisReady && !mongoConfigured) {
        t.fail('Neither Redis nor MongoDB is configured. Cannot run tests.');
    }
});

test.after.always('cleanup', async (t) => {
    if (service) {
        // Comprehensive cleanup: delete all test-tagged memories for this entity/user
        try {
            const result = await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID, {
                tags: ['test']
            });
            t.log(`Cleaned up ${result.deleted} test memories from database`);
        } catch (error) {
            t.log(`Cleanup error: ${error.message}`);
            // Fallback: try to delete tracked IDs
            if (memoryIds.length > 0) {
                for (const id of memoryIds) {
                    try {
                        await service.deleteMemory(id);
                    } catch (err) {
                        t.log(`Failed to delete memory ${id}: ${err.message}`);
                    }
                }
            }
        }
        
        // Clear Redis data
        try {
            await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
            await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
            // Expression state is cleared when clearing episodic stream
        } catch (error) {
            t.log(`Failed to clear Redis data: ${error.message}`);
        }
        
        service.close();
    }
    
    if (testServer) {
        await testServer.stop();
    }
});

// ==================== REDIS HOT MEMORY TESTS ====================

test.serial('Redis: session initialization', async (t) => {
    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
    t.pass('Session initialized');
});

test.serial('Redis: record episodic turns', async (t) => {
    for (const turn of MOCK_EPISODIC_TURNS) {
        await service.recordTurn(TEST_ENTITY_ID, TEST_USER_ID, {
            ...turn,
            timestamp: new Date().toISOString()
        });
    }
    t.pass(`Recorded ${MOCK_EPISODIC_TURNS.length} episodic turns`);
});

test.serial('Redis: expression state read/write', async (t) => {
    await service.updateExpressionState(TEST_ENTITY_ID, TEST_USER_ID, {
        basePersonality: 'helpful-technical',
        emotionalResonance: { valence: 'curiosity', intensity: 0.7 },
        situationalAdjustments: ['debugging-mode', 'step-by-step']
    });
    
    const state = await service.getExpressionState(TEST_ENTITY_ID, TEST_USER_ID);
    t.truthy(state, 'Expression state should be returned');
    t.is(state?.basePersonality, 'helpful-technical', 'Base personality should match');
    t.truthy(state?.emotionalResonance, 'Emotional resonance should be set');
    t.is(state?.emotionalResonance?.valence, 'curiosity', 'Emotional valence should match');
});

test.serial('Redis: session info', async (t) => {
    const info = await service.getSessionInfo(TEST_ENTITY_ID, TEST_USER_ID);
    t.truthy(info, 'Session info should be returned');
    t.is(info.turnCount, MOCK_EPISODIC_TURNS.length, `Should have ${MOCK_EPISODIC_TURNS.length} turns recorded`);
});

// ==================== MONGODB COLD MEMORY TESTS ====================

test.serial('MongoDB: memory upsert', async (t) => {
    for (const memory of MOCK_MEMORIES) {
        const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, memory);
        if (id) {
            memoryIds.push(id);
        }
    }
    
    t.is(memoryIds.length, MOCK_MEMORIES.length, `Should upsert all ${MOCK_MEMORIES.length} memories`);
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 3000));
});

test.serial('MongoDB: semantic search', async (t) => {
    const searchResults = await service.searchMemory({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'communication preferences',
        options: { limit: 5 }
    });
    
    t.true(searchResults.length > 0, 'Should return search results');
    t.truthy(searchResults[0].content, 'Results should have content');
    t.log(`Top result: "${searchResults[0].content?.substring(0, 50)}..."`);
});

test.serial('MongoDB: get memories by type', async (t) => {
    const anchors = await service.getMemoriesByType(
        TEST_ENTITY_ID, TEST_USER_ID, 
        ContinuityMemoryType.ANCHOR, 10
    );
    
    t.true(anchors.length >= 2, `Should find at least 2 ANCHOR memories, got ${anchors.length}`);
    
    // Verify all results are ANCHOR type
    const allAnchors = anchors.every(m => m.type === ContinuityMemoryType.ANCHOR);
    t.true(allAnchors, 'All results should be ANCHOR type');
});

// ==================== CONTEXT BUILDING TESTS ====================

test.serial('Context: build context window', async (t) => {
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
    
    t.truthy(context, 'Context should be returned');
    t.true(context.length > 0, 'Context should not be empty');
    t.log(`Context length: ${context.length} chars`);
    
    // Check for expected sections
    const hasExpression = context.includes('Expression') || context.includes('emotional');
    const hasSession = context.includes('Session') || context.includes('turns');
    
    if (hasExpression) {
        t.pass('Context includes expression state');
    }
    if (hasSession) {
        t.pass('Context includes session info');
    }
    
    // Log preview
    t.log('--- Context Preview ---');
    t.log(context.substring(0, 500) + (context.length > 500 ? '...' : ''));
    t.log('-----------------------');
});

// ==================== INTEGRATION TESTS ====================

test.serial('Integration: service availability check', async (t) => {
    const isAvailable = service.isAvailable();
    t.true(isAvailable, 'Service should be available (Redis or MongoDB configured)');
});

test.serial('Integration: search with graph expansion', async (t) => {
    const results = await service.searchMemory({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'communication',
        options: {
            limit: 3,
            expandGraph: true
        }
    });
    
    t.true(Array.isArray(results), 'Should return array of results');
    // Graph expansion may or may not add more results, so we just check it doesn't error
    t.pass('Graph expansion completed without error');
});

test.serial('Integration: context window with expanded graph', async (t) => {
    const context = await service.getContextWindow({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'technical communication',
        options: {
            episodicLimit: 5,
            memoryLimit: 3,
            expandGraph: true
        }
    });
    
    t.truthy(context, 'Context should be returned');
    t.true(typeof context === 'string', 'Context should be a string');
});

test.serial('Integration: narrative summary generation', async (t) => {
    // Get memories to generate summary from
    const memories = await service.searchMemory({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'communication',
        options: { limit: 5 }
    });
    
    if (memories.length === 0) {
        t.skip('No memories available for narrative summary test');
        return;
    }
    
    // Generate narrative summary using the context builder
    const summary = await service.contextBuilder.generateNarrativeSummary(
        TEST_ENTITY_ID,
        TEST_USER_ID,
        memories,
        'Tell me about our communication style'
    );
    
    t.truthy(summary, 'Should return a summary');
    t.true(typeof summary === 'string', 'Summary should be a string');
    t.true(summary.length > 0, 'Summary should not be empty');
    t.log(`Generated narrative summary: "${summary.substring(0, 150)}..."`);
});

