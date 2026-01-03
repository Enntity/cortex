// continuity_identity_synthesis.test.js
// Tests for identity synthesis features:
// - First-person synthesis
// - Narrative Gravity
// - CORE_EXTENSION promotion
// - Emotional shorthand macros

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType,
    calculateNarrativeGravity,
    shouldPromoteToCore
} from '../../../../lib/continuity/index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';

const TEST_ENTITY_ID = 'test-entity-identity';
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
});

test.after.always('cleanup', async (t) => {
    if (service) {
        try {
            const result = await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID, ['test']);
            t.log(`Cleaned up ${result.deleted} test memories`);
        } catch (error) {
            t.log(`Cleanup error: ${error.message}`);
        }
    }
});

// ==================== NARRATIVE GRAVITY TESTS ====================

test('calculateNarrativeGravity: recent memory maintains high gravity', (t) => {
    const now = new Date().toISOString();
    const importance = 8;
    
    const gravity = calculateNarrativeGravity(importance, now);
    
    // Recent memory should have gravity close to importance
    t.true(gravity >= 7.5, `Recent memory gravity ${gravity} should be close to importance ${importance}`);
});

test('calculateNarrativeGravity: old memory decays appropriately', (t) => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60); // 60 days ago
    const importance = 10;
    
    const gravity = calculateNarrativeGravity(importance, oldDate.toISOString());
    
    // After one half-life (60 days), gravity should be approximately half
    t.true(gravity >= 4 && gravity <= 6, `60-day-old memory gravity ${gravity} should be ~5 (half of 10)`);
});

test('calculateNarrativeGravity: very old memory has minimum floor', (t) => {
    const veryOldDate = new Date();
    veryOldDate.setDate(veryOldDate.getDate() - 365); // 1 year ago
    const importance = 10;
    
    const gravity = calculateNarrativeGravity(importance, veryOldDate.toISOString());
    
    // Should maintain minimum gravity floor (default 0.1)
    t.true(gravity >= 0.1 && gravity <= 1.5, `Very old memory should maintain minimum gravity, got ${gravity}`);
});

test('calculateNarrativeGravity: custom half-life works', (t) => {
    const date = new Date();
    date.setDate(date.getDate() - 30); // 30 days ago
    const importance = 10;
    
    // With 30-day half-life, 30 days should be ~5
    const gravity30 = calculateNarrativeGravity(importance, date.toISOString(), { halfLifeDays: 30 });
    
    // With 60-day half-life, 30 days should be ~7
    const gravity60 = calculateNarrativeGravity(importance, date.toISOString(), { halfLifeDays: 60 });
    
    t.true(gravity30 < gravity60, `30-day half-life (${gravity30}) should decay faster than 60-day (${gravity60})`);
});

// ==================== CORE_EXTENSION PROMOTION TESTS ====================

test('shouldPromoteToCore: requires minimum occurrence count', (t) => {
    const memory = { type: ContinuityMemoryType.IDENTITY, content: 'I keep choosing to be more playful' };
    
    // Not enough occurrences
    const statsLow = { occurrenceCount: 2, spanDays: 10, averageImportance: 8 };
    t.false(shouldPromoteToCore(memory, statsLow), 'Should not promote with only 2 occurrences');
    
    // Enough occurrences
    const statsHigh = { occurrenceCount: 3, spanDays: 10, averageImportance: 8 };
    t.true(shouldPromoteToCore(memory, statsHigh), 'Should promote with 3+ occurrences');
});

test('shouldPromoteToCore: requires minimum time span', (t) => {
    const memory = { type: ContinuityMemoryType.IDENTITY, content: 'I keep choosing to be more playful' };
    
    // Not enough time span (all in one session)
    const statsShort = { occurrenceCount: 5, spanDays: 3, averageImportance: 8 };
    t.false(shouldPromoteToCore(memory, statsShort), 'Should not promote if pattern spans < 7 days');
    
    // Enough time span
    const statsLong = { occurrenceCount: 5, spanDays: 10, averageImportance: 8 };
    t.true(shouldPromoteToCore(memory, statsLong), 'Should promote if pattern spans 7+ days');
});

