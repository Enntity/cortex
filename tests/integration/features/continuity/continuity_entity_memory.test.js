// continuity_entity_memory.test.js
// Tests that entity-level memories (no userId) are visible during user conversations.
// Validates the life loop scenario: entity creates memories autonomously,
// then a user can see those memories when conversing with the entity.

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType,
} from '../../../../lib/continuity/index.js';

const TEST_ENTITY_ID = 'test-entity-level-mem';
const TEST_USER_ID = `test-user-entmem-${Date.now()}`;

let testServer;
let service;
const createdMemoryIds = [];

test.before(async (t) => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;

    service = getContinuityMemoryService();

    const redisReady = await service.hotMemory.waitForReady(5000);
    if (!redisReady && !service.coldMemory.isConfigured()) {
        t.fail('Neither Redis nor MongoDB is configured. Cannot run tests.');
    }

    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
});

test.after.always('cleanup', async (t) => {
    if (service) {
        // Clean up entity-level memories (stored with no user)
        for (const id of createdMemoryIds) {
            try {
                await service.coldMemory.deleteMemory(id);
            } catch (e) {
                t.log(`Cleanup delete failed for ${id}: ${e.message}`);
            }
        }

        try {
            await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID);
            t.log('Cleaned up user-scoped test memories');
        } catch (error) {
            t.log(`Cleanup error: ${error.message}`);
        }

        await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        service.close();
    }

    if (testServer) {
        await testServer.stop();
    }
});

// ==================== ENTITY-LEVEL MEMORY STORAGE ====================

test.serial('Entity memory: upsertMemory with null userId stores entity-level memory', async (t) => {
    const id = await service.coldMemory.upsertMemory(TEST_ENTITY_ID, null, {
        type: ContinuityMemoryType.EPISODE,
        content: 'I explored astronomy data feeds during the night and found a new exoplanet catalog.',
        importance: 7,
        tags: ['test', 'life-loop', 'autonomous'],
    });

    t.truthy(id, 'Should return a memory ID');
    createdMemoryIds.push(id);

    // Verify it was stored with entityId as sentinel in assocEntityIds
    const memories = await service.coldMemory.getByType(TEST_ENTITY_ID, null, ContinuityMemoryType.EPISODE, 10);
    const found = memories.find(m => m.id === id);
    t.truthy(found, 'Should find the entity-level memory');
    t.deepEqual(found.assocEntityIds, [TEST_ENTITY_ID], 'assocEntityIds should contain entityId as sentinel');
});

// ==================== VISIBILITY DURING USER CONVERSATION ====================

test.serial('Entity memory: getByType with userId includes entity-level memories', async (t) => {
    // Store a user-scoped EPISODE memory
    const userMemId = await service.coldMemory.upsertMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.EPISODE,
        content: 'We discussed debugging the notification system together.',
        importance: 6,
        tags: ['test', 'user-scoped'],
    });
    createdMemoryIds.push(userMemId);

    // Query as the user — should see BOTH user-scoped and entity-level memories
    const memories = await service.coldMemory.getByType(TEST_ENTITY_ID, TEST_USER_ID, ContinuityMemoryType.EPISODE, 20);

    const entityLevel = memories.filter(m => m.tags?.includes('life-loop'));
    const userScoped = memories.filter(m => m.tags?.includes('user-scoped'));

    t.true(entityLevel.length > 0, 'Should include entity-level memories when querying as user');
    t.true(userScoped.length > 0, 'Should include user-scoped memories');
});

test.serial('Entity memory: semantic search with userId includes entity-level memories', async (t) => {
    // Store an entity-level ARTIFACT (life loop insight)
    const id = await service.coldMemory.upsertMemory(TEST_ENTITY_ID, null, {
        type: ContinuityMemoryType.ARTIFACT,
        content: 'I discovered that the Kepler telescope data has a fascinating pattern in binary star systems.',
        importance: 7,
        tags: ['test', 'life-loop', 'astronomy'],
    });
    createdMemoryIds.push(id);

    // Search as a user for astronomy content — should find the entity-level memory
    const results = await service.coldMemory.searchSemantic(
        TEST_ENTITY_ID, TEST_USER_ID, 'astronomy binary star systems', 10
    );

    const found = results.find(m => m.id === id);
    t.truthy(found, 'Semantic search as user should find entity-level memories');
});

test.serial('Entity memory: getTopByImportance with userId includes entity-level memories', async (t) => {
    // Store a high-importance entity-level ANCHOR
    const id = await service.coldMemory.upsertMemory(TEST_ENTITY_ID, null, {
        type: ContinuityMemoryType.ANCHOR,
        content: 'I formed a connection with the astronomy research community during autonomous exploration.',
        importance: 9,
        tags: ['test', 'life-loop', 'relational'],
    });
    createdMemoryIds.push(id);

    const results = await service.coldMemory.getTopByImportance(TEST_ENTITY_ID, TEST_USER_ID, {
        types: [ContinuityMemoryType.ANCHOR],
        limit: 20,
        minImportance: 5,
    });

    const found = results.find(m => m.id === id);
    t.truthy(found, 'getTopByImportance should include entity-level memories');
});

// ==================== PRIVACY: USER ISOLATION ====================

test.serial('Entity memory: user-scoped memories are NOT visible to other users', async (t) => {
    const OTHER_USER_ID = `test-user-other-${Date.now()}`;

    // Store a user-scoped memory for TEST_USER_ID
    const id = await service.coldMemory.upsertMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.ANCHOR,
        content: 'This is a private conversation detail only for the original user.',
        importance: 8,
        tags: ['test', 'private'],
    });
    createdMemoryIds.push(id);

    // Query as a different user — should NOT see the private memory
    const otherUserMemories = await service.coldMemory.getByType(
        TEST_ENTITY_ID, OTHER_USER_ID, ContinuityMemoryType.ANCHOR, 50
    );

    const leaked = otherUserMemories.find(m => m.id === id);
    t.falsy(leaked, 'User-scoped memories must NOT be visible to other users');
});

test.serial('Entity memory: entity-level memories ARE visible to all users', async (t) => {
    const OTHER_USER_ID = `test-user-other2-${Date.now()}`;

    // The entity-level ANCHOR from a previous test should be visible to any user
    const memories = await service.coldMemory.getByType(
        TEST_ENTITY_ID, OTHER_USER_ID, ContinuityMemoryType.ANCHOR, 50
    );

    const entityLevel = memories.filter(m => m.tags?.includes('life-loop'));
    t.true(entityLevel.length > 0, 'Entity-level memories should be visible to any user');
});
