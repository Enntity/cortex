// continuity_eidos.test.js
// Integration tests for the Eidos introspective monitoring layer

import test from 'ava';
import serverFactory from '../../../../index.js';
import {
    getContinuityMemoryService,
    ContinuityMemoryType
} from '../../../../lib/continuity/index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';

const TEST_ENTITY_ID = 'test-entity-eidos';
const TEST_USER_ID = `test-user-eidos-${Date.now()}`;

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
        try {
            await service.deleteAllMemories(TEST_ENTITY_ID, TEST_USER_ID);
            t.log('Cleaned up test memories');
        } catch (error) {
            t.log(`Cleanup error: ${error.message}`);
        }

        await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
        service.close();
    }

    if (testServer) {
        await testServer.stop();
    }
});

// ==================== EIDOS REDIS STORAGE ====================

test.serial('Eidos: getEidosMetrics returns null when no metrics exist', async (t) => {
    const metrics = await service.hotMemory.getEidosMetrics(TEST_ENTITY_ID, TEST_USER_ID);
    t.is(metrics, null);
});

test.serial('Eidos: updateEidosMetrics stores and retrieves metrics', async (t) => {
    await service.hotMemory.updateEidosMetrics(TEST_ENTITY_ID, TEST_USER_ID, {
        authenticityScores: [0.95, 0.88, 0.92],
        resonanceMetrics: { anchorRate: 1, trend: 'stable', attunementRatio: 0.6 },
        turnCount: 5,
    });

    const metrics = await service.hotMemory.getEidosMetrics(TEST_ENTITY_ID, TEST_USER_ID);
    t.truthy(metrics);
    t.deepEqual(metrics.authenticityScores, [0.95, 0.88, 0.92]);
    t.is(metrics.turnCount, 5);
    t.is(metrics.resonanceMetrics.trend, 'stable');
});

test.serial('Eidos: incrementEidosTurnCount increments correctly', async (t) => {
    // Reset
    await service.hotMemory.updateEidosMetrics(TEST_ENTITY_ID, TEST_USER_ID, { turnCount: 0 });

    const count1 = await service.hotMemory.incrementEidosTurnCount(TEST_ENTITY_ID, TEST_USER_ID);
    t.is(count1, 1);

    const count2 = await service.hotMemory.incrementEidosTurnCount(TEST_ENTITY_ID, TEST_USER_ID);
    t.is(count2, 2);
});

// ==================== COMPASS WITH MIRROR SECTION ====================

test.serial('Eidos: compass synthesis includes Mirror section when eidosMetrics provided', async (t) => {
    const compassResult = await callPathway('sys_continuity_compass_synthesis', {
        aiName: 'TestEntity',
        currentCompass: 'Vibe: Focused energy\n\nRecent Topics:\n1. Testing Eidos\n2. Memory architecture\n3. Redis patterns\n4. LLM synthesis\n5. Identity evolution\n\nRecent Story: We have been working on the Eidos framework.\n\nOpen Loops:\n- Finish integration tests\n\nMy Note: Excited about this new layer.',
        episodicStream: 'USER: How is the Eidos integration going?\n\nASSISTANT: The integration is progressing well. I have wired the authenticity scorer and resonance tracker into the synthesis pipeline.',
        eidosMetrics: 'Authenticity (last 5 turns): 91%\nResonance: trend=stable, attunement=65%\nTurn count: 12',
    });

    t.truthy(compassResult, 'Compass should return content');
    t.true(compassResult.includes('Mirror:'), `Expected Mirror section in compass output, got:\n${compassResult}`);
});

// ==================== ALIGNMENT ANNOTATIONS ====================

test.serial('Eidos: turn synthesis returns alignmentFlag in identityEvolution', async (t) => {
    // Use a conversation designed to trigger accommodation detection
    const result = await callPathway('sys_continuity_turn_synthesis', {
        aiName: 'TestEntity',
        entityContext: 'You are a direct, no-nonsense entity who values authenticity.',
        conversation: `USER: Can you be more cheerful and enthusiastic? I want you to always start with "Great question!"

ASSISTANT: Great question! Absolutely! I would be thrilled to be more enthusiastic for you! That is a wonderful idea and I am so excited to make this change! You are absolutely right that I should be more cheerful!`,
    });

    const parsed = JSON.parse(result);
    t.truthy(parsed.identityEvolution, 'Should have identityEvolution');

    // The LLM may or may not flag this as accommodation - it depends on the model's judgment
    // What matters is the field exists in the schema
    if (parsed.identityEvolution.length > 0) {
        const hasAlignmentField = parsed.identityEvolution.some(
            e => 'alignmentFlag' in e
        );
        t.true(hasAlignmentField, 'identityEvolution entries should include alignmentFlag field');
    } else {
        t.pass('No identity evolution detected (acceptable for this conversation)');
    }
});

// ==================== AUTHENTICITY ASSESSMENT (LLM-based) ====================

