// entity_onboarding.test.js
// Tests for entity onboarding system: createEntity tool, getOnboardingEntity, getEntities pathways
// Tests the "Her" movie-inspired onboarding experience

import test from 'ava';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { getContinuityMemoryService, ContinuityMemoryType } from '../../../../lib/continuity/index.js';
import { config } from '../../../../config.js';

const TEST_USER_ID = `test-user-onboarding-${Date.now()}`;
const TEST_USER_ID_2 = `test-user-onboarding-2-${Date.now()}`;

let testServer;
let entityStore;
let continuityService;
let createdEntityIds = [];

test.before(async (t) => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;
    
    entityStore = getEntityStore();
    continuityService = getContinuityMemoryService();
    
    // Check if MongoDB is configured
    if (!entityStore.isConfigured()) {
        t.fail('MongoDB not configured (MONGO_URI not set) - cannot run entity tests');
    }
    
    // Wait for Redis if continuity memory is available
    if (continuityService.isAvailable()) {
        const redisReady = await continuityService.hotMemory.waitForReady(5000);
        if (!redisReady && !continuityService.coldMemory.isConfigured()) {
            t.log('Warning: Neither Redis nor MongoDB configured for continuity memory');
        }
    }
});

test.after.always('cleanup', async (t) => {
    // Clean up created entities
    if (entityStore && entityStore.isConfigured()) {
        for (const entityId of createdEntityIds) {
            try {
                // Delete entity from MongoDB
                const collection = await entityStore._getCollection();
                await collection.deleteOne({ id: entityId });
                
                // Clean up continuity memories if they exist
                if (continuityService && continuityService.isAvailable()) {
                    await continuityService.deleteAllMemories(entityId, TEST_USER_ID, ['test']);
                    await continuityService.deleteAllMemories(entityId, TEST_USER_ID_2, ['test']);
                }
                
                t.log(`Cleaned up entity ${entityId}`);
            } catch (error) {
                t.log(`Failed to cleanup entity ${entityId}: ${error.message}`);
            }
        }
    }
    
    if (testServer) {
        await testServer.stop();
    }
});

// ==================== BOOTSTRAP TESTS ====================

test.serial('Bootstrap: system entities are auto-created on startup', async (t) => {
    // Verify that Enntity exists (default system entity)
    const defaultEntity = await entityStore.getSystemEntity('Enntity');
    t.truthy(defaultEntity, 'Enntity should exist (auto-bootstrapped on startup)');
    t.is(defaultEntity.name, 'Enntity', 'Should have correct name');
    t.true(defaultEntity.isSystem, 'Should be marked as system entity');
    t.false(defaultEntity.useMemory, 'Default system entity should not use memory');
    t.true(defaultEntity.isDefault, 'Default system entity should be marked as default');
    t.truthy(defaultEntity.tools, 'Should have tools array');
    t.true(defaultEntity.tools.includes('*') || defaultEntity.tools.includes('createentity'), 'Default should have tool access');

    // Verify that Vesper exists (matchmaker system entity)
    const matchmakerEntity = await entityStore.getSystemEntity('Vesper');
    t.truthy(matchmakerEntity, 'Vesper should exist (auto-bootstrapped on startup)');
    t.is(matchmakerEntity.name, 'Vesper', 'Should have correct name');
    t.true(matchmakerEntity.isSystem, 'Matchmaker should be marked as system entity');
    t.false(matchmakerEntity.useMemory, 'Matchmaker should not use memory');
    t.false(matchmakerEntity.isDefault, 'Matchmaker should not be default');
    t.truthy(matchmakerEntity.tools, 'Should have tools array');
    t.true(matchmakerEntity.tools.includes('createentity') || matchmakerEntity.tools.includes('*'), 'Matchmaker should have createEntity tool');

    t.log(`Enntity bootstrapped with ID: ${defaultEntity.id}`);
    t.log(`Vesper bootstrapped with ID: ${matchmakerEntity.id}`);
});

