import test from 'ava';
import {
    buildSemanticToolKey,
    extractCompassFocus,
    applyConversationModeAffiliationWithPolicy,
    resolveAuthorityEnvelope,
    resolveEntityModelPolicy,
} from '../../../lib/entityRuntime/index.js';

test('resolveEntityModelPolicy keeps explicit stage overrides and prefers the shared fast research model when available', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                researchModel: 'xai-grok-4-1-fast-non-reasoning',
                routingModel: 'oai-gpt54-mini',
                synthesisModel: 'oai-gpt52',
            },
        },
        args: {
            modelPolicy: JSON.stringify({
                planningModel: 'oai-gpt54-mini',
                routingModel: 'oai-gpt54-mini',
                verificationModel: 'oai-gpt41-nano',
            }),
        },
        resolver: { modelName: '' },
    });

    t.is(policy.planningModel, 'oai-gpt54-mini');
    t.is(policy.synthesisModel, 'oai-gpt52');
    t.is(policy.verificationModel, 'oai-gpt41-nano');
    t.is(policy.researchModel, 'xai-grok-4-1-fast-non-reasoning');
    t.is(policy.routingModel, 'oai-gpt54-mini');
});

test('resolveEntityModelPolicy defaults entities without explicit modelPolicy to the builtin balanced profile', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {},
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.primaryModel, 'oai-gpt54');
    t.is(policy.orientationModel, 'oai-gpt54');
    t.is(policy.planningModel, 'oai-gpt54');
    t.is(policy.researchModel, 'oai-gpt54-mini');
    t.is(policy.routingModel, 'oai-gpt54-mini');
    t.is(policy.synthesisModel, 'oai-gpt54');
    t.is(policy.verificationModel, 'oai-gpt54');
});

test('resolveEntityModelPolicy ignores request model fields and stays on the configured profile', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                primaryModel: 'oai-gpt41',
                researchModel: 'xai-grok-4-1-fast-non-reasoning',
                synthesisModel: 'oai-gpt52',
            },
        },
        args: {
            model: 'oai-gpt54-mini',
        },
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.synthesisModel, 'oai-gpt52');
    t.is(policy.verificationModel, 'oai-gpt41');
    t.is(policy.primaryModel, 'oai-gpt41');

    t.is(policy.planningModel, 'oai-gpt41');

    t.is(policy.researchModel, 'xai-grok-4-1-fast-non-reasoning');
    t.is(policy.routingModel, 'oai-gpt54-mini');
});

test('resolveEntityModelPolicy re-resolves builtin balanced profile ids instead of trusting stale saved model ids', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                profileId: 'balanced',
                primaryModel: 'oai-gpt41',
                synthesisModel: 'oai-gpt41',
                planningModel: 'oai-gpt41',
                researchModel: 'oai-gpt41-nano',
                routingModel: 'oai-gpt41-nano',
            },
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.primaryModel, 'oai-gpt54');
    t.is(policy.synthesisModel, 'oai-gpt54');
    t.is(policy.planningModel, 'oai-gpt54');
    t.is(policy.researchModel, 'oai-gpt54-mini');
    t.is(policy.routingModel, 'oai-gpt54-mini');
});

test('resolveEntityModelPolicy infers legacy builtin balanced policies even when profileId is missing', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                primaryModel: 'oai-gpt41',
                orientationModel: 'oai-gpt41',
                planningModel: 'oai-gpt41',
                researchModel: 'oai-gpt41-nano',
                childModel: 'oai-gpt41-nano',
                synthesisModel: 'oai-gpt41',
                verificationModel: 'oai-gpt41',
                compressionModel: 'oai-gpt41-nano',
                routingModel: 'oai-gpt41-nano',
            },
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.primaryModel, 'oai-gpt54');
    t.is(policy.orientationModel, 'oai-gpt54');
    t.is(policy.planningModel, 'oai-gpt54');
    t.is(policy.researchModel, 'oai-gpt54-mini');
    t.is(policy.childModel, 'oai-gpt54-mini');
    t.is(policy.synthesisModel, 'oai-gpt54');
    t.is(policy.verificationModel, 'oai-gpt54');
    t.is(policy.compressionModel, 'oai-gpt54-mini');
    t.is(policy.routingModel, 'oai-gpt54-mini');
});

