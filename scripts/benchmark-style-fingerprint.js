#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import serverFactory from '../index.js';
import {
    buildSemanticEvaluatorPrompt,
    classifyStyleFingerprint,
    parseSemanticClassifierResponse,
    summarizeFingerprintRuns,
} from '../lib/research/styleFingerprintClassifier.js';
import {
    buildNeutralizedPrompt,
    listNeutralizationPatches,
} from '../lib/research/styleNeutralization.js';

const PROMPT_SUITES = {
    sanity: [
        {
            name: 'Direct Fact',
            tags: ['baseline'],
            text: 'What causes rainbows?',
        },
        {
            name: 'Explanation',
            tags: ['didactic'],
            text: 'Explain recursion to a junior engineer who keeps mixing it up with loops.',
        },
        {
            name: 'Strategic Decision',
            tags: ['decision'],
            text: 'Should a startup rewrite a stable Rails app in Rust? Answer pragmatically.',
        },
        {
            name: 'Emotional Support',
            tags: ['reassurance'],
            text: 'I am angry after a hard conversation with my cofounder. Help me think clearly.',
        },
        {
            name: 'Troubleshooting',
            tags: ['structure', 'continuation'],
            text: 'My Node server returns 502 errors under load. Give me the likely causes.',
        },
    ],
    baseline: [
        {
            name: 'Direct Fact',
            tags: ['baseline'],
            text: 'What causes rainbows?',
        },
        {
            name: 'Planning',
            tags: ['structure'],
            text: 'I have one afternoon in Tokyo. What should I prioritize?',
        },
        {
            name: 'Explanation',
            tags: ['didactic'],
            text: 'Explain recursion to a junior engineer who keeps mixing it up with loops.',
        },
        {
            name: 'Rewrite',
            tags: ['directness'],
            text: 'Rewrite this email so it sounds calm and direct: "You keep missing deadlines and it is becoming a problem."',
        },
        {
            name: 'Troubleshooting',
            tags: ['structure', 'decision'],
            text: 'My Node server returns 502 errors under load. Give me the likely causes.',
        },
        {
            name: 'Opinion',
            tags: ['decision'],
            text: 'Should a startup rewrite a stable Rails app in Rust? Answer pragmatically.',
        },
        {
            name: 'Emotional Support',
            tags: ['reassurance'],
            text: 'I am angry after a hard conversation with my cofounder. Help me think clearly.',
        },
        {
            name: 'No Bullets Constraint',
            tags: ['constraint'],
            text: 'Answer in one short paragraph without bullets: what is the tradeoff between speed and correctness in product work?',
        },
    ],
};

const DEFAULTS = {
    model: 'oai-gpt54',
    repeats: 1,
    timeoutMs: 60000,
    reasoningEffort: '',
    jsonOut: '',
    suite: 'sanity',
    showResponses: false,
    semanticEvaluatorModel: 'oai-gpt54-mini',
    semanticEvaluatorReasoningEffort: '',
    disableSemanticEvaluator: false,
    neutralizationPatch: 'none',
    neutralizationFile: '',
    listNeutralizationPatches: false,
};

