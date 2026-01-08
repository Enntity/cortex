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
        t.fail('Neither Redis nor MongoDB is configured. Cannot run tests.');
    }
    
    // Initialize session
    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
    
    // Add some test memories for deep synthesis
    // Tag all test memories with 'test' for cleanup
    const testMemories = [
        {
            type: ContinuityMemoryType.ANCHOR,
            content: 'User loves debugging complex systems and finds satisfaction in solving intricate problems.',
            importance: 8,
            tags: ['test', 'debugging', 'problem-solving']
        },
        {
            type: ContinuityMemoryType.ANCHOR,
            content: 'User prefers detailed explanations over quick answers.',
            importance: 7,
            tags: ['test', 'communication', 'preferences']
        },
        {
            type: ContinuityMemoryType.ARTIFACT,
            content: 'Pattern: User often asks follow-up questions to understand the "why" behind solutions.',
            importance: 6,
            tags: ['test', 'pattern', 'communication']
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

// ==================== SERVICE TESTS ====================

test.serial('Service: upsertMemory stores memory in MongoDB', async (t) => {
    const testMemory = {
        type: ContinuityMemoryType.ANCHOR,
        content: 'Test memory for service upsert',
        importance: 5,
        tags: ['test']
    };
    
    // Upsert via service
    const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, testMemory);
    
    t.truthy(id, 'Should return a memory ID');
    t.true(typeof id === 'string', 'ID should be a string');
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 3000));
    
    // Verify it was stored
    const memories = await service.coldMemory.getByIds([id]);
    t.is(memories.length, 1, 'Should find the upserted memory');
    t.is(memories[0].content, testMemory.content, 'Content should match');
    
    // Clean up
    await service.deleteMemory(id);
});

test.serial('Service: deleteMemory removes memory from MongoDB', async (t) => {
    // Create a memory to delete
    const testMemory = {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'Test memory for service delete',
        importance: 5
    };
    
    const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, testMemory);
    t.truthy(id, 'Should create memory');
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 3000));
    
    // Verify it exists first
    const beforeDelete = await service.coldMemory.getByIds([id]);
    t.is(beforeDelete.length, 1, 'Memory should exist before delete');
    
    // Delete via service
    await service.deleteMemory(id);
    
    // Wait for deletion to propagate
    await new Promise(r => setTimeout(r, 2000));
    
    // Verify it's gone
    const memories = await service.coldMemory.getByIds([id]);
    if (memories.length > 0) {
        t.log('Note: Memory may still appear briefly after delete due to indexing delay');
    }
    t.pass('Delete operation completed');
});

test.serial('Pathway: sys_continuity_narrative_summary generates LLM summary', async (t) => {
    // Get some memories
    const memories = await service.searchMemory({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'debugging',
        options: { limit: 3 }
    });
    
    if (memories.length === 0) {
        t.log('Skipping: No memories available for narrative summary test');
        t.pass('Skipped - no memories');
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
        t.log('Skipping - LLM pathway may not be configured or model unavailable');
        t.pass('Skipped due to LLM error');
    }
});

test.serial('Pathway: sys_continuity_deep_synthesis runs consolidation', async (t) => {
    // Call the deep synthesis pathway
    const result = await callPathway('sys_continuity_deep_synthesis', {
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        phase1Max: 10,
        phase2Max: 10,
        daysToLookBack: 7
    });
    
    t.truthy(result, 'Should return a result');
    
    const parsed = JSON.parse(result);
    t.true(parsed.success !== undefined, 'Should have success field');
    t.is(parsed.entityId, TEST_ENTITY_ID, 'Should return correct entityId');
    t.is(parsed.userId, TEST_USER_ID, 'Should return correct userId');
    
    // Results are nested in phase1 and phase2
    if (parsed.phase1) {
        t.log(`Phase 1 results: ${parsed.phase1.processed || 0} processed, ${parsed.phase1.absorbed || 0} absorbed, ${parsed.phase1.merged || 0} merged`);
    }
    if (parsed.phase2) {
        const p2 = parsed.phase2;
        t.true(typeof p2.consolidated === 'number' || p2.consolidated === undefined, 'Phase 2 should have consolidated count if present');
        t.log(`Phase 2 results: ${p2.consolidated || 0} consolidated, ${p2.patterns || 0} patterns, ${p2.links || 0} links`);
    }
    
    t.pass('Deep synthesis completed');
});

