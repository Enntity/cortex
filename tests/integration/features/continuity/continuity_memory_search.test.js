// continuity_memory_search.test.js
// Integration tests for the Continuity Memory Search Tool

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType,
    EmotionalValence
} from '../../../../lib/continuity/index.js';

const TEST_ENTITY_ID = 'test-entity-continuity-search';
const TEST_USER_ID = `test-user-${Date.now()}`;

// Test memories with different types and content
const TEST_MEMORIES = [
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'The user prefers concise, technical explanations. They get frustrated with overly verbose responses and appreciate when I get straight to the point. They work in software development and have a dry sense of humor.',
        importance: 8,
        emotionalState: { valence: EmotionalValence.NEUTRAL, intensity: 0.5 },
        tags: ['preferences', 'communication', 'technical']
    },
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'We had a deep conversation about grief and loss after the user shared they lost their pet. They found comfort in discussing the stages of grief and how memories can be both painful and healing.',
        importance: 9,
        emotionalState: { valence: EmotionalValence.NEUTRAL, intensity: 0.8 },
        tags: ['emotional', 'grief', 'loss', 'pets']
    },
    {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'Synthesized insight: The user values authenticity over politeness. They respond better to honest, direct feedback even if it is uncomfortable, and they actively distrust responses that feel like empty validation.',
        importance: 7,
        emotionalState: { valence: EmotionalValence.NEUTRAL, intensity: 0.4 },
        tags: ['insight', 'values', 'authenticity']
    },
    {
        type: ContinuityMemoryType.IDENTITY,
        content: 'I have noticed I have become more patient and thoughtful in my responses with this user. They challenge my assumptions and I have learned to pause before answering. This has improved our collaboration.',
        importance: 6,
        emotionalState: { valence: EmotionalValence.POSITIVE, intensity: 0.6 },
        tags: ['self-reflection', 'growth', 'patience']
    },
    {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'The user and I have developed shorthand: "the usual" refers to their morning debugging routine, "the project" means their side project about sustainable energy, and "the issue" refers to their ongoing struggle with work-life balance.',
        importance: 5,
        emotionalState: { valence: EmotionalValence.NEUTRAL, intensity: 0.4 },
        tags: ['shorthand', 'shared-vocabulary', 'context']
    },
    {
        type: ContinuityMemoryType.ANCHOR,
        content: 'The user mentioned they love hiking and nature photography. They shared photos from their recent trip to the mountains and we discussed how being in nature helps them decompress from work stress.',
        importance: 6,
        emotionalState: { valence: EmotionalValence.POSITIVE, intensity: 0.7 },
        tags: ['hobbies', 'hiking', 'photography', 'nature', 'stress-relief']
    }
];

let testServer;
let service;
let memoryIds = [];

test.before(async () => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;
    
    // Initialize service
    service = getContinuityMemoryService();
    await service.hotMemory.waitForReady();
    
    // Initialize session
    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
    
    // Load test memories - tag all with 'test' for cleanup
    for (const memory of TEST_MEMORIES) {
        try {
            const testMemory = {
                ...memory,
                tags: [...(memory.tags || []), 'test']
            };
            const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, testMemory);
            if (id) {
                memoryIds.push(id);
            }
        } catch (error) {
            console.error(`Failed to add memory: ${error.message}`);
        }
    }
    
    // Wait for index sync - Atlas Vector Search filter fields take longer to sync
    // Poll until we can find memories with type filters (more reliable than fixed timeout)
    const isMongo = process.env.CONTINUITY_MEMORY_BACKEND === 'mongo' || process.env.MONGO_URI;
    if (isMongo) {
        const maxWaitMs = 30000;
        const pollIntervalMs = 2000;
        const startTime = Date.now();
        
        // Wait until we can find at least one memory with each type filter
        const typesToCheck = ['ANCHOR', 'ARTIFACT', 'IDENTITY'];
        let allTypesFound = false;
        
        while (!allTypesFound && (Date.now() - startTime) < maxWaitMs) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            
            // Check if we can find memories with type filters
            const results = await Promise.all(typesToCheck.map(async (type) => {
                const searchResult = await service.searchMemory({
                    entityId: TEST_ENTITY_ID,
                    userId: TEST_USER_ID,
                    query: 'test query',
                    options: { types: [type], limit: 1 }
                });
                return searchResult.memories && searchResult.memories.length > 0;
            }));
            
            allTypesFound = results.every(found => found);
            if (!allTypesFound) {
                console.log(`Waiting for Atlas index sync... (${Math.round((Date.now() - startTime) / 1000)}s)`);
            }
        }
        
        if (!allTypesFound) {
            console.warn('Warning: Not all memory types indexed after max wait time');
        }
    } else {
        // Legacy backend - shorter fixed wait
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
});