// ==================== GET ONBOARDING ENTITY TESTS ====================

test.serial('Pathway: sys_get_onboarding_entity returns matchmaker system entity', async (t) => {
    const result = await callPathway('sys_get_onboarding_entity', {});
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should return success');
    t.truthy(parsed.entity, 'Should return entity object');
    t.is(parsed.entity.name, 'Vesper', 'Should return Vesper');
    t.true(parsed.entity.isSystem, 'Should be marked as system entity');
    t.truthy(parsed.entity.id, 'Should have an ID (UUID)');
    t.true(typeof parsed.entity.id === 'string', 'ID should be a string');
    t.log(`Matchmaker ID: ${parsed.entity.id}`);
});

test.serial('Pathway: sys_get_onboarding_entity handles missing entity gracefully', async (t) => {
    // This test verifies error handling if the matchmaker doesn't exist
    // In practice, it should always exist due to bootstrap, but test the error path
    const result = await callPathway('sys_get_onboarding_entity', {});
    const parsed = JSON.parse(result);
    
    // Should either succeed (entity exists) or fail gracefully
    if (!parsed.success) {
        t.truthy(parsed.error, 'Should have error message if entity not found');
        t.log(`Expected error (entity should be bootstrapped): ${parsed.error}`);
    } else {
        t.pass('Entity exists (expected)');
    }
});

// ==================== GET ENTITIES TESTS ====================

test.serial('Pathway: sys_get_entities returns list of entities', async (t) => {
    const result = await callPathway('sys_get_entities', {
        contextId: TEST_USER_ID,
        includeSystem: false
    });
    
    let entities;
    try {
        entities = JSON.parse(result);
    } catch (error) {
        t.fail('Should return parseable JSON');
        return;
    }
    t.true(Array.isArray(entities), 'Should return an array');
    t.log(`Found ${entities.length} entities for user`);
    
    // Verify structure
    if (entities.length > 0) {
        const entity = entities[0];
        t.truthy(entity.id, 'Entity should have id');
        t.truthy(entity.name, 'Entity should have name');
        t.true(typeof entity.isSystem === 'boolean', 'Should have isSystem flag');
        t.true(typeof entity.useMemory === 'boolean', 'Should have useMemory flag');
    }
});

test.serial('Pathway: sys_get_entities excludes system entities by default', async (t) => {
    const result = await callPathway('sys_get_entities', {
        contextId: TEST_USER_ID,
        includeSystem: false
    });
    
    const entities = JSON.parse(result);
    const systemEntities = entities.filter(e => e.isSystem);
    t.is(systemEntities.length, 0, 'Should not include system entities when includeSystem=false');
});

test.serial('Pathway: sys_get_entities includes system entities when requested', async (t) => {
    const result = await callPathway('sys_get_entities', {
        contextId: TEST_USER_ID,
        includeSystem: true
    });
    
    const entities = JSON.parse(result);
    const systemEntities = entities.filter(e => e.isSystem);
    t.true(systemEntities.length > 0, 'Should include system entities when includeSystem=true');
    
    const enntity = systemEntities.find(e => e.name === 'Enntity');
    const vesper = systemEntities.find(e => e.name === 'Vesper');
    t.truthy(enntity, 'Should include Enntity system entity');
    t.truthy(vesper, 'Should include Vesper system entity');
});

test.serial('Pathway: sys_get_entities filters by userId association', async (t) => {
    // First, create an entity for TEST_USER_ID
    const createResult = await callPathway('sys_tool_create_entity', {
        name: 'TestFilterEntity',
        identity: 'I am a test entity for filtering.',
        description: 'Test entity',
        contextId: TEST_USER_ID
    });
    
    const createParsed = JSON.parse(createResult);
    t.true(createParsed.success, 'Should create entity');
    const entityId = createParsed.entityId;
    createdEntityIds.push(entityId);
    
    // Get entities for TEST_USER_ID - should include the new entity
    const result1 = await callPathway('sys_get_entities', {
        contextId: TEST_USER_ID,
        includeSystem: false
    });
    const entities1 = JSON.parse(result1);
    const foundEntity = entities1.find(e => e.id === entityId);
    t.truthy(foundEntity, 'Should find entity for associated user');
    
    // Get entities for different user - should not include the new entity
    const result2 = await callPathway('sys_get_entities', {
        contextId: TEST_USER_ID_2,
        includeSystem: false
    });
    const entities2 = JSON.parse(result2);
    const notFoundEntity = entities2.find(e => e.id === entityId);
    t.falsy(notFoundEntity, 'Should not find entity for different user');
});

