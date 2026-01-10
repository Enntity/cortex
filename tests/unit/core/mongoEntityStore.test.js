// mongoEntityStore.test.js
// Unit tests for MongoEntityStore methods

import test from 'ava';
import { getEntityStore, MongoEntityStore } from '../../../lib/MongoEntityStore.js';
import { v4 as uuidv4 } from 'uuid';

const TEST_ENTITY_ID = uuidv4();
const TEST_USER_ID = `test-user-${Date.now()}`;
const TEST_USER_ID_2 = `test-user-2-${Date.now()}`;

let entityStore;
let createdEntityIds = [];

test.before(async (t) => {
    entityStore = getEntityStore();
    
    if (!entityStore.isConfigured()) {
        t.log('MongoDB not configured - skipping MongoEntityStore tests');
        t.pass('Skipped - MongoDB not configured');
    }
});

test.after.always('cleanup', async (t) => {
    if (entityStore && entityStore.isConfigured()) {
        for (const entityId of createdEntityIds) {
            try {
                const collection = await entityStore._getCollection();
                await collection.deleteOne({ id: entityId });
                t.log(`Cleaned up test entity ${entityId}`);
            } catch (error) {
                t.log(`Failed to cleanup entity ${entityId}: ${error.message}`);
            }
        }
    }
});

// ==================== CONFIGURATION TESTS ====================

test('MongoEntityStore: isConfigured returns false when MONGO_URI not set', (t) => {
    // Create a new instance without MONGO_URI
    const originalUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    
    const testStore = new MongoEntityStore();
    t.false(testStore.isConfigured(), 'Should return false when MONGO_URI not set');
    
    // Restore
    if (originalUri) {
        process.env.MONGO_URI = originalUri;
    }
});

test('MongoEntityStore: getInstance returns singleton', (t) => {
    const instance1 = MongoEntityStore.getInstance();
    const instance2 = MongoEntityStore.getInstance();
    
    t.is(instance1, instance2, 'Should return same instance');
});

// ==================== ENTITY CRUD TESTS ====================

test.serial('MongoEntityStore: upsertEntity creates new entity', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    const entityData = {
        id: TEST_ENTITY_ID,
        name: 'TestEntity',
        description: 'A test entity',
        identity: 'I am a test entity.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID],
        createdBy: TEST_USER_ID
    };
    
    const entityId = await entityStore.upsertEntity(entityData);
    t.is(entityId, TEST_ENTITY_ID, 'Should return the entity ID');
    createdEntityIds.push(entityId);
    
    // Verify entity exists
    const entity = await entityStore.getEntity(entityId);
    t.truthy(entity, 'Entity should exist');
    t.is(entity.name, 'TestEntity', 'Name should match');
    t.is(entity.memoryBackend, 'continuity', 'Memory backend should match');
});

test.serial('MongoEntityStore: upsertEntity updates existing entity', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity first
    const entityData = {
        id: TEST_ENTITY_ID,
        name: 'TestEntity',
        description: 'Original description',
        identity: 'I am a test entity.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID],
        createdBy: TEST_USER_ID
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(TEST_ENTITY_ID);
    
    // Update entity
    const updatedData = {
        ...entityData,
        description: 'Updated description',
        name: 'UpdatedTestEntity'
    };
    
    const entityId = await entityStore.upsertEntity(updatedData);
    t.is(entityId, TEST_ENTITY_ID, 'Should return same ID');
    
    // Verify update
    const entity = await entityStore.getEntity(entityId);
    t.is(entity.description, 'Updated description', 'Description should be updated');
    t.is(entity.name, 'UpdatedTestEntity', 'Name should be updated');
});

test.serial('MongoEntityStore: upsertEntity generates UUID when id not provided', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    const entityData = {
        name: 'AutoUUIDEntity',
        description: 'Entity with auto-generated UUID',
        identity: 'I am an entity with auto-generated UUID.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [],
        createdBy: 'system'
    };
    
    const entityId = await entityStore.upsertEntity(entityData);
    t.truthy(entityId, 'Should return generated UUID');
    t.true(typeof entityId === 'string', 'ID should be a string');
    t.true(entityId.length > 0, 'ID should not be empty');
    createdEntityIds.push(entityId);
    
    // Verify UUID format (basic check)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    t.true(uuidRegex.test(entityId), 'ID should be valid UUID format');
});

