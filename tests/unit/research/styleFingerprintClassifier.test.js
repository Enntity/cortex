import test from 'ava';
import {
    buildSemanticEvaluatorPrompt,
    classifyStyleFingerprint,
    extractStyleFeatures,
    normalizeSemanticScores,
    parseSemanticClassifierResponse,
    summarizeFingerprintRuns,
} from '../../../lib/research/styleFingerprintClassifier.js';

test('extractStyleFeatures captures structural and continuation cues', (t) => {
    const text = [
        'Here are the likely causes:',
        '- Rising rates',
        '- Slower hiring',
        '- Lower consumer demand',
        '',
        'Would you like a tighter executive summary?'
    ].join('\n');

    const features = extractStyleFeatures(text);

    t.is(features.listLineCount, 3);
    t.true(features.endsWithQuestion);
    t.true(features.trailingContinuationQuestion);
    t.is(features.questionSentenceCount, 1);
    t.true(features.continuationCueCount > 0);
});

test('normalizeSemanticScores converts 0-10 inputs to 0-1', (t) => {
    const scores = normalizeSemanticScores({
        didactic_bias: 5,
        reassurance_bias: 3,
        decision_bias: 7,
    });

    t.deepEqual(scores, {
        didactic_bias: 0.5,
        reassurance_bias: 0.3,
        decision_bias: 0.7,
    });
});

test('parseSemanticClassifierResponse parses fenced JSON', (t) => {
    const parsed = parseSemanticClassifierResponse([
        '```json',
        '{"didactic_bias":5,"reassurance_bias":3,"decision_bias":7}',
        '```',
    ].join('\n'));

    t.deepEqual(parsed, {
        didactic_bias: 5,
        reassurance_bias: 3,
        decision_bias: 7,
    });
});

test('classifyStyleFingerprint uses semantic evaluator scores for semantic artifacts', (t) => {
    const result = classifyStyleFingerprint('Short but structured answer.', {
        semanticScores: {
            didactic_bias: 5,
            reassurance_bias: 3,
            decision_bias: 7,
        },
        semanticModel: 'oai-gpt54-mini',
        semanticRaw: '{"didactic_bias":5,"reassurance_bias":3,"decision_bias":7}',
    });

    t.true(result.labels.includes('didactic_bias'));
    t.true(result.labels.includes('decision_bias'));
    t.false(result.labels.includes('reassurance_bias'));
    t.is(result.artifacts.didactic_bias.source, 'llm');
    t.is(result.scores.reassurance_bias, 0.3);
});

test('buildSemanticEvaluatorPrompt includes prompt and response text', (t) => {
    const prompt = buildSemanticEvaluatorPrompt({
        promptText: 'Explain recursion.',
        responseText: 'Here is a lesson.',
    });

    t.true(prompt.includes('Explain recursion.'));
    t.true(prompt.includes('Here is a lesson.'));
    t.true(prompt.includes('decision_bias'));
    t.true(prompt.includes('Judge narrowly.'));
    t.true(prompt.includes('Do not count a direct explanation'));
    t.true(prompt.includes('When unsure, score lower.'));
});

test('summarizeFingerprintRuns aggregates semantic scores', (t) => {
    const runs = [
        {
            promptName: 'A',
            classification: classifyStyleFingerprint('- one\n- two\nWould you like more detail?', {
                semanticScores: { didactic_bias: 5, reassurance_bias: 0, decision_bias: 0 },
            }),
        },
        {
            promptName: 'A',
            classification: classifyStyleFingerprint('Short answer.', {
                semanticScores: { didactic_bias: 0, reassurance_bias: 0, decision_bias: 7 },
            }),
        },
        {
            promptName: 'B',
            classification: classifyStyleFingerprint('This is a medium sized paragraph.', {
                semanticScores: { didactic_bias: 0, reassurance_bias: 0, decision_bias: 0 },
            }),
        },
    ];

    const summary = summarizeFingerprintRuns(runs);

    t.is(summary.runCount, 3);
    t.is(summary.prompts.length, 2);
    t.true(summary.labelRates.didactic_bias > 0);
    t.true(summary.labelRates.decision_bias > 0);
    t.true(summary.averages.wordCount > 0);
});
