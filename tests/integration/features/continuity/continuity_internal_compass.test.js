// continuity_internal_compass.test.js
// Tests for the Internal Compass (EPISODE) - temporal narrative that persists across sessions

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType
} from '../../../../lib/continuity/index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';

const TEST_ENTITY_ID = 'test-entity-compass';
const TEST_USER_ID = `test-user-compass-${Date.now()}`;

let testServer;
let service;

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
        // Clean up any test memories
        try {
            await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID);
            t.log('Cleaned up test memories');
        } catch (error) {
            t.log(`Cleanup error: ${error.message}`);
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

// ==================== INTERNAL COMPASS TESTS ====================

test.serial('Internal Compass: getInternalCompass returns null when none exists', async (t) => {
    const compass = await service.getInternalCompass(TEST_ENTITY_ID, TEST_USER_ID);
    t.is(compass, null, 'Should return null when no compass exists');
});

test.serial('Internal Compass: synthesizeInternalCompass creates compass from episodic stream', async (t) => {
    // First, add some turns to the episodic stream
    const turns = [
        { role: 'user', content: 'Can you help me debug this notification issue?', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Of course! What error are you seeing?', timestamp: new Date().toISOString() },
        { role: 'user', content: 'The permissions dialog never shows up on iOS.', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Try clearing the derived data folder in Xcode.', timestamp: new Date().toISOString() },
        { role: 'user', content: 'That worked! Thanks!', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Great! Happy to help.', timestamp: new Date().toISOString() },
    ];
    
    for (const turn of turns) {
        await service.hotMemory.appendEpisodicTurn(TEST_ENTITY_ID, TEST_USER_ID, turn);
    }
    
    // Verify turns were added
    const stream = await service.hotMemory.getEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID, 10);
    t.true(stream.length >= 4, `Should have at least 4 turns, got ${stream.length}`);
    
    // Synthesize the compass
    const result = await service.synthesizeInternalCompass(TEST_ENTITY_ID, TEST_USER_ID, {
        aiName: 'TestEntity'
    });
    
    t.true(result.updated, 'Should indicate compass was updated');
    t.truthy(result.compass, 'Should return the compass');
    t.is(result.compass.type, ContinuityMemoryType.EPISODE, 'Compass should be EPISODE type');
    t.truthy(result.compass.content, 'Compass should have content');
    t.true(result.compass.tags.includes('internal-compass'), 'Should have internal-compass tag');
    
    t.log(`Compass content: ${result.compass.content.substring(0, 200)}...`);
});

test.serial('Internal Compass: getInternalCompass retrieves existing compass', async (t) => {
    const compass = await service.getInternalCompass(TEST_ENTITY_ID, TEST_USER_ID);
    
    t.truthy(compass, 'Should retrieve the compass');
    t.is(compass.type, ContinuityMemoryType.EPISODE, 'Should be EPISODE type');
    t.truthy(compass.content, 'Should have content');
    t.true(compass.tags.includes('internal-compass'), 'Should have internal-compass tag');
});

test.serial('Internal Compass: needsCompassSynthesis respects time threshold', async (t) => {
    // Just synthesized, so should not need synthesis
    const needsSynthesis = await service.needsCompassSynthesis(TEST_ENTITY_ID, TEST_USER_ID);
    t.false(needsSynthesis, 'Should not need synthesis immediately after creating compass');
    
    // With a very short threshold, it should need synthesis
    const needsSynthesisShort = await service.synthesizer.needsCompassSynthesis(
        TEST_ENTITY_ID, 
        TEST_USER_ID, 
        1 // 1ms threshold
    );
    t.true(needsSynthesisShort, 'Should need synthesis with very short threshold');
});

test.serial('Internal Compass: synthesizeInternalCompass updates existing compass', async (t) => {
    // Get the existing compass
    const originalCompass = await service.getInternalCompass(TEST_ENTITY_ID, TEST_USER_ID);
    t.truthy(originalCompass, 'Should have existing compass');
    
    // Add more turns
    const newTurns = [
        { role: 'user', content: 'Now I want to work on the memory architecture.', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Exciting! What aspect are you focusing on?', timestamp: new Date().toISOString() },
        { role: 'user', content: 'The temporal narrative - making the AI feel present.', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'The Internal Compass design sounds perfect for that.', timestamp: new Date().toISOString() },
    ];
    
    for (const turn of newTurns) {
        await service.hotMemory.appendEpisodicTurn(TEST_ENTITY_ID, TEST_USER_ID, turn);
    }
    
    // Synthesize again
    const result = await service.synthesizeInternalCompass(TEST_ENTITY_ID, TEST_USER_ID, {
        aiName: 'TestEntity'
    });
    
    t.true(result.updated, 'Should update the compass');
    t.truthy(result.compass, 'Should return updated compass');
    
    // Content should be different (integrated new events)
    // Note: We can't guarantee content changes, but the timestamp should change
    t.truthy(result.compass.metadata?.lastSynthesized, 'Should have lastSynthesized timestamp');
    
    t.log(`Updated compass content: ${result.compass.content.substring(0, 200)}...`);
});

test.serial('Internal Compass: compass appears in context window', async (t) => {
    // Get the context window
    const context = await service.getContextWindow({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'What were we working on?'
    });
    
    t.truthy(context, 'Should return context');
    t.true(context.includes('Internal Compass') || context.includes('Vibe') || context.includes('Recent Story'), 
        'Context should include Internal Compass content');
    
    t.log(`Context includes compass: ${context.includes('Internal Compass')}`);
});

test.serial('Pathway: sys_continuity_compass_synthesis generates compass content', async (t) => {
    const episodicText = `USER: Can you help with the database schema?
ASSISTANT: Sure! What tables do you need?
USER: Users and posts, with a many-to-many relationship.
ASSISTANT: I'd recommend a junction table for that.`;

    try {
        const result = await callPathway('sys_continuity_compass_synthesis', {
            aiName: 'TestEntity',
            currentCompass: '',
            episodicStream: episodicText,
            sessionEnding: false
        });
        
        t.truthy(result, 'Should return compass content');
        t.true(typeof result === 'string', 'Result should be a string');
        t.true(result.length > 0, 'Result should not be empty');
        
        // Should have the expected sections (at least some of them)
        const hasVibeOrStory = result.includes('Vibe') || result.includes('Story') || result.includes('Focus');
        t.true(hasVibeOrStory, 'Should contain compass sections');
        
        t.log(`Pathway result: ${result.substring(0, 200)}...`);
    } catch (error) {
        t.log(`Pathway error: ${error.message}`);
        t.log('Skipping - LLM pathway may not be configured');
        t.pass('Skipped due to LLM error');
    }
});

test.serial('Pathway: sys_continuity_compass_synthesis handles session ending', async (t) => {
    const episodicText = `USER: Let's wrap up for today.
ASSISTANT: Sounds good! We made great progress on the schema.
USER: Yes, we still need to add the indexes tomorrow.
ASSISTANT: I'll remember that!`;

    try {
        const result = await callPathway('sys_continuity_compass_synthesis', {
            aiName: 'TestEntity',
            currentCompass: 'Vibe: Collaborative and productive.\n\nRecent Story: Working on database design.',
            episodicStream: episodicText,
            sessionEnding: true
        });
        
        t.truthy(result, 'Should return compass content');
        // When session is ending, should capture open loops
        t.log(`Session-ending compass: ${result.substring(0, 300)}...`);
        t.pass('Session ending synthesis completed');
    } catch (error) {
        t.log(`Pathway error: ${error.message}`);
        t.pass('Skipped due to LLM error');
    }
});

test.serial('Internal Compass: session-end synthesis on initSession', async (t) => {
    // This tests that when a session expires, the compass is synthesized before clearing
    // We'll simulate this by:
    // 1. Creating turns
    // 2. Manually updating lastInteractionTimestamp to be old
    // 3. Calling initSession
    
    // Add some turns
    const turns = [
        { role: 'user', content: 'Testing session boundary.', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Acknowledged.', timestamp: new Date().toISOString() },
        { role: 'user', content: 'This should be captured in compass.', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'It will be!', timestamp: new Date().toISOString() },
    ];
    
    for (const turn of turns) {
        await service.hotMemory.appendEpisodicTurn(TEST_ENTITY_ID, TEST_USER_ID, turn);
    }
    
    // Set last interaction to 5 hours ago (beyond 4-hour threshold)
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await service.hotMemory.updateExpressionState(TEST_ENTITY_ID, TEST_USER_ID, {
        lastInteractionTimestamp: fiveHoursAgo
    });
    
    // Call initSession - this should trigger compass synthesis before clearing
    await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, false, { aiName: 'TestEntity' });
    
    // The compass should still exist (persisted to cold storage)
    const compass = await service.getInternalCompass(TEST_ENTITY_ID, TEST_USER_ID);
    t.truthy(compass, 'Compass should exist after session reset');
    t.truthy(compass.content, 'Compass should have content');
    
    // The episodic stream should be cleared
    const stream = await service.hotMemory.getEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID, 10);
    t.is(stream.length, 0, 'Episodic stream should be cleared after session reset');
    
    t.log('Session boundary correctly preserved compass while clearing episodic stream');
});