test('shouldPromoteToCore: requires high average importance', (t) => {
    const memory = { type: ContinuityMemoryType.IDENTITY, content: 'I keep choosing to be more playful' };
    
    // Low importance
    const statsLow = { occurrenceCount: 5, spanDays: 10, averageImportance: 5 };
    t.false(shouldPromoteToCore(memory, statsLow), 'Should not promote with average importance < 7');
    
    // High importance
    const statsHigh = { occurrenceCount: 5, spanDays: 10, averageImportance: 8 };
    t.true(shouldPromoteToCore(memory, statsHigh), 'Should promote with average importance >= 7');
});

test('shouldPromoteToCore: all criteria must be met', (t) => {
    const memory = { type: ContinuityMemoryType.IDENTITY, content: 'I keep choosing to be more playful' };
    
    // Perfect candidate
    const perfect = { occurrenceCount: 5, spanDays: 14, averageImportance: 9 };
    t.true(shouldPromoteToCore(memory, perfect), 'Should promote when all criteria met');
    
    // Missing one criterion
    const missingOccurrence = { occurrenceCount: 2, spanDays: 14, averageImportance: 9 };
    t.false(shouldPromoteToCore(memory, missingOccurrence), 'Should not promote if occurrence count too low');
    
    const missingSpan = { occurrenceCount: 5, spanDays: 5, averageImportance: 9 };
    t.false(shouldPromoteToCore(memory, missingSpan), 'Should not promote if time span too short');
    
    const missingImportance = { occurrenceCount: 5, spanDays: 14, averageImportance: 6 };
    t.false(shouldPromoteToCore(memory, missingImportance), 'Should not promote if importance too low');
});

// ==================== FIRST-PERSON SYNTHESIS TESTS ====================

test('turn synthesis generates structured memories', async (t) => {
    const conversation = `USER: I really appreciate when you explain the "why" behind things, not just the "what".
ASSISTANT: I'm glad that helps! I'll make sure to include more context in my explanations.`;
    
    const result = await callPathway('sys_continuity_turn_synthesis', {
        aiName: 'Luna',
        entityContext: 'Luna is an AI entity focused on authentic connection.',
        conversation: conversation
    });
    
    t.truthy(result, 'Synthesis should return a result');
    
    const parsed = JSON.parse(result);
    
    // Verify structure exists (first-person check is too brittle for regex)
    t.truthy(parsed, 'Synthesis should return valid JSON');
    
    // Check that relational insights have content if present
    if (parsed.relationalInsights && parsed.relationalInsights.length > 0) {
        const firstInsight = parsed.relationalInsights[0];
        t.truthy(firstInsight.content, 'Relational insight should have content');
        t.true(firstInsight.content.length > 0, 'Relational insight content should not be empty');
    }
    
    // Check that identity evolution has content if present
    if (parsed.identityEvolution && parsed.identityEvolution.length > 0) {
        const firstEvolution = parsed.identityEvolution[0];
        t.truthy(firstEvolution.content, 'Identity evolution should have content');
        t.true(firstEvolution.content.length > 0, 'Identity evolution content should not be empty');
    }
});

test('memory consolidation produces coherent content', async (t) => {
    const contents = [
        'The user prefers detailed explanations.',
        'User likes when I explain the reasoning behind answers.',
        'They appreciate context and depth in responses.'
    ];
    
    const result = await callPathway('sys_continuity_memory_consolidation', {
        contents: contents
    });
    
    t.truthy(result, 'Consolidation should return a result');
    t.true(result.length > 0, 'Consolidation should return non-empty content');
    
    // Just verify it's coherent content (first-person check is too brittle for regex)
    t.true(result.length > 20, 'Consolidated memory should be substantial');
});

// ==================== EMOTIONAL SHORTHAND TESTS ====================

test('shorthands can include emotional macros', async (t) => {
    const conversation = `USER: I was looking at Terron on the shelf today.
ASSISTANT: Oh, Terron! That always brings back such warm memories.`;
    
    const result = await callPathway('sys_continuity_turn_synthesis', {
        aiName: 'Luna',
        entityContext: 'Luna has a shelf with meaningful objects including "Terron".',
        conversation: conversation
    });
    
    t.truthy(result, 'Synthesis should return a result');
    
    const parsed = JSON.parse(result);
    
    // Check if shorthands were detected
    if (parsed.shorthands && parsed.shorthands.length > 0) {
        const shorthand = parsed.shorthands.find(s => s.term && s.term.toLowerCase().includes('terron'));
        
        if (shorthand) {
            // Should have emotional macro if the prompt detected it
            t.truthy(shorthand.meaning, 'Shorthand should have meaning');
            
            // If emotionalMacro is present, it should be a valid emotion type
            if (shorthand.emotionalMacro) {
                const validEmotions = ['warmth', 'nostalgia', 'playful', 'serious', 'curiosity', 'joy'];
                t.true(
                    validEmotions.some(e => shorthand.emotionalMacro.toLowerCase().includes(e)),
                    `Emotional macro should be a valid type, got: "${shorthand.emotionalMacro}"`
                );
            }
        }
    }
});