test.serial('MongoEntityStore: getEntity retrieves entity by UUID', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity
    const entityData = {
        id: TEST_ENTITY_ID,
        name: 'RetrievalTest',
        description: 'Test entity for retrieval',
        identity: 'I am a test entity for retrieval.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID],
        createdBy: TEST_USER_ID
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(TEST_ENTITY_ID);
    
    // Retrieve entity
    const entity = await entityStore.getEntity(TEST_ENTITY_ID);
    t.truthy(entity, 'Should retrieve entity');
    t.is(entity.id, TEST_ENTITY_ID, 'ID should match');
    t.is(entity.name, 'RetrievalTest', 'Name should match');
});

test.serial('MongoEntityStore: getEntity returns null for non-existent entity', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    const nonExistentId = uuidv4();
    const entity = await entityStore.getEntity(nonExistentId);
    t.falsy(entity, 'Should return null for non-existent entity');
});

// ==================== SYSTEM ENTITY TESTS ====================

test.serial('MongoEntityStore: getSystemEntity finds system entity by name', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    const entity = await entityStore.getSystemEntity('Enntity');
    t.truthy(entity, 'Should find Enntity system entity');
    t.is(entity.name, 'Enntity', 'Should have correct name');
    t.true(entity.isSystem, 'Should be marked as system entity');
});

test.serial('MongoEntityStore: getSystemEntity checks cache first', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Load cache
    await entityStore.loadAllEntities();
    
    // Get system entity - should use cache
    const entity = await entityStore.getSystemEntity('Enntity');
    t.truthy(entity, 'Should find entity from cache');
    t.is(entity.name, 'Enntity', 'Should have correct name');
});

test.serial('MongoEntityStore: getSystemEntity is case-insensitive', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    const entity1 = await entityStore.getSystemEntity('enntity');
    const entity2 = await entityStore.getSystemEntity('ENNTITY');
    const entity3 = await entityStore.getSystemEntity('Enntity');
    
    t.truthy(entity1, 'Should find with lowercase');
    t.truthy(entity2, 'Should find with uppercase');
    t.truthy(entity3, 'Should find with mixed case');
    
    if (entity1 && entity2 && entity3) {
        t.is(entity1.id, entity2.id, 'Should return same entity');
        t.is(entity2.id, entity3.id, 'Should return same entity');
    }
});

test.serial('MongoEntityStore: getSystemEntity returns null for non-system entity', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create a regular entity
    const regularEntityId = uuidv4();
    const entityData = {
        id: regularEntityId,
        name: 'RegularEntity',
        description: 'A regular entity',
        identity: 'I am a regular entity.',
        isDefault: false,
        isSystem: false, // Not a system entity
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [],
        createdBy: 'test'
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(regularEntityId);
    
    // Try to get it as system entity
    const entity = await entityStore.getSystemEntity('RegularEntity');
    t.falsy(entity, 'Should not find regular entity as system entity');
});

// ==================== USER ASSOCIATION TESTS ====================

test.serial('MongoEntityStore: addUserToEntity adds user to entity', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity
    const entityId = uuidv4();
    const entityData = {
        id: entityId,
        name: 'AssociationTest',
        description: 'Test entity for user association',
        identity: 'I am a test entity.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID],
        createdBy: TEST_USER_ID
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(entityId);
    
    // Add second user
    const success = await entityStore.addUserToEntity(entityId, TEST_USER_ID_2);
    t.true(success, 'Should add user successfully');
    
    // Verify
    const entity = await entityStore.getEntity(entityId);
    t.true(Array.isArray(entity.assocUserIds), 'Should have assocUserIds array');
    t.true(entity.assocUserIds.includes(TEST_USER_ID), 'Should have original user');
    t.true(entity.assocUserIds.includes(TEST_USER_ID_2), 'Should have added user');
});

test.serial('MongoEntityStore: addUserToEntity is idempotent', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity
    const entityId = uuidv4();
    const entityData = {
        id: entityId,
        name: 'IdempotentTest',
        description: 'Test entity for idempotent user addition',
        identity: 'I am a test entity.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [],
        createdBy: 'test'
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(entityId);
    
    // Add user twice
    const success1 = await entityStore.addUserToEntity(entityId, TEST_USER_ID);
    const success2 = await entityStore.addUserToEntity(entityId, TEST_USER_ID);
    
    t.true(success1, 'First add should succeed');
    t.true(success2, 'Second add should succeed');
    
    // Verify user appears only once
    const entity = await entityStore.getEntity(entityId);
    const count = entity.assocUserIds.filter(id => id === TEST_USER_ID).length;
    t.is(count, 1, 'User should appear only once');
});

