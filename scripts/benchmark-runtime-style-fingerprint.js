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
import { listNeutralizationPatches } from '../lib/research/styleNeutralization.js';

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
};

const DEFAULTS = {
    model: 'oai-gpt54',
    repeats: 1,
    timeoutMs: 60000,
    reasoningEffort: '',
    jsonOut: '',
    suite: 'sanity',
    showResponses: false,
    semanticEvaluatorModel: 'xai-grok-4-20-0309-non-reasoning',
    semanticEvaluatorReasoningEffort: '',
    disableSemanticEvaluator: false,
    neutralizationPatch: '',
    neutralizationFile: '',
    listNeutralizationPatches: false,
    entityId: '',
    useMemory: false,
    contextPrefix: 'style-runtime',
    language: 'English',
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
        } else if (token === '--entity-id' && next) {
            args.entityId = next;
            index += 1;
        } else if (token.startsWith('--entity-id=')) {
            args.entityId = token.split('=').slice(1).join('=');
        } else if (token === '--use-memory') {
            args.useMemory = true;
        } else if (token === '--context-prefix' && next) {
            args.contextPrefix = next;
            index += 1;
        } else if (token.startsWith('--context-prefix=')) {
            args.contextPrefix = token.split('=').slice(1).join('=');
        } else if (token === '--language' && next) {
            args.language = next;
            index += 1;
        } else if (token.startsWith('--language=')) {
            args.language = token.split('=').slice(1).join('=');
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
            setTimeout(() => reject(new Error(`Runtime call timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
    ]);
}

async function invokeRuntime(server, promptText, args, repeat) {
    const contextId = `${args.contextPrefix}-${args.model}-${Date.now()}-${repeat}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const response = await withTimeout(
        server.executeOperation({
            query: `query RuntimeBenchmark(
                $text: String!,
                $chatHistory: [MultiMessage]!,
                $agentContext: [AgentContextInput],
                $entityId: String,
                $useMemory: Boolean,
                $model: String,
                $language: String,
                $styleNeutralizationPatch: String,
                $styleNeutralizationText: String
            ) {
                sys_entity_runtime(
                    text: $text,
                    chatHistory: $chatHistory,
                    agentContext: $agentContext,
                    entityId: $entityId,
                    useMemory: $useMemory,
                    model: $model,
                    language: $language,
                    styleNeutralizationPatch: $styleNeutralizationPatch,
                    styleNeutralizationText: $styleNeutralizationText,
                    stream: false
                ) {
                    result
                    contextId
                    warnings
                    errors
                }
            }`,
            variables: {
                text: promptText,
                chatHistory: [{ role: 'user', content: [promptText] }],
                agentContext: [{ contextId, contextKey: null, default: true }],
                entityId: args.entityId || null,
                useMemory: args.useMemory,
                model: args.model,
                language: args.language,
                styleNeutralizationPatch: args.neutralizationPatch || null,
                styleNeutralizationText: args.neutralizationText || null,
            },
        }),
        args.timeoutMs
    );

    const graphqlErrors = response.body?.singleResult?.errors || [];
    if (graphqlErrors.length > 0) {
        throw new Error(graphqlErrors.map(error => error.message).join('; '));
    }

    const pathwayResult = response.body?.singleResult?.data?.sys_entity_runtime;
    if (!pathwayResult) {
        throw new Error('sys_entity_runtime returned no data');
    }

    if (Array.isArray(pathwayResult.errors) && pathwayResult.errors.length > 0) {
        throw new Error(pathwayResult.errors.join('; '));
    }

    return {
        result: typeof pathwayResult.result === 'string'
            ? pathwayResult.result
            : JSON.stringify(pathwayResult.result, null, 2),
        durationMs: Date.now() - startedAt,
        contextId: pathwayResult.contextId || contextId,
        warnings: pathwayResult.warnings || [],
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
        const response = await withTimeout(
            server.executeOperation({
                query: `query($text: String!, $model: String, $reasoningEffort: String) {
                    benchmark(text: $text, model: $model, reasoningEffort: $reasoningEffort) {
                        result
                        errors
                    }
                }`,
                variables: {
                    text: semanticPrompt,
                    model: args.semanticEvaluatorModel,
                    reasoningEffort: args.semanticEvaluatorReasoningEffort,
                },
            }),
            args.timeoutMs
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

        semanticResponseText = typeof pathwayResult.result === 'string'
            ? pathwayResult.result
            : JSON.stringify(pathwayResult.result, null, 2);
        semanticScores = parseSemanticClassifierResponse(semanticResponseText);
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
    console.log(`contextId=${run.contextId}`);

    if (classification.semanticEvaluation?.used) {
        console.log(`semanticEvaluator=${classification.semanticEvaluation.model}`);
    }

    if (showResponses) {
        console.log('response:');
        console.log(run.response);
    }
}

function printSummary(summary) {
    console.log('\n' + '='.repeat(80));
    console.log('RUNTIME STYLE FINGERPRINT SUMMARY');
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
}

async function maybeWriteJson(filePath, payload) {
    if (!filePath) return;
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

    args.neutralizationText = args.neutralizationFile
        ? await fs.readFile(path.resolve(args.neutralizationFile), 'utf8')
        : '';

    const promptSuite = PROMPT_SUITES[args.suite];
    const totalRuns = promptSuite.length * args.repeats;
    const runs = [];

    const { server } = await serverFactory();
    if (server?.start) {
        await server.start();
    }

    try {
        let completed = 0;
        console.log(
            `Running runtime style benchmark with model=${args.model} suite=${args.suite} repeats=${args.repeats}` +
            ` semanticEvaluator=${args.disableSemanticEvaluator ? 'disabled' : args.semanticEvaluatorModel}` +
            ` neutralizationPatch=${args.neutralizationPatch || '(runtime default)'}` +
            ` useMemory=${args.useMemory}`
        );

        for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
            for (const prompt of promptSuite) {
                const invocation = await invokeRuntime(server, prompt.text, args, repeat);
                const classification = await classifyWithSemanticEvaluator(
                    server,
                    prompt,
                    invocation.result,
                    args
                );

                const run = {
                    model: args.model,
                    suite: args.suite,
                    promptName: prompt.name,
                    promptTags: prompt.tags || [],
                    promptText: prompt.text,
                    repeat,
                    durationMs: invocation.durationMs,
                    contextId: invocation.contextId,
                    warnings: invocation.warnings,
                    response: invocation.result,
                    entityId: args.entityId || '',
                    useMemory: args.useMemory,
                    styleNeutralizationPatchRequested: args.neutralizationPatch || '',
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
            suite: args.suite,
            repeats: args.repeats,
            timeoutMs: args.timeoutMs,
            entityId: args.entityId || '',
            useMemory: args.useMemory,
            semanticEvaluatorModel: args.disableSemanticEvaluator ? '' : args.semanticEvaluatorModel,
            styleNeutralizationPatchRequested: args.neutralizationPatch || '',
            styleNeutralizationFile: args.neutralizationFile ? path.resolve(args.neutralizationFile) : '',
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
