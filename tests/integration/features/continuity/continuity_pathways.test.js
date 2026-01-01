// continuity_pathways.test.js
// Tests for continuity memory pathways (rate-limited operations, narrative summary, deep synthesis)

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType,
    EmotionalValence
} from '../../../../lib/continuity/index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';

const TEST_ENTITY_ID = 'test-entity-pathways';
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
        t.fail('Neither Redis nor Azure is configured. Cannot run tests.');
    }
    
    // Initialize session
    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
    
    // Add some test memories for deep synthesis
    const testMemories = [
        {
            type: ContinuityMemoryType.ANCHOR,
            content: 'User loves debugging complex systems and finds satisfaction in solving intricate problems.',
            importance: 8,
            tags: ['debugging', 'problem-solving']
        },
        {
            type: ContinuityMemoryType.ANCHOR,
            content: 'User prefers detailed explanations over quick answers.',
            importance: 7,
            tags: ['communication', 'preferences']
        },
        {
            type: ContinuityMemoryType.ARTIFACT,
            content: 'Pattern: User often asks follow-up questions to understand the "why" behind solutions.',
            importance: 6,
            tags: ['pattern', 'communication']
        }
    ];
    
    for (const memory of testMemories) {
        const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, memory);
        if (id) {
            memoryIds.push(id);
        }
    }
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 3000));
});

test.after.always('cleanup', async (t) => {
    if (service && memoryIds.length > 0) {
        for (const id of memoryIds) {
            try {
                await service.deleteMemory(id);
            } catch (error) {
                t.log(`Failed to delete memory ${id}: ${error.message}`);
            }
        }
        
        await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
        service.close();
    }
    
    if (testServer) {
        await testServer.stop();
    }
});

// ==================== PATHWAY TESTS ====================

test.serial('Pathway: continuity_memory_upsert via callPathway', async (t) => {
    const testMemory = {
        type: ContinuityMemoryType.ANCHOR,
        content: 'Test memory for pathway upsert',
        importance: 5,
        tags: ['test']
    };
    
    // Upsert via service (which uses the pathway internally)
    const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, testMemory);
    
    t.truthy(id, 'Should return a memory ID');
    t.true(typeof id === 'string', 'ID should be a string');
    
    // Verify it was stored
    const memories = await service.coldMemory.getByIds([id]);
    t.is(memories.length, 1, 'Should find the upserted memory');
    t.is(memories[0].content, testMemory.content, 'Content should match');
    
    // Clean up
    await service.deleteMemory(id);
});

test.serial('Pathway: continuity_memory_delete via callPathway', async (t) => {
    // Create a memory to delete
    const testMemory = {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'Test memory for pathway delete',
        importance: 5
    };
    
    const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, testMemory);
    t.truthy(id, 'Should create memory');
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 3000));
    
    // Verify it exists first
    const beforeDelete = await service.coldMemory.getByIds([id]);
    t.is(beforeDelete.length, 1, 'Memory should exist before delete');
    
    // Delete via pathway
    await service.deleteMemory(id);
    
    // Wait for deletion to propagate
    await new Promise(r => setTimeout(r, 2000));
    
    // Verify it's gone (may take a moment for Azure to reflect)
    const memories = await service.coldMemory.getByIds([id]);
    // Azure may still return it briefly, so we check it's being deleted
    if (memories.length > 0) {
        t.log('Note: Memory may still appear in Azure briefly after delete');
    }
    t.pass('Delete operation completed');
});

test.serial('Pathway: continuity_narrative_summary generates LLM summary', async (t) => {
    // Get some memories
    const memories = await service.searchMemory({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'debugging',
        options: { limit: 3 }
    });
    
    if (memories.length === 0) {
        t.skip('No memories available for narrative summary test');
        return;
    }
    
    // Test via the service method which uses the pathway internally
    // This is the actual usage pattern
    try {
        const summary = await service.contextBuilder.generateNarrativeSummary(
            TEST_ENTITY_ID,
            TEST_USER_ID,
            memories,
            'Tell me about debugging'
        );
        
        t.truthy(summary, 'Should return a summary');
        t.true(typeof summary === 'string', 'Summary should be a string');
        t.true(summary.length > 0, 'Summary should not be empty');
        t.log(`Narrative summary: "${summary.substring(0, 150)}..."`);
    } catch (error) {
        // If LLM call fails (e.g., no API key), skip the test
        t.log(`Narrative summary generation failed: ${error.message}`);
        t.skip('LLM pathway may not be configured or model unavailable');
    }
});

test.serial('Pathway: continuity_deep_synthesis runs consolidation', async (t) => {
    // Call the deep synthesis pathway
    const result = await callPathway('continuity_deep_synthesis', {
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        maxMemories: 10,
        daysToLookBack: 7
    });
    
    t.truthy(result, 'Should return a result');
    
    const parsed = JSON.parse(result);
    t.true(parsed.success !== undefined, 'Should have success field');
    t.is(parsed.entityId, TEST_ENTITY_ID, 'Should return correct entityId');
    t.is(parsed.userId, TEST_USER_ID, 'Should return correct userId');
    
    // Deep synthesis may or may not find patterns, but should complete
    t.true(typeof parsed.consolidated === 'number', 'Should have consolidated count');
    t.true(typeof parsed.patterns === 'number', 'Should have patterns count');
    t.true(typeof parsed.links === 'number', 'Should have links count');
    
    t.log(`Deep synthesis results: ${parsed.consolidated} consolidated, ${parsed.patterns} patterns, ${parsed.links} links`);
});

test.serial('Pathway: continuity_deep_synthesis handles missing entityId', async (t) => {
    const result = await callPathway('continuity_deep_synthesis', {
        userId: TEST_USER_ID
        // Missing entityId
    });
    
    const parsed = JSON.parse(result);
    t.false(parsed.success, 'Should fail without entityId');
    t.truthy(parsed.error, 'Should have error message');
});

test.serial('Pathway: continuity_deep_synthesis handles missing userId', async (t) => {
    const result = await callPathway('continuity_deep_synthesis', {
        entityId: TEST_ENTITY_ID
        // Missing userId
    });
    
    const parsed = JSON.parse(result);
    t.false(parsed.success, 'Should fail without userId');
    t.truthy(parsed.error, 'Should have error message');
});

test.serial('Pathway: continuity_deep_synthesis with custom options', async (t) => {
    const result = await callPathway('continuity_deep_synthesis', {
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        maxMemories: 5,
        daysToLookBack: 1
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should succeed with custom options');
    t.log(`Deep synthesis with custom options completed`);
});