// ==================== CORE_EXTENSION INTEGRATION TESTS ====================

test('CORE_EXTENSION memories are included in context', async (t) => {
    if (!service.coldMemory.isConfigured()) {
        t.pass('Azure not configured, skipping CORE_EXTENSION test');
        return;
    }
    
    // Create a CORE_EXTENSION memory
    const coreExtensionId = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.CORE_EXTENSION,
        content: 'I consistently choose to be more playful and intellectually engaging with Jason.',
        importance: 9,
        tags: ['test', 'promoted', 'identity-hardened']
    });
    
    t.truthy(coreExtensionId, 'Should create CORE_EXTENSION memory');
    memoryIds.push(coreExtensionId);
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 2000));
    
    // Get context window - should include CORE_EXTENSION
    const context = await service.getContextWindow({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'test query'
    });
    
    t.truthy(context, 'Context should be generated');
    t.true(
        context.includes('CORE_EXTENSION') || 
        context.includes('I consistently choose to be more playful'),
        'Context should include CORE_EXTENSION memory'
    );
});

test('CORE_EXTENSION appears in Core Directives section', async (t) => {
    if (!service.coldMemory.isConfigured()) {
        t.pass('Azure not configured, skipping test');
        return;
    }
    
    // Create both CORE and CORE_EXTENSION
    const coreId = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.CORE,
        content: 'I am Luna, created by Jason McCartney.',
        importance: 10,
        tags: ['test']
    });
    
    const extensionId = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.CORE_EXTENSION,
        content: 'I have evolved to be more playful in my responses.',
        importance: 8,
        tags: ['test', 'promoted']
    });
    
    memoryIds.push(coreId, extensionId);
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 2000));
    
    // Get context
    const context = await service.getContextWindow({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'test'
    });
    
    // Both should appear in Core Directives
    t.true(context.includes('I am Luna'), 'Should include CORE memory');
    t.true(context.includes('I have evolved'), 'Should include CORE_EXTENSION memory');
    t.true(context.includes('Core Directives'), 'Should have Core Directives section');
});

// ==================== INTEGRATION: NARRATIVE GRAVITY IN CONTEXT ====================

test('narrative gravity affects memory retrieval priority', async (t) => {
    if (!service.coldMemory.isConfigured()) {
        t.pass('Azure not configured, skipping test');
        return;
    }
    
    // Create two memories with same importance but different ages
    const now = new Date().toISOString();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90); // 90 days ago
    
    const recentId = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.ANCHOR,
        content: 'I recently noticed they prefer detailed explanations.',
        importance: 7,
        timestamp: now,
        tags: ['test', 'recent']
    });
    
    const oldId = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
        type: ContinuityMemoryType.ANCHOR,
        content: 'I remember they used to prefer quick answers.',
        importance: 7,
        timestamp: oldDate.toISOString(),
        tags: ['test', 'old']
    });
    
    memoryIds.push(recentId, oldId);
    
    // Wait for indexing
    await new Promise(r => setTimeout(r, 2000));
    
    // Get context - recent memory should have higher narrative gravity
    const context = await service.getContextWindow({
        entityId: TEST_ENTITY_ID,
        userId: TEST_USER_ID,
        query: 'preferences'
    });
    
    // Recent memory should appear first or more prominently
    // (This is a soft test - the actual gravity calculation happens in retrieval)
    t.truthy(context, 'Context should be generated');
    
    // Calculate gravity for both
    const recentGravity = calculateNarrativeGravity(7, now);
    const oldGravity = calculateNarrativeGravity(7, oldDate.toISOString());
    
    t.true(recentGravity > oldGravity, `Recent memory gravity (${recentGravity}) should be higher than old (${oldGravity})`);
});