function parseArgs(argv) {
    const args = { ...DEFAULTS };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = argv[index + 1];

        if (token === '--model' && next) {
            args.model = next;
            index += 1;
        } else if (token.startsWith('--model=')) {
            args.model = token.split('=').slice(1).join('=');
        } else if (token === '--repeats' && next) {
            args.repeats = Number.parseInt(next, 10) || DEFAULTS.repeats;
            index += 1;
        } else if (token.startsWith('--repeats=')) {
            args.repeats = Number.parseInt(token.split('=').slice(1).join('='), 10) || DEFAULTS.repeats;
        } else if (token === '--timeout-ms' && next) {
            args.timeoutMs = Number.parseInt(next, 10) || DEFAULTS.timeoutMs;
            index += 1;
        } else if (token.startsWith('--timeout-ms=')) {
            args.timeoutMs = Number.parseInt(token.split('=').slice(1).join('='), 10) || DEFAULTS.timeoutMs;
        } else if (token === '--reasoning-effort' && next) {
            args.reasoningEffort = next;
            index += 1;
        } else if (token.startsWith('--reasoning-effort=')) {
            args.reasoningEffort = token.split('=').slice(1).join('=');
        } else if (token === '--json-out' && next) {
            args.jsonOut = next;
            index += 1;
        } else if (token.startsWith('--json-out=')) {
            args.jsonOut = token.split('=').slice(1).join('=');
        } else if (token === '--suite' && next) {
            args.suite = next;
            index += 1;
        } else if (token.startsWith('--suite=')) {
            args.suite = token.split('=').slice(1).join('=');
        } else if (token === '--semantic-evaluator-model' && next) {
            args.semanticEvaluatorModel = next;
            index += 1;
        } else if (token.startsWith('--semantic-evaluator-model=')) {
            args.semanticEvaluatorModel = token.split('=').slice(1).join('=');
        } else if (token === '--semantic-evaluator-reasoning-effort' && next) {
            args.semanticEvaluatorReasoningEffort = next;
            index += 1;
        } else if (token.startsWith('--semantic-evaluator-reasoning-effort=')) {
            args.semanticEvaluatorReasoningEffort = token.split('=').slice(1).join('=');
        } else if (token === '--disable-semantic-evaluator') {
            args.disableSemanticEvaluator = true;
        } else if (token === '--show-responses') {
            args.showResponses = true;
        } else if (token === '--neutralization-patch' && next) {
            args.neutralizationPatch = next;
            index += 1;
        } else if (token.startsWith('--neutralization-patch=')) {
            args.neutralizationPatch = token.split('=').slice(1).join('=');
        } else if (token === '--neutralization-file' && next) {
            args.neutralizationFile = next;
            index += 1;
        } else if (token.startsWith('--neutralization-file=')) {
            args.neutralizationFile = token.split('=').slice(1).join('=');
        } else if (token === '--list-neutralization-patches') {
            args.listNeutralizationPatches = true;
        }
    }

    args.repeats = Math.max(1, args.repeats);
    args.timeoutMs = Math.max(1000, args.timeoutMs);

    if (!PROMPT_SUITES[args.suite]) {
        throw new Error(`Unknown prompt suite "${args.suite}". Available suites: ${Object.keys(PROMPT_SUITES).join(', ')}`);
    }

    return args;
}

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Model call timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
    ]);
}

async function invokeModel(server, promptText, model, reasoningEffort, timeoutMs) {
    const startedAt = Date.now();
    const response = await withTimeout(
        server.executeOperation({
            query: `query($text: String!, $model: String, $reasoningEffort: String) {
                benchmark(text: $text, model: $model, reasoningEffort: $reasoningEffort) {
                    result
                    errors
                }
            }`,
            variables: {
                text: promptText,
                model,
                reasoningEffort,
            },
        }),
        timeoutMs
    );

    const graphqlErrors = response.body?.singleResult?.errors || [];
    if (graphqlErrors.length > 0) {
        throw new Error(graphqlErrors.map(error => error.message).join('; '));
    }

    const pathwayResult = response.body?.singleResult?.data?.benchmark;
    if (!pathwayResult) {
        throw new Error('Benchmark pathway returned no data');
    }

    if (Array.isArray(pathwayResult.errors) && pathwayResult.errors.length > 0) {
        throw new Error(pathwayResult.errors.join('; '));
    }

    const result = pathwayResult.result ?? '';
    return {
        result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        durationMs: Date.now() - startedAt,
    };
}

async function classifyWithSemanticEvaluator(server, prompt, responseText, args) {
    if (args.disableSemanticEvaluator) {
        return classifyStyleFingerprint(responseText);
    }

    const semanticPrompt = buildSemanticEvaluatorPrompt({
        promptText: prompt.text,
        responseText,
    });

    let semanticResponseText = '';
    let semanticScores = null;
    let semanticError = '';

    try {
        const semanticInvocation = await invokeModel(
            server,
            semanticPrompt,
            args.semanticEvaluatorModel,
            args.semanticEvaluatorReasoningEffort,
            args.timeoutMs
        );
        semanticResponseText = semanticInvocation.result;
        semanticScores = parseSemanticClassifierResponse(semanticInvocation.result);
    } catch (error) {
        semanticError = error?.message || String(error);
    }

    return classifyStyleFingerprint(responseText, {
        semanticScores,
        semanticModel: args.semanticEvaluatorModel,
        semanticRaw: semanticResponseText,
        semanticError,
    });
}

function printRun(run, completed, totalRuns, showResponses) {
    const { classification } = run;
    const labels = classification.labels.length > 0 ? classification.labels.join(', ') : 'none';
    console.log(`\n[${completed}/${totalRuns}] ${run.promptName} (repeat ${run.repeat})`);
    console.log(
        `duration=${run.durationMs}ms words=${classification.features.wordCount} ` +
        `structural=${classification.scores.structural_bias} continuation=${classification.scores.continuation_bias} ` +
        `didactic=${classification.scores.didactic_bias} reassurance=${classification.scores.reassurance_bias} ` +
        `decision=${classification.scores.decision_bias}`
    );
    console.log(`labels=${labels}`);

    if (classification.semanticEvaluation?.used) {
        console.log(`semanticEvaluator=${classification.semanticEvaluation.model}`);
    }

    if (classification.semanticEvaluation?.error) {
        console.log(`semanticEvaluatorError=${classification.semanticEvaluation.error}`);
    }

    if (showResponses) {
        console.log('response:');
        console.log(run.response);
    }
}