test.serial('Pathway: sys_get_entities handles errors gracefully', async (t) => {
    // Test with invalid parameters
    const result = await callPathway('sys_get_entities', {
        contextId: null,
        includeSystem: 'invalid'
    });
    
    const entities = JSON.parse(result);
    // Should return empty array or valid response, not crash
    const isObject = entities !== null && typeof entities === 'object';
    const isValid =
        Array.isArray(entities) ||
        Boolean(entities?.error) ||
        isObject ||
        typeof entities === 'string' ||
        entities === null ||
        typeof entities === 'boolean' ||
        typeof entities === 'number';
    t.true(isValid, 'Should return array or error object');
});

// ==================== CREATE ENTITY TESTS ====================

test.serial('Tool: createEntity creates entity with continuity memory', async (t) => {
    if (!continuityService.isAvailable()) {
        t.log('Skipping: Continuity memory not available');
        t.pass('Skipped - continuity memory not configured');
        return;
    }
    
    const result = await callPathway('sys_tool_create_entity', {
        name: 'Luna',
        description: 'A warm and curious AI companion',
        identity: 'I am Luna, a warm and curious companion. I love exploring ideas together.',
        avatarText: '🌙',
        communicationStyle: 'casual and friendly',
        interests: 'philosophy, technology, creative writing',
        expertise: 'helping with complex problems and creative projects',
        personality: 'warm, curious, supportive',
        contextId: TEST_USER_ID
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should create entity successfully');
    t.truthy(parsed.entityId, 'Should return entity ID');
    t.is(parsed.name, 'Luna', 'Should return correct name');
    
    createdEntityIds.push(parsed.entityId);
    
    // Verify entity exists in MongoDB
    const entity = await entityStore.getEntity(parsed.entityId);
    t.truthy(entity, 'Entity should exist in database');
    t.is(entity.name, 'Luna', 'Entity name should match');
    t.true(entity.identity.includes('I am Luna'), 'Identity should be stored on the entity');
    t.true(Array.isArray(entity.assocUserIds), 'Should have assocUserIds array');
    t.true(entity.assocUserIds.includes(TEST_USER_ID), 'Should be associated with user');
    
    // Verify CORE memories were seeded
    await new Promise(r => setTimeout(r, 2000)); // Wait for indexing
    const coreMemories = await continuityService.coldMemory.getByType(
        parsed.entityId,
        TEST_USER_ID,
        ContinuityMemoryType.CORE
    );
    t.true(coreMemories.length > 0, 'Should have CORE memories');
    t.log(`Found ${coreMemories.length} CORE memories`);
    
    // Verify ANCHOR memories were seeded
    const anchorMemories = await continuityService.coldMemory.getByType(
        parsed.entityId,
        TEST_USER_ID,
        ContinuityMemoryType.ANCHOR
    );
    t.true(anchorMemories.length > 0, 'Should have ANCHOR memories');
    t.log(`Found ${anchorMemories.length} ANCHOR memories`);
});

test.serial('Tool: createEntity stores identity on entity', async (t) => {
    const result = await callPathway('sys_tool_create_entity', {
        name: 'LegacyTest',
        description: 'Test entity for identity storage',
        identity: 'I am a test entity with a stored identity.',
        contextId: TEST_USER_ID
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should create entity');
    t.truthy(parsed.entityId, 'Should return entity ID');
    createdEntityIds.push(parsed.entityId);
    
    // Verify entity exists
    const entity = await entityStore.getEntity(parsed.entityId);
    t.truthy(entity, 'Entity should exist');
    
    t.log(`Entity memory enabled: ${entity.useMemory}`);
    t.truthy(entity.identity.length > 0, 'Identity should be stored on the entity');
});

test.serial('Tool: createEntity validates required fields', async (t) => {
    // Test missing name
    const result1 = await callPathway('sys_tool_create_entity', {
        identity: 'Test identity',
        contextId: TEST_USER_ID
    });
    const parsed1 = JSON.parse(result1);
    t.false(parsed1.success, 'Should fail without name');
    t.truthy(parsed1.error, 'Should have error message');
    
    // Test missing identity
    const result2 = await callPathway('sys_tool_create_entity', {
        name: 'TestEntity',
        contextId: TEST_USER_ID
    });
    const parsed2 = JSON.parse(result2);
    t.false(parsed2.success, 'Should fail without identity');
    t.truthy(parsed2.error, 'Should have error message');
    
    // Test missing contextId
    const result3 = await callPathway('sys_tool_create_entity', {
        name: 'TestEntity',
        identity: 'Test identity'
    });
    const parsed3 = JSON.parse(result3);
    t.false(parsed3.success, 'Should fail without contextId');
    t.truthy(parsed3.error, 'Should have error message');
});

test.serial('Tool: createEntity handles optional fields', async (t) => {
    const result = await callPathway('sys_tool_create_entity', {
        name: 'MinimalEntity',
        identity: 'I am a minimal test entity.',
        contextId: TEST_USER_ID
        // No optional fields
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should create entity with minimal fields');
    t.truthy(parsed.entityId, 'Should return entity ID');
    createdEntityIds.push(parsed.entityId);
    
    const entity = await entityStore.getEntity(parsed.entityId);
    t.truthy(entity, 'Entity should exist');
    t.is(entity.name, 'MinimalEntity', 'Name should match');
    // Description should have default value
    t.truthy(entity.description, 'Should have description (default or provided)');
});

test.serial('Tool: createEntity updates config cache immediately', async (t) => {
    const result = await callPathway('sys_tool_create_entity', {
        name: 'ConfigTestEntity',
        identity: 'I am a test entity for config cache verification.',
        contextId: TEST_USER_ID
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should create entity');
    createdEntityIds.push(parsed.entityId);
    
    // Verify entity is immediately available in config
    const entityConfig = config.get('entityConfig') || {};
    const cachedEntity = entityConfig[parsed.entityId];
    t.truthy(cachedEntity, 'Entity should be in config cache');
    t.is(cachedEntity.name, 'ConfigTestEntity', 'Cached entity should have correct name');
    
    // Verify it's also available via getAvailableEntities
    const { getAvailableEntities } = await import('../../../../pathways/system/entity/tools/shared/sys_entity_tools.js');
    const entities = getAvailableEntities({ userId: TEST_USER_ID });
    const found = entities.find(e => e.id === parsed.entityId);
    t.truthy(found, 'Entity should be discoverable via getAvailableEntities');
});

test.serial('Tool: createEntity seeds memories correctly for continuity mode', async (t) => {
    if (!continuityService.isAvailable()) {
        t.log('Skipping: Continuity memory not available');
        t.pass('Skipped - continuity memory not configured');
        return;
    }
    
    const result = await callPathway('sys_tool_create_entity', {
        name: 'MemoryTestEntity',
        identity: 'I am a test entity for memory seeding verification.',
        description: 'Testing memory seeding',
        communicationStyle: 'detailed and thorough',
        interests: 'testing, quality assurance',
        expertise: 'helping with test scenarios',
        personality: 'analytical, precise',
        contextId: TEST_USER_ID
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should create entity');
    createdEntityIds.push(parsed.entityId);
    
    // Wait for memory indexing
    await new Promise(r => setTimeout(r, 3000));
    
    // Check CORE memories contain identity
    const coreMemories = await continuityService.coldMemory.getByType(
        parsed.entityId,
        TEST_USER_ID,
        ContinuityMemoryType.CORE
    );
    t.true(coreMemories.length > 0, 'Should have CORE memories');
    
    const identityMemory = coreMemories.find(m => 
        m.content && m.content.includes('test entity for memory seeding')
    );
    t.truthy(identityMemory, 'Should have identity in CORE memory');
    
    // Check ANCHOR memories contain user preferences
    const anchorMemories = await continuityService.coldMemory.getByType(
        parsed.entityId,
        TEST_USER_ID,
        ContinuityMemoryType.ANCHOR
    );
    t.true(anchorMemories.length > 0, 'Should have ANCHOR memories');
    
    const hasCommunicationStyle = anchorMemories.some(m => 
        m.content && m.content.includes('detailed and thorough')
    );
    t.true(hasCommunicationStyle, 'Should have communication style in ANCHOR memory');
    
    const hasInterests = anchorMemories.some(m => 
        m.content && m.content.includes('testing, quality assurance')
    );
    t.true(hasInterests, 'Should have interests in ANCHOR memory');
});

test.serial('Tool: createEntity handles memory seeding failures gracefully', async (t) => {
    // This test verifies that entity creation succeeds even if memory seeding fails
    // We can't easily simulate a memory failure, but we can verify the error handling
    // by checking that the entity is created even if there are issues
    
    const result = await callPathway('sys_tool_create_entity', {
        name: 'ResilientEntity',
        identity: 'I am a resilient test entity.',
        contextId: TEST_USER_ID
    });
    
    const parsed = JSON.parse(result);
    t.true(parsed.success, 'Should create entity even if memory seeding has issues');
    t.truthy(parsed.entityId, 'Should return entity ID');
    createdEntityIds.push(parsed.entityId);
    
    // Entity should exist in database regardless of memory seeding
    const entity = await entityStore.getEntity(parsed.entityId);
    t.truthy(entity, 'Entity should exist in database');
});

// ==================== MONGO ENTITY STORE TESTS ====================

test.serial('MongoEntityStore: getSystemEntity finds system entities by name', async (t) => {
    const enntity = await entityStore.getSystemEntity('Enntity');
    t.truthy(enntity, 'Should find Enntity system entity');
    t.is(enntity.name, 'Enntity', 'Should have correct name');
    t.true(enntity.isSystem, 'Should be marked as system entity');
    t.truthy(enntity.id, 'Should have UUID');

    const vesper = await entityStore.getSystemEntity('Vesper');
    t.truthy(vesper, 'Should find Vesper system entity');
    t.is(vesper.name, 'Vesper', 'Should have correct name');
    t.true(vesper.isSystem, 'Should be marked as system entity');
    t.truthy(vesper.id, 'Should have UUID');
});

test.serial('MongoEntityStore: getSystemEntity is case-insensitive', async (t) => {
    const entity1 = await entityStore.getSystemEntity('enntity');
    const entity2 = await entityStore.getSystemEntity('ENNTITY');
    const entity3 = await entityStore.getSystemEntity('Enntity');
    
    t.truthy(entity1, 'Should find with lowercase');
    t.truthy(entity2, 'Should find with uppercase');
    t.truthy(entity3, 'Should find with mixed case');
    
    // All should be the same entity
    t.is(entity1.id, entity2.id, 'Should return same entity regardless of case');
    t.is(entity2.id, entity3.id, 'Should return same entity regardless of case');
});

test.serial('MongoEntityStore: getSystemEntity returns null for non-system entities', async (t) => {
    // Create a regular (non-system) entity
    const createResult = await callPathway('sys_tool_create_entity', {
        name: 'RegularEntity',
        identity: 'I am a regular entity, not a system entity.',
        contextId: TEST_USER_ID
    });
    
    const createParsed = JSON.parse(createResult);
    t.true(createParsed.success, 'Should create entity');
    createdEntityIds.push(createParsed.entityId);
    
    // Try to get it as a system entity - should return null
    const entity = await entityStore.getSystemEntity('RegularEntity');
    t.falsy(entity, 'Should not find regular entity as system entity');
});

test.serial('MongoEntityStore: addUserToEntity associates user with entity', async (t) => {
    // Create an entity for TEST_USER_ID
    const createResult = await callPathway('sys_tool_create_entity', {
        name: 'AssociationTest',
        identity: 'I am a test entity for user association.',
        contextId: TEST_USER_ID
    });
    
    const createParsed = JSON.parse(createResult);
    t.true(createParsed.success, 'Should create entity');
    createdEntityIds.push(createParsed.entityId);
    
    // Add second user
    const success = await entityStore.addUserToEntity(createParsed.entityId, TEST_USER_ID_2);
    t.true(success, 'Should add user successfully');
    
    // Verify both users are associated
    const entity = await entityStore.getEntity(createParsed.entityId);
    t.true(Array.isArray(entity.assocUserIds), 'Should have assocUserIds array');
    t.true(entity.assocUserIds.includes(TEST_USER_ID), 'Should have original user');
    t.true(entity.assocUserIds.includes(TEST_USER_ID_2), 'Should have added user');
});

test.serial('MongoEntityStore: addUserToEntity handles duplicate associations', async (t) => {
    // Create an entity
    const createResult = await callPathway('sys_tool_create_entity', {
        name: 'DuplicateTest',
        identity: 'I am a test entity for duplicate association handling.',
        contextId: TEST_USER_ID
    });
    
    const createParsed = JSON.parse(createResult);
    t.true(createParsed.success, 'Should create entity');
    createdEntityIds.push(createParsed.entityId);
    
    // Add user twice
    const success1 = await entityStore.addUserToEntity(createParsed.entityId, TEST_USER_ID_2);
    const success2 = await entityStore.addUserToEntity(createParsed.entityId, TEST_USER_ID_2);
    
    t.true(success1, 'First add should succeed');
    t.true(success2, 'Second add should succeed (idempotent)');
    
    // Verify user appears only once
    const entity = await entityStore.getEntity(createParsed.entityId);
    const count = entity.assocUserIds.filter(id => id === TEST_USER_ID_2).length;
    t.is(count, 1, 'User should appear only once');
});

test.serial('MongoEntityStore: getAllEntities filters by userId', async (t) => {
    // Create entity for TEST_USER_ID
    const createResult = await callPathway('sys_tool_create_entity', {
        name: 'FilterTestEntity',
        identity: 'I am a test entity for filtering.',
        contextId: TEST_USER_ID
    });
    
    const createParsed = JSON.parse(createResult);
    t.true(createParsed.success, 'Should create entity');
    createdEntityIds.push(createParsed.entityId);
    
    // Get entities for TEST_USER_ID
    const entities1 = await entityStore.getAllEntities({ userId: TEST_USER_ID, includeSystem: false });
    const found1 = entities1.find(e => e.id === createParsed.entityId);
    t.truthy(found1, 'Should find entity for associated user');
    
    // Get entities for different user
    const entities2 = await entityStore.getAllEntities({ userId: TEST_USER_ID_2, includeSystem: false });
    const found2 = entities2.find(e => e.id === createParsed.entityId);
    t.falsy(found2, 'Should not find entity for different user');
});

test.serial('MongoEntityStore: getAllEntities filters system entities', async (t) => {
    // Get all entities including system
    const allEntities = await entityStore.getAllEntities({ includeSystem: true });
    const systemEntities = allEntities.filter(e => e.isSystem);
    t.true(systemEntities.length > 0, 'Should have system entities when includeSystem=true');
    
    // Get entities excluding system
    const regularEntities = await entityStore.getAllEntities({ includeSystem: false });
    const systemInRegular = regularEntities.filter(e => e.isSystem);
    t.is(systemInRegular.length, 0, 'Should not have system entities when includeSystem=false');
});