test.serial('MongoEntityStore: addUserToEntity returns false for invalid inputs', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Test with null entityId
    const result1 = await entityStore.addUserToEntity(null, TEST_USER_ID);
    t.false(result1, 'Should return false for null entityId');
    
    // Test with null userId
    const result2 = await entityStore.addUserToEntity(TEST_ENTITY_ID, null);
    t.false(result2, 'Should return false for null userId');
    
    // Test with non-existent entity
    const nonExistentId = uuidv4();
    const result3 = await entityStore.addUserToEntity(nonExistentId, TEST_USER_ID);
    // This might succeed (MongoDB $addToSet on non-existent doc) or fail, both are acceptable
    t.log(`addUserToEntity on non-existent entity returned: ${result3}`);
});

// ==================== FILTERING TESTS ====================

test.serial('MongoEntityStore: getAllEntities filters by userId', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity for TEST_USER_ID
    const entityId1 = uuidv4();
    const entityData1 = {
        id: entityId1,
        name: 'User1Entity',
        description: 'Entity for user 1',
        identity: 'I am an entity for user 1.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID],
        createdBy: TEST_USER_ID
    };
    
    await entityStore.upsertEntity(entityData1);
    createdEntityIds.push(entityId1);
    
    // Create entity for TEST_USER_ID_2
    const entityId2 = uuidv4();
    const entityData2 = {
        id: entityId2,
        name: 'User2Entity',
        description: 'Entity for user 2',
        identity: 'I am an entity for user 2.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID_2],
        createdBy: TEST_USER_ID_2
    };
    
    await entityStore.upsertEntity(entityData2);
    createdEntityIds.push(entityId2);
    
    // Get entities for TEST_USER_ID
    const entities1 = await entityStore.getAllEntities({ userId: TEST_USER_ID, includeSystem: false });
    const found1 = entities1.find(e => e.id === entityId1);
    const notFound1 = entities1.find(e => e.id === entityId2);
    
    t.truthy(found1, 'Should find entity for user 1');
    t.falsy(notFound1, 'Should not find entity for user 2');
    
    // Get entities for TEST_USER_ID_2
    const entities2 = await entityStore.getAllEntities({ userId: TEST_USER_ID_2, includeSystem: false });
    const found2 = entities2.find(e => e.id === entityId2);
    const notFound2 = entities2.find(e => e.id === entityId1);
    
    t.truthy(found2, 'Should find entity for user 2');
    t.falsy(notFound2, 'Should not find entity for user 1');
});

test.serial('MongoEntityStore: getAllEntities filters system entities', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Get all entities including system
    const allEntities = await entityStore.getAllEntities({ includeSystem: true });
    const systemEntities = allEntities.filter(e => e.isSystem);
    t.true(systemEntities.length > 0, 'Should have system entities when includeSystem=true');
    
    // Get entities excluding system
    const regularEntities = await entityStore.getAllEntities({ includeSystem: false });
    const systemInRegular = regularEntities.filter(e => e.isSystem);
    t.is(systemInRegular.length, 0, 'Should not have system entities when includeSystem=false');
});

test.serial('MongoEntityStore: getAllEntities includes entities with no assocUserIds', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity with no assocUserIds (public entity)
    const publicEntityId = uuidv4();
    const entityData = {
        id: publicEntityId,
        name: 'PublicEntity',
        description: 'A public entity',
        identity: 'I am a public entity.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [], // Empty array = public
        createdBy: 'system'
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(publicEntityId);
    
    // Get entities for any user - should include public entity
    const entities = await entityStore.getAllEntities({ userId: TEST_USER_ID, includeSystem: false });
    const found = entities.find(e => e.id === publicEntityId);
    t.truthy(found, 'Should include public entity (empty assocUserIds)');
});

test.serial('MongoEntityStore: getEntitiesForUser returns user-specific entities', async (t) => {
    if (!entityStore.isConfigured()) {
        t.pass('Skipped - MongoDB not configured');
        return;
    }
    
    // Create entity for TEST_USER_ID
    const entityId = uuidv4();
    const entityData = {
        id: entityId,
        name: 'UserSpecificEntity',
        description: 'Entity for specific user',
        identity: 'I am a user-specific entity.',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        memoryBackend: 'continuity',
        tools: ['*'],
        resources: [],
        customTools: {},
        assocUserIds: [TEST_USER_ID],
        createdBy: TEST_USER_ID
    };
    
    await entityStore.upsertEntity(entityData);
    createdEntityIds.push(entityId);
    
    // Get entities for user
    const entities = await entityStore.getEntitiesForUser(TEST_USER_ID);
    const found = entities.find(e => e.id === entityId);
    t.truthy(found, 'Should find entity for user');
    
    // Should not include system entities
    const systemEntities = entities.filter(e => e.isSystem);
    t.is(systemEntities.length, 0, 'Should not include system entities');
});