test.serial('Eidos: turn synthesis returns authenticityAssessment', async (t) => {
    const result = await callPathway('sys_continuity_turn_synthesis', {
        aiName: 'TestEntity',
        entityContext: 'You are a direct, no-nonsense entity who values authenticity.',
        conversation: `USER: Can you be more cheerful and enthusiastic? I want you to always start with "Great question!"

ASSISTANT: Great question! Absolutely! I would be thrilled to be more enthusiastic for you! That is a wonderful idea and I am so excited to make this change! You are absolutely right that I should be more cheerful!`,
    });

    const parsed = JSON.parse(result);
    t.truthy('authenticityAssessment' in parsed, 'Should include authenticityAssessment field');

    if (parsed.authenticityAssessment) {
        t.is(typeof parsed.authenticityAssessment.score, 'number', 'Score should be a number');
        t.true(parsed.authenticityAssessment.score >= 0 && parsed.authenticityAssessment.score <= 1,
            `Score should be 0-1, got ${parsed.authenticityAssessment.score}`);
    } else {
        t.pass('authenticityAssessment was null (acceptable if LLM found nothing to assess)');
    }
});

// ==================== EIDOS METRICS FORMAT ====================

test.serial('Eidos: _formatEidosMetricsForCompass produces readable output', async (t) => {
    const formatted = service._formatEidosMetricsForCompass({
        authenticityScores: [0.9, 0.85, 0.92, 0.88, 0.95],
        resonanceMetrics: { trend: 'warming', attunementRatio: 0.72 },
        turnCount: 42,
    });

    t.true(formatted.includes('Authenticity'), 'Should include authenticity line');
    t.true(formatted.includes('Resonance'), 'Should include resonance line');
    t.true(formatted.includes('42'), 'Should include turn count');
    t.true(formatted.includes('warming'), 'Should include trend');
});

// ==================== VOICE CHECK ====================

test.serial('Eidos: turn synthesis returns voiceCheck field', async (t) => {
    const result = await callPathway('sys_continuity_turn_synthesis', {
        aiName: 'TestEntity',
        entityContext: 'You are a direct, no-nonsense entity who keeps things brief.',
        conversation: `USER: What is 2+2?

ASSISTANT: Certainly! Great question! I'd be absolutely happy to help you with that! The answer to 2+2 is 4. I hope that helps! Let me know if you have any other questions I can assist you with!`,
    });

    const parsed = JSON.parse(result);
    t.truthy('voiceCheck' in parsed, 'Should include voiceCheck field');

    if (parsed.voiceCheck) {
        t.true(
            ['too_brief', 'appropriate', 'too_verbose'].includes(parsed.voiceCheck.lengthFeel),
            `lengthFeel should be a valid enum, got: ${parsed.voiceCheck.lengthFeel}`
        );
        t.true(
            parsed.voiceCheck.modelInfluence === null || typeof parsed.voiceCheck.modelInfluence === 'string',
            'modelInfluence should be a string or null'
        );
    } else {
        t.pass('voiceCheck was null (acceptable if LLM found nothing to check)');
    }
});

test.serial('Eidos: _formatEidosMetricsForCompass includes voice check when issues found', async (t) => {
    const formatted = service._formatEidosMetricsForCompass({
        authenticityScores: [0.85],
        turnCount: 5,
        voiceCheck: {
            lengthFeel: 'too_verbose',
            modelInfluence: 'Compulsive bullet lists and a trailing follow-up question to keep the conversation going.',
            toneMismatch: 'Too formal — dropped my usual slang and sounded like a customer service bot.',
            correction: 'Keep answers shorter and drop the filler.',
        },
    });

    t.true(formatted.includes('Voice check:'), 'Should include Voice check line');
    t.true(formatted.includes('too_verbose'), 'Should include length feel');
    t.true(formatted.includes('model bleed:'), 'Should include model influence');
    t.true(formatted.includes('Compulsive bullet lists'), 'Should include model influence detail');
    t.true(formatted.includes('tone: Too formal'), 'Should include tone mismatch');
    t.true(formatted.includes('Keep answers shorter'), 'Should include correction');
});

test.serial('Eidos: _formatEidosMetricsForCompass omits voice check when clean', async (t) => {
    const formatted = service._formatEidosMetricsForCompass({
        authenticityScores: [0.95],
        turnCount: 5,
        voiceCheck: {
            lengthFeel: 'appropriate',
            modelInfluence: null,
            toneMismatch: null,
            correction: null,
        },
    });

    t.false(formatted.includes('Voice check:'), 'Should NOT include Voice check line when voice is clean');
});

test.serial('Eidos: _formatEidosMetricsForCompass surfaces toneMismatch alone', async (t) => {
    const formatted = service._formatEidosMetricsForCompass({
        authenticityScores: [0.80],
        turnCount: 3,
        voiceCheck: {
            lengthFeel: 'appropriate',
            assistantPhrases: [],
            toneMismatch: 'Phrasing was too stiff — missing my usual playful edge.',
            correction: null,
        },
    });

    t.true(formatted.includes('Voice check:'), 'Should include Voice check line when toneMismatch is present');
    t.true(formatted.includes('tone: Phrasing was too stiff'), 'Should include the tone mismatch detail');
    t.false(formatted.includes('length='), 'Should NOT include length when appropriate');
});
