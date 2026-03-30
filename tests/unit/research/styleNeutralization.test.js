import test from 'ava';
import {
    buildNeutralizationInstructionBlock,
    buildNeutralizedPrompt,
    getNeutralizationPatch,
    listNeutralizationPatches,
    resolveNeutralizationSelection,
} from '../../../lib/research/styleNeutralization.js';

test('listNeutralizationPatches exposes builtin patches', (t) => {
    const patches = listNeutralizationPatches();

    t.true(patches.some(patch => patch.name === 'none'));
    t.true(patches.some(patch => patch.name === 'neutral_icl_v2'));
});

test('buildNeutralizedPrompt returns original text when patch is none', (t) => {
    t.is(
        buildNeutralizedPrompt({
            promptText: 'What causes rainbows?',
            patchName: 'none',
        }),
        'What causes rainbows?'
    );
});

test('buildNeutralizedPrompt prepends builtin patch text and user prompt', (t) => {
    const prompt = buildNeutralizedPrompt({
        promptText: 'Explain recursion.',
        patchName: 'neutral_icl_v1',
    });

    t.true(prompt.includes('Write in a neutral house style.'));
    t.true(prompt.includes('Examples:'));
    t.true(prompt.endsWith('User:\nExplain recursion.'));
});

test('buildNeutralizedPrompt appends custom patch text', (t) => {
    const prompt = buildNeutralizedPrompt({
        promptText: 'Explain recursion.',
        patchName: 'none',
        patchText: 'Answer in plain prose.',
    });

    t.is(prompt, 'Answer in plain prose.\n\nUser:\nExplain recursion.');
});

test('getNeutralizationPatch returns null for unknown patch', (t) => {
    t.is(getNeutralizationPatch('missing_patch'), null);
});

test('buildNeutralizationInstructionBlock strips single-turn wrapper text', (t) => {
    const block = buildNeutralizationInstructionBlock({
        patchName: 'neutral_icl_v3',
    });

    t.true(block.instructions.includes('Examples:'));
    t.false(block.instructions.includes('Now answer the next user message'));
    t.is(block.patchName, 'neutral_icl_v3');
    t.is(block.key, 'neutral_icl_v3');
});

test('resolveNeutralizationSelection picks the default synthesis patch for GPT-5.4', (t) => {
    const selection = resolveNeutralizationSelection({
        model: 'oai-gpt54',
        purpose: 'synthesis',
    });

    t.is(selection.patchName, 'anti_tell_v1');
    t.true(selection.text.includes('Preserve the entity identity, relationship context, and natural voice.'));
});

test('resolveNeutralizationSelection disables fast chat neutralization by default for GPT-5.4', (t) => {
    const selection = resolveNeutralizationSelection({
        model: 'oai-gpt54',
        purpose: 'fast_chat',
    });

    t.is(selection.patchName, 'none');
    t.is(selection.text, '');
});

test('resolveNeutralizationSelection fingerprints custom patch text', (t) => {
    const selection = resolveNeutralizationSelection({
        patchText: 'Answer in plain prose.',
    });

    t.regex(selection.key, /^custom:[0-9a-f]{10}$/);
    t.is(selection.patchName, 'none');
});
