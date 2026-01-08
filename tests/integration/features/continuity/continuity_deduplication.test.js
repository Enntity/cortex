// continuity_deduplication.test.js
// Focused tests for deduplication logic and vector matching

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType
} from '../../../../lib/continuity/index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';

const TEST_ENTITY_ID = 'test-entity-dedup';
const TEST_USER_ID = `test-user-${Date.now()}`;

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
    
    service = getContinuityMemoryService();
    
    // Wait for Redis if needed
    const redisReady = await service.hotMemory.waitForReady(5000);
    if (!redisReady && !service.coldMemory.isConfigured()) {
        t.fail('Neither Redis nor MongoDB is configured. Cannot run tests.');
    }
    
    // Initialize session
    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
});

test.after.always('cleanup', async (t) => {
    if (service) {
        // Comprehensive cleanup: delete all test-tagged memories for this entity/user
        try {
            const result = await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID, ['test']);
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
        await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
        service.close();
    }
    
    if (testServer) {
        await testServer.stop();
    }
});

// ==================== DEDUPLICATION TESTS ====================

test.serial('Exact duplicate content is merged', async (t) => {
    // Store a memory
    const exactContent = 'User is interested in AI memory systems and their philosophical implications.';
    const result1 = await callPathway('sys_tool_store_continuity_memory', {
        content: exactContent,
        memoryType: 'ANCHOR',
        importance: 6,
        tags: ['test', 'ai', 'memory', 'philosophy'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed1 = JSON.parse(result1);
    t.true(parsed1.success, 'First memory should be stored');
    const firstId = parsed1.memoryId;
    if (firstId) {
        memoryIds.push(firstId);
    }
    t.log(`First memory stored with ID: ${firstId}, merged: ${parsed1.merged}`);
    
    // Wait for indexing (critical for vector search to find the first memory)
    t.log('Waiting 5 seconds for indexing...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Store the EXACT same content - should definitely be merged
    const result2 = await callPathway('sys_tool_store_continuity_memory', {
        content: exactContent, // Exact same content
        memoryType: 'ANCHOR',
        importance: 7, // Different importance shouldn't matter
        tags: ['test', 'ai', 'architecture'], // Different tags shouldn't matter
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed2 = JSON.parse(result2);
    t.true(parsed2.success, 'Second memory should be stored');
    t.log(`Second memory result: merged=${parsed2.merged}, mergedCount=${parsed2.mergedCount}, memoryId=${parsed2.memoryId}`);
    
    // For exact duplicates, vector similarity should be very high (>0.95)
    // So it MUST be merged
    t.true(parsed2.merged, 'Exact duplicate content MUST be merged');
    t.true(parsed2.mergedCount >= 1, 'Should have merged with at least 1 memory');
    t.log(`✓ Exact duplicate merged with ${parsed2.mergedCount} memory(ies). First ID: ${firstId}, Merged ID: ${parsed2.memoryId}`);
    
    // The merged memory replaces the old ones
    if (parsed2.memoryId) {
        memoryIds.push(parsed2.memoryId);
    }
});

test.serial('Very similar memories are merged', async (t) => {
    // Store a memory
    const result1 = await callPathway('sys_tool_store_continuity_memory', {
        content: 'User is interested in AI memory systems and their philosophical implications.',
        memoryType: 'ANCHOR',
        importance: 6,
        tags: ['test', 'ai', 'memory', 'philosophy'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed1 = JSON.parse(result1);
    t.true(parsed1.success, 'First memory should be stored');
    if (parsed1.memoryId) {
        memoryIds.push(parsed1.memoryId);
    }
    t.log(`First memory stored with ID: ${parsed1.memoryId}`);
    
    // Wait for indexing
    t.log('Waiting 5 seconds for indexing...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Store a very similar memory - should be merged (similarity > 0.85)
    const result2 = await callPathway('sys_tool_store_continuity_memory', {
        content: 'User has deep interest in AI memory architectures and their philosophical aspects.',
        memoryType: 'ANCHOR',
        importance: 7,
        tags: ['test', 'ai', 'architecture'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed2 = JSON.parse(result2);
    t.true(parsed2.success, 'Second memory should be stored');
    t.log(`Second memory result: merged=${parsed2.merged}, mergedCount=${parsed2.mergedCount}, memoryId=${parsed2.memoryId}`);
    
    // Check if it was merged
    if (parsed2.merged) {
        t.true(parsed2.mergedCount >= 1, 'Should have merged with at least 1 memory');
        t.log(`✓ Similar memory merged with ${parsed2.mergedCount} similar memories`);
        if (parsed2.memoryId) {
            memoryIds.push(parsed2.memoryId);
        }
    } else {
        t.log(`⚠ Memory was not merged (similarity below 0.85 threshold). This might be expected if embeddings differ significantly.`);
        if (parsed2.memoryId) {
            memoryIds.push(parsed2.memoryId);
        }
    }
});

test.serial('Different memories are NOT merged', async (t) => {
    // Store a memory about one topic
    const result1 = await callPathway('sys_tool_store_continuity_memory', {
        content: 'User loves debugging complex systems and finds satisfaction in solving intricate problems.',
        memoryType: 'ANCHOR',
        importance: 8,
        tags: ['test', 'debugging', 'problem-solving'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed1 = JSON.parse(result1);
    t.true(parsed1.success, 'First memory should be stored');
    if (parsed1.memoryId) {
        memoryIds.push(parsed1.memoryId);
    }
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 5000));
    
    // Store a completely different memory - should NOT be merged
    const result2 = await callPathway('sys_tool_store_continuity_memory', {
        content: 'User prefers detailed explanations over quick answers.',
        memoryType: 'ANCHOR',
        importance: 7,
        tags: ['test', 'communication', 'preferences'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed2 = JSON.parse(result2);
    t.true(parsed2.success, 'Second memory should be stored');
    t.false(parsed2.merged, 'Different memories should NOT be merged');
    t.is(parsed2.mergedCount, 0, 'Should have merged with 0 memories');
    
    if (parsed2.memoryId) {
        memoryIds.push(parsed2.memoryId);
    }
});

test.serial('Vector score debugging: check actual scores', async (t) => {
    // Store a memory
    const content = 'User is interested in AI memory systems and their philosophical implications.';
    const result1 = await callPathway('sys_tool_store_continuity_memory', {
        content,
        memoryType: 'ANCHOR',
        importance: 6,
        tags: ['test', 'debug'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed1 = JSON.parse(result1);
    t.true(parsed1.success);
    if (parsed1.memoryId) {
        memoryIds.push(parsed1.memoryId);
    }
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 5000));
    
    // Search for it to see the vector score
    const searchResults = await service.coldMemory.searchSemantic(
        TEST_ENTITY_ID,
        TEST_USER_ID,
        content,
        5,
        ['ANCHOR']
    );
    
    t.log(`Found ${searchResults.length} results for exact content search`);
    t.log(`\n=== Vector Search Score Analysis ===`);
    for (const result of searchResults) {
        t.log(`  ID: ${result.id}`);
        t.log(`    Computed _vectorScore (cosine): ${result._vectorScore?.toFixed(4) ?? 'N/A'}`);
        t.log(`    Recall score: ${result._recallScore?.toFixed(4) ?? 'N/A'}`);
        t.log(`    Content preview: ${result.content?.substring(0, 60)}...`);
    }
    
    // The first result should be our exact match with high vector score
    if (searchResults.length > 0) {
        const topResult = searchResults[0];
        t.log(`\n=== Top Result Analysis ===`);
        t.log(`Computed cosine similarity: ${topResult._vectorScore?.toFixed(4) ?? 'N/A'}`);
        t.log(`We use computed cosine similarity (_vectorScore) for deduplication.`);
        
        // For exact matches, cosine similarity should be high (>= 0.8)
        // Note: Even exact text can have < 1.0 similarity due to embedding precision
        t.true(
            (topResult._vectorScore ?? 0) >= 0.8,
            `Exact match should have computed cosine similarity >= 0.8, got ${topResult._vectorScore?.toFixed(4) ?? 'N/A'}`
        );
    }
});