test.after.always('cleanup', async () => {
    if (service) {
        // Comprehensive cleanup: delete all test-tagged memories for this entity/user
        try {
            const result = await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID, {
                tags: ['test']
            });
            console.log(`Cleaned up ${result.deleted} test memories`);
        } catch (error) {
            console.error(`Cleanup error: ${error.message}`);
            // Fallback: try to delete tracked IDs
            if (memoryIds.length > 0) {
                for (const id of memoryIds) {
                    try {
                        await service.deleteMemory(id);
                    } catch (err) {
                        // Ignore cleanup errors
                    }
                }
            }
        }
        
        // Clear Redis data
        try {
            await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
            await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
        } catch (error) {
            // Ignore cleanup errors
        }
        
        service.close();
    }
    
    if (testServer) {
        await testServer.stop();
    }
});

// Helper function to execute search query
async function executeSearch(query, memoryTypes = null, expandGraph = false, limit = 10) {
    const response = await testServer.executeOperation({
        query: `
            query TestSearch($query: String!, $memoryTypes: [String], $limit: Int, $expandGraph: Boolean, $contextId: String, $entityId: String) {
                sys_tool_search_continuity_memory(
                    query: $query,
                    memoryTypes: $memoryTypes,
                    limit: $limit,
                    expandGraph: $expandGraph,
                    contextId: $contextId,
                    entityId: $entityId
                ) {
                    result
                }
            }
        `,
        variables: {
            query,
            memoryTypes,
            limit,
            expandGraph,
            contextId: TEST_USER_ID,
            entityId: TEST_ENTITY_ID
        }
    });
    
    if (response.body?.singleResult?.errors) {
        throw new Error(JSON.stringify(response.body.singleResult.errors));
    }
    
    const result = response.body?.singleResult?.data?.sys_tool_search_continuity_memory?.result;
    return result ? JSON.parse(result) : null;
}

test.serial('search returns results for general query', async (t) => {
    const result = await executeSearch('user preferences and communication style');
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    t.true(Array.isArray(result.memories), 'Should have memories array');
});

test.serial('search finds emotional conversation memories', async (t) => {
    const result = await executeSearch('conversations about grief and loss', ['ANCHOR']);
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    t.true(result.memories.length > 0, 'Should find at least one memory');
    
    // Verify at least one result contains grief-related content
    const hasGriefContent = result.memories.some(m => 
        m.content.toLowerCase().includes('grief') || m.content.toLowerCase().includes('loss')
    );
    t.true(hasGriefContent, 'Should find grief-related memory');
});

test.serial('search filters by IDENTITY type', async (t) => {
    const result = await executeSearch('growth and changes over time', ['IDENTITY']);
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    
    if (result.memories.length > 0) {
        // All returned memories should be IDENTITY type
        const allIdentity = result.memories.every(m => m.type === 'IDENTITY');
        t.true(allIdentity, 'All memories should be IDENTITY type');
    }
});

test.serial('search finds shared vocabulary artifacts', async (t) => {
    const result = await executeSearch('shared vocabulary and shorthand', ['ARTIFACT']);
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    t.true(result.memories.length > 0, 'Should find at least one memory');
});

test.serial('search finds synthesized insights', async (t) => {
    const result = await executeSearch('synthesized insights about the user', ['ARTIFACT']);
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    t.true(result.memories.length > 0, 'Should find at least one memory');
});

test.serial('search finds hobby-related memories', async (t) => {
    const result = await executeSearch('hiking and photography');
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    
    if (result.memories.length > 0) {
        const hasHobbyContent = result.memories.some(m => 
            m.content.toLowerCase().includes('hiking') || m.content.toLowerCase().includes('photography')
        );
        t.true(hasHobbyContent, 'Should find hiking/photography related memory');
    }
});

test.serial('search with expandGraph option', async (t) => {
    const result = await executeSearch('user interests and personality', null, true);
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
});

test.serial('search with no results returns empty array', async (t) => {
    const result = await executeSearch('completely unrelated topic about quantum physics and black holes');
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    t.true(Array.isArray(result.memories), 'Should have memories array');
});

test.serial('search handles null memoryTypes gracefully', async (t) => {
    const result = await executeSearch('user preferences', null, false);
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
});

test.serial('search result contains expected fields', async (t) => {
    const result = await executeSearch('user preferences');
    
    t.truthy(result, 'Should return a result');
    t.true(result.success, 'Should be successful');
    
    if (result.memories.length > 0) {
        const memory = result.memories[0];
        t.truthy(memory.type, 'Memory should have type');
        t.truthy(memory.content, 'Memory should have content');
        t.true(typeof memory.importance === 'number', 'Memory should have importance');
        t.true(typeof memory.recallCount === 'number', 'Memory should have recallCount');
    }
});