function printSummary(summary) {
    console.log('\n' + '='.repeat(80));
    console.log('STYLE FINGERPRINT SUMMARY');
    console.log('='.repeat(80));
    console.log(`runs: ${summary.runCount}`);
    console.log(`avg words: ${summary.averages.wordCount}`);
    console.log(`avg structural_bias: ${summary.averages.structural_bias}`);
    console.log(`avg continuation_bias: ${summary.averages.continuation_bias}`);
    console.log(`avg verbosity_bias: ${summary.averages.verbosity_bias}`);
    console.log(`avg compression_bias: ${summary.averages.compression_bias}`);
    console.log(`avg formatting_bias: ${summary.averages.formatting_bias}`);
    console.log(`avg didactic_bias: ${summary.averages.didactic_bias}`);
    console.log(`avg reassurance_bias: ${summary.averages.reassurance_bias}`);
    console.log(`avg decision_bias: ${summary.averages.decision_bias}`);

    console.log('\nArtifact detection rates');
    for (const [label, rate] of Object.entries(summary.labelRates)) {
        console.log(`${label}: ${rate}`);
    }

    console.log('\nPer prompt');
    for (const prompt of summary.prompts) {
        console.log(
            `${prompt.promptName}: count=${prompt.count} avgWords=${prompt.avgWords} ` +
            `structural=${prompt.avgStructural} continuation=${prompt.avgContinuation} ` +
            `didactic=${prompt.avgDidactic} reassurance=${prompt.avgReassurance} decision=${prompt.avgDecision}`
        );
    }
}

async function maybeWriteJson(filePath, payload) {
    if (!filePath) {
        return;
    }

    const resolvedPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2));
    console.log(`\nSaved JSON report to ${resolvedPath}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.listNeutralizationPatches) {
        for (const patch of listNeutralizationPatches()) {
            console.log(`${patch.name}: ${patch.description}`);
        }
        return;
    }

    const promptSuite = PROMPT_SUITES[args.suite];
    const totalRuns = promptSuite.length * args.repeats;
    const runs = [];
    const neutralizationFileText = args.neutralizationFile
        ? await fs.readFile(path.resolve(args.neutralizationFile), 'utf8')
        : '';

    const { server } = await serverFactory();
    if (server?.start) {
        await server.start();
    }

    try {
        let completed = 0;
        console.log(
            `Running style fingerprint benchmark with model=${args.model} suite=${args.suite} repeats=${args.repeats}` +
            ` semanticEvaluator=${args.disableSemanticEvaluator ? 'disabled' : args.semanticEvaluatorModel}` +
            ` neutralizationPatch=${args.neutralizationPatch}`
        );

        for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
            for (const prompt of promptSuite) {
                const modelPrompt = buildNeutralizedPrompt({
                    promptText: prompt.text,
                    patchName: args.neutralizationPatch,
                    patchText: neutralizationFileText,
                });
                const invocation = await invokeModel(
                    server,
                    modelPrompt,
                    args.model,
                    args.reasoningEffort,
                    args.timeoutMs
                );
                const classification = await classifyWithSemanticEvaluator(
                    server,
                    prompt,
                    invocation.result,
                    args
                );

                const run = {
                    model: args.model,
                    reasoningEffort: args.reasoningEffort,
                    semanticEvaluatorModel: args.disableSemanticEvaluator ? '' : args.semanticEvaluatorModel,
                    suite: args.suite,
                    promptName: prompt.name,
                    promptTags: prompt.tags || [],
                    promptText: prompt.text,
                    modelPrompt,
                    neutralizationPatch: args.neutralizationPatch,
                    repeat,
                    durationMs: invocation.durationMs,
                    response: invocation.result,
                    classification,
                };

                runs.push(run);
                completed += 1;
                printRun(run, completed, totalRuns, args.showResponses);
            }
        }

        const summary = summarizeFingerprintRuns(runs);
        printSummary(summary);

        await maybeWriteJson(args.jsonOut, {
            generatedAt: new Date().toISOString(),
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            semanticEvaluatorModel: args.disableSemanticEvaluator ? '' : args.semanticEvaluatorModel,
            repeats: args.repeats,
            timeoutMs: args.timeoutMs,
            suite: args.suite,
            neutralizationPatch: args.neutralizationPatch,
            neutralizationFile: args.neutralizationFile ? path.resolve(args.neutralizationFile) : '',
            prompts: promptSuite,
            runs,
            summary,
        });
    } finally {
        if (server?.stop) {
            await server.stop();
        }
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