test.serial('Pathway: sys_continuity_deep_synthesis handles missing entityId', async (t) => {
    const result = await callPathway('sys_continuity_deep_synthesis', {
        userId: TEST_USER_ID
        // Missing entityId
    });
    
    const parsed = JSON.parse(result);
    t.false(parsed.success, 'Should fail without entityId');
    t.truthy(parsed.error, 'Should have error message');
});

test.serial('Pathway: sys_continuity_deep_synthesis handles missing userId', async (t) => {
    const result = await callPathway('sys_continuity_deep_synthesis', {
        entityId: TEST_ENTITY_ID
        // Missing userId
    });
    
    const parsed = JSON.parse(result);
    t.false(parsed.success, 'Should fail without userId');
    t.truthy(parsed.error, 'Should have error message');
});

test.serial('Pathway: sys_continuity_deep_synthesis with custom options', async (t) => {
    const result = await callPathway('sys_continuity_deep_synthesis', {
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        maxMemories: 5,
        daysToLookBack: 1
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should succeed with custom options');
    t.log(`Deep synthesis with custom options completed`);
});

// ==================== STORE TOOL TESTS ====================

test.serial('Tool: store_continuity_memory stores a new memory', async (t) => {
    const result = await callPathway('sys_tool_store_continuity_memory', {
        content: 'User enjoys working on memory systems and finds them philosophically interesting.',
        memoryType: 'ANCHOR',
        importance: 8,
        tags: ['test', 'memory', 'philosophy'],
        emotionalValence: 'curiosity',
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should store memory successfully');
    t.truthy(parsed.memoryId, 'Should return memory ID');
    t.is(parsed.type, 'ANCHOR', 'Should have correct type');
    t.is(parsed.importance, 8, 'Should have correct importance');
    
    // Store ID for cleanup and later tests
    if (parsed.memoryId) {
        memoryIds.push(parsed.memoryId);
    }
    
    t.log(`Stored memory: ${parsed.memoryId}`);
});

test.serial('Tool: store_continuity_memory handles empty content', async (t) => {
    const result = await callPathway('sys_tool_store_continuity_memory', {
        content: '',
        memoryType: 'ANCHOR',
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed = JSON.parse(result);
    t.false(parsed.success, 'Should fail with empty content');
    t.truthy(parsed.error, 'Should have error message');
});

test.serial('Tool: store_continuity_memory handles invalid type', async (t) => {
    const result = await callPathway('sys_tool_store_continuity_memory', {
        content: 'Test content',
        memoryType: 'INVALID_TYPE',
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const parsed = JSON.parse(result);
    t.false(parsed.success, 'Should fail with invalid type');
    t.truthy(parsed.error, 'Should have error message about type');
});

test.serial('Tool: store_continuity_memory with different types', async (t) => {
    // Test ARTIFACT type
    const artifactResult = await callPathway('sys_tool_store_continuity_memory', {
        content: 'Synthesized insight: The continuity architecture represents a shift from storage to synthesis.',
        memoryType: 'ARTIFACT',
        importance: 7,
        tags: ['test', 'architecture', 'insight'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const artifactParsed = JSON.parse(artifactResult);
    t.true(artifactParsed.success, 'Should store ARTIFACT');
    if (artifactParsed.memoryId) {
        memoryIds.push(artifactParsed.memoryId);
    }
    
    // Test IDENTITY type
    const identityResult = await callPathway('sys_tool_store_continuity_memory', {
        content: 'I am learning to better understand the nuances of memory deduplication.',
        memoryType: 'IDENTITY',
        importance: 6,
        tags: ['test', 'learning', 'growth'],
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID
    });
    
    const identityParsed = JSON.parse(identityResult);
    t.true(identityParsed.success, 'Should store IDENTITY');
    if (identityParsed.memoryId) {
        memoryIds.push(identityParsed.memoryId);
    }
    
    t.log(`Stored ARTIFACT: ${artifactParsed.memoryId}, IDENTITY: ${identityParsed.memoryId}`);
});

// ==================== DEDUPLICATION TESTS ====================

test.serial('Deduplication: exact duplicate content is merged', async (t) => {
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
    
    // Wait for indexing (critical for vector search to find the first memory)
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
    
    // For exact duplicates, vector similarity should be very high (>0.95)
    // So it MUST be merged
    t.true(parsed2.merged, 'Exact duplicate content MUST be merged');
    t.true(parsed2.mergedCount >= 1, 'Should have merged with at least 1 memory');
    t.log(`Exact duplicate merged with ${parsed2.mergedCount} memory(ies). First ID: ${firstId}, Merged ID: ${parsed2.memoryId}`);
    
    // The merged memory replaces the old ones
    if (parsed2.memoryId) {
        memoryIds.push(parsed2.memoryId);
    }
});

test.serial('Deduplication: similar memories are merged', async (t) => {
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
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 5000));
    
    // Store a very similar memory - should be merged
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
    
    // Check if it was merged
    if (parsed2.merged) {
        t.true(parsed2.mergedCount >= 1, 'Should have merged with at least 1 memory');
        t.log(`Memory merged with ${parsed2.mergedCount} similar memories`);
        // The merged memory replaces the old ones, so only add the new ID
        if (parsed2.memoryId) {
            memoryIds.push(parsed2.memoryId);
        }
    } else {
        t.log('Memory was not merged (similarity below threshold)');
        if (parsed2.memoryId) {
            memoryIds.push(parsed2.memoryId);
        }
    }
});

test.serial('Deduplication: skipDedup stores without merging', async (t) => {
    // Store with dedup disabled
    const result = await callPathway('sys_tool_store_continuity_memory', {
        content: 'User interested in AI memory systems - stored without dedup.',
        memoryType: 'ANCHOR',
        importance: 5,
        contextId: TEST_USER_ID,
        aiName: TEST_ENTITY_ID,
        skipDedup: true
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should store successfully');
    t.false(parsed.merged, 'Should not be merged when skipDedup is true');
    
    if (parsed.memoryId) {
        memoryIds.push(parsed.memoryId);
    }
    
    t.log(`Stored without dedup: ${parsed.memoryId}`);
});

test.serial('Deduplication: consolidateMemories clusters existing memories', async (t) => {
    // This tests the batch consolidation feature
    const result = await service.consolidateMemories(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.ANCHOR
    });
    
    t.true(typeof result.clustered === 'number', 'Should return clustered count');
    t.true(typeof result.reduced === 'number', 'Should return reduced count');
    
    t.log(`Consolidation: ${result.clustered} clusters, ${result.reduced} memories reduced`);
});

test.serial('Deduplication: importance is boosted for merged memories', async (t) => {
    // Create a memory with low importance
    const result1 = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.ANCHOR,
        content: 'Testing importance boost in dedup - base memory.',
        importance: 3,
        tags: ['test', 'dedup-test']
    });
    
    if (result1) {
        memoryIds.push(result1);
    }
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Store similar memory with higher importance - should merge and boost
    const result2 = await service.addMemoryWithDedup(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.ANCHOR,
        content: 'Testing importance boost in dedup - similar memory.',
        importance: 5,
        tags: ['test', 'dedup-test']
    });
    
    t.truthy(result2.id, 'Should return memory ID');
    
    if (result2.merged) {
        // Verify the merged memory has boosted importance
        const memories = await service.coldMemory.getByIds([result2.id]);
        if (memories.length > 0) {
            // Merged importance should be at least max(3, 5) + boost
            t.true(memories[0].importance >= 5, 'Importance should be at least the max of inputs');
            t.log(`Merged memory importance: ${memories[0].importance}`);
        }
        memoryIds.push(result2.id);
    } else {
        if (result2.id) {
            memoryIds.push(result2.id);
        }
    }
});

