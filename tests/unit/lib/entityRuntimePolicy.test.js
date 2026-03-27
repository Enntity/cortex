import test from 'ava';
import {
    buildSemanticToolKey,
    extractCompassFocus,
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
                planningModel: 'oai-gpt41-mini',
                routingModel: 'oai-gpt54-nano',
                verificationModel: 'oai-gpt41-nano',
            }),
        },
        resolver: { modelName: '' },
    });

    t.is(policy.planningModel, 'oai-gpt41-mini');
    t.is(policy.synthesisModel, 'oai-gpt52');
    t.is(policy.verificationModel, 'oai-gpt41-nano');
    t.is(policy.researchModel, 'xai-grok-4-1-fast-non-reasoning');
    t.is(policy.routingModel, 'oai-gpt54-nano');
});

test('resolveEntityModelPolicy defaults to cheap research while keeping planning and synthesis on the entity voice model', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            preferredModel: 'oai-gpt41',
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.is(policy.planningModel, 'oai-gpt41');
    t.not(policy.researchModel, 'oai-gpt41');
    t.is(policy.routingModel, 'oai-gpt54-nano');
    t.is(policy.synthesisModel, 'oai-gpt41');
    t.is(policy.verificationModel, 'oai-gpt41');
    t.is(policy.primaryModel, 'oai-gpt41');
});

test('resolveEntityModelPolicy lets an explicit request model override voice slots but not operational slots', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            preferredModel: 'oai-gpt41',
            modelPolicy: {
                planningModel: 'xai-grok-4-1-fast-non-reasoning',
                researchModel: 'xai-grok-4-1-fast-non-reasoning',
                synthesisModel: 'oai-gpt52',
            },
        },
        args: {
            model: 'oai-gpt41-mini',
        },
        resolver: { modelName: 'oai-gpt41' },
    });

    // Voice slots — forcedPrimary wins
    t.is(policy.synthesisModel, 'oai-gpt41-mini');
    t.is(policy.verificationModel, 'oai-gpt41-mini');
    t.is(policy.primaryModel, 'oai-gpt41-mini');
    t.is(policy.forcedPrimaryModel, 'oai-gpt41-mini');

    // Planning is a voice slot — forcedPrimary wins
    t.is(policy.planningModel, 'oai-gpt41-mini');

    // Research is operational — configured cheap model wins
    t.is(policy.researchModel, 'xai-grok-4-1-fast-non-reasoning');
    t.is(policy.routingModel, 'oai-gpt54-nano');
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