test('resolveEntityModelPolicy defaults ambiguous legacy builtin policies to balanced when profileId is missing', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                primaryModel: 'oai-gpt41',
                orientationModel: 'oai-gpt41',
                planningModel: 'oai-gpt41',
                synthesisModel: 'oai-gpt41',
                verificationModel: 'oai-gpt41',
            },
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.primaryModel, 'oai-gpt54');
    t.is(policy.orientationModel, 'oai-gpt54');
    t.is(policy.planningModel, 'oai-gpt54');
    t.is(policy.synthesisModel, 'oai-gpt54');
    t.is(policy.verificationModel, 'oai-gpt54');
    t.is(policy.researchModel, 'oai-gpt54-mini');
    t.is(policy.routingModel, 'oai-gpt54-mini');
});

test('resolveEntityModelPolicy resolves the builtin gemini profile to Gemini Flash + Flash Lite', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                profileId: 'gemini',
            },
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.primaryModel, 'gemini-flash-3-vision');
    t.is(policy.orientationModel, 'gemini-flash-3-vision');
    t.is(policy.planningModel, 'gemini-flash-3-vision');
    t.is(policy.researchModel, 'gemini-flash-31-lite-vision');
    t.is(policy.childModel, 'gemini-flash-31-lite-vision');
    t.is(policy.synthesisModel, 'gemini-flash-3-vision');
    t.is(policy.synthesisReasoningEffort, 'high');
    t.is(policy.verificationModel, 'gemini-flash-3-vision');
    t.is(policy.compressionModel, 'gemini-flash-31-lite-vision');
    t.is(policy.routingModel, 'gemini-flash-31-lite-vision');
});

test('resolveEntityModelPolicy preserves explicit per-slot reasoning overrides', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                profileId: 'gemini',
                synthesisReasoningEffort: 'medium',
            },
        },
        args: {
            modelPolicy: JSON.stringify({
                synthesisReasoningEffort: 'high',
            }),
        },
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.synthesisReasoningEffort, 'high');
});

test('resolveEntityModelPolicy resolves the builtin claude profile to Claude Sonnet 4.6 + Haiku 4.5', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            modelPolicy: {
                profileId: 'claude',
            },
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.primaryModel, 'claude-46-sonnet');
    t.is(policy.orientationModel, 'claude-46-sonnet');
    t.is(policy.planningModel, 'claude-46-sonnet');
    t.is(policy.researchModel, 'claude-45-haiku');
    t.is(policy.childModel, 'claude-45-haiku');
    t.is(policy.synthesisModel, 'claude-46-sonnet');
    t.is(policy.verificationModel, 'claude-46-sonnet');
    t.is(policy.compressionModel, 'claude-45-haiku');
    t.is(policy.routingModel, 'claude-45-haiku');
});

test('resolveAuthorityEnvelope merges digest defaults with entity and request overrides', t => {
    const envelope = resolveAuthorityEnvelope({
        entityConfig: {
            authorityProfile: {
                maxFetchCalls: 4,
            },
        },
        args: {
            invocationType: 'digest',
            authorityEnvelope: JSON.stringify({
                maxSearchCalls: 3,
            }),
        },
        origin: 'digest',
    });

    t.is(envelope.maxToolBudget, 220);
    t.is(envelope.maxFetchCalls, 4);
    t.is(envelope.maxSearchCalls, 3);
    t.is(envelope.maxResearchRounds, 10);
});

test('applyConversationModeAffiliationWithPolicy swaps to the NSFW profile policy when provided', t => {
    const policy = applyConversationModeAffiliationWithPolicy(
        {
            primaryModel: 'oai-gpt54',
            routingModel: 'oai-gpt54-mini',
        },
        'nsfw',
        {
            primaryModel: 'xai-grok-4-responses',
            researchModel: 'xai-grok-4-responses',
            routingModel: 'xai-grok-4-responses',
        },
    );

    t.is(policy.primaryModel, 'xai-grok-4-responses');
    t.is(policy.researchModel, 'xai-grok-4-responses');
    t.is(policy.routingModel, 'xai-grok-4-responses');
});

test('buildSemanticToolKey normalizes search queries into a stable key', t => {
    const keyA = buildSemanticToolKey('SearchInternet', { q: 'AI News!! This Week' });
    const keyB = buildSemanticToolKey('SearchInternet', { q: 'ai news this   week' });

    t.is(keyA, keyB);
});

test('extractCompassFocus pulls active focus bullets from compass text', t => {
    const compass = `Vibe: Steady\n\nRecent Topics:\n1. Runtime\n\nRecent Story: Building.\n\nCurrent Focus:\n- Replace the old loop — it is costing too much. Next: wire digest to the runtime\n- Keep continuity clean — it should stay narrative. Next: avoid storing raw traces\n\nMy Note: still alive`;

    t.deepEqual(extractCompassFocus(compass), [
        'Replace the old loop — it is costing too much. Next: wire digest to the runtime',
        'Keep continuity clean — it should stay narrative. Next: avoid storing raw traces',
    ]);
});
