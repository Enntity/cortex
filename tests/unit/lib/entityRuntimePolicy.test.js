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
                synthesisModel: 'oai-gpt52',
            },
        },
        args: {
            modelPolicy: JSON.stringify({
                planningModel: 'oai-gpt41-mini',
                verificationModel: 'oai-gpt41-nano',
            }),
        },
        resolver: { modelName: '' },
    });

    t.is(policy.planningModel, 'oai-gpt41-mini');
    t.is(policy.synthesisModel, 'oai-gpt52');
    t.is(policy.verificationModel, 'oai-gpt41-nano');
    t.is(policy.researchModel, 'xai-grok-4-1-fast-non-reasoning');
});

test('resolveEntityModelPolicy defaults to cheap planning and research while keeping synthesis on the entity voice model', t => {
    const policy = resolveEntityModelPolicy({
        entityConfig: {
            preferredModel: 'oai-gpt41',
        },
        args: {},
        resolver: { modelName: 'oai-gpt41' },
    });

    t.not(policy.planningModel, 'oai-gpt41');
    t.not(policy.researchModel, 'oai-gpt41');
    t.is(policy.synthesisModel, 'oai-gpt41');
    t.is(policy.verificationModel, 'oai-gpt41');
    t.is(policy.primaryModel, 'oai-gpt41');
});

test('resolveEntityModelPolicy lets an explicit request model override every stage', t => {
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

    t.is(policy.planningModel, 'oai-gpt41-mini');
    t.is(policy.researchModel, 'oai-gpt41-mini');
    t.is(policy.synthesisModel, 'oai-gpt41-mini');
    t.is(policy.verificationModel, 'oai-gpt41-mini');
    t.is(policy.primaryModel, 'oai-gpt41-mini');
    t.is(policy.forcedPrimaryModel, 'oai-gpt41-mini');
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
