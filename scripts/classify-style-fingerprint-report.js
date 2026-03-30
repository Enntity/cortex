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

const DEFAULTS = {
    input: '',
    jsonOut: '',
    timeoutMs: 60000,
    semanticEvaluatorModel: 'oai-gpt54-mini',
    semanticEvaluatorReasoningEffort: '',
};

function parseArgs(argv) {
    const args = { ...DEFAULTS };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = argv[index + 1];

        if (token === '--input' && next) {
            args.input = next;
            index += 1;
        } else if (token.startsWith('--input=')) {
            args.input = token.split('=').slice(1).join('=');
        } else if (token === '--json-out' && next) {
            args.jsonOut = next;
            index += 1;
        } else if (token.startsWith('--json-out=')) {
            args.jsonOut = token.split('=').slice(1).join('=');
        } else if (token === '--timeout-ms' && next) {
            args.timeoutMs = Number.parseInt(next, 10) || DEFAULTS.timeoutMs;
            index += 1;
        } else if (token.startsWith('--timeout-ms=')) {
            args.timeoutMs = Number.parseInt(token.split('=').slice(1).join('='), 10) || DEFAULTS.timeoutMs;
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
        }
    }

    if (!args.input) {
        throw new Error('Missing required --input report path');
    }

    args.timeoutMs = Math.max(1000, args.timeoutMs);
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

    return typeof pathwayResult.result === 'string'
        ? pathwayResult.result
        : JSON.stringify(pathwayResult.result, null, 2);
}

async function maybeWriteJson(filePath, payload) {
    if (!filePath) {
        return;
    }

    const resolvedPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2));
    console.log(`Saved JSON report to ${resolvedPath}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const sourceReport = JSON.parse(await fs.readFile(path.resolve(args.input), 'utf8'));
    const sourceRuns = sourceReport.runs || [];
    const classifiedRuns = [];

    const { server } = await serverFactory();
    if (server?.start) {
        await server.start();
    }

    try {
        let completed = 0;
        console.log(`Classifying ${sourceRuns.length} runs with semantic evaluator=${args.semanticEvaluatorModel}`);

        for (const run of sourceRuns) {
            const semanticPrompt = buildSemanticEvaluatorPrompt({
                promptText: run.promptText,
                responseText: run.response,
            });

            let semanticRaw = '';
            let semanticScores = null;
            let semanticError = '';

            try {
                semanticRaw = await invokeModel(
                    server,
                    semanticPrompt,
                    args.semanticEvaluatorModel,
                    args.semanticEvaluatorReasoningEffort,
                    args.timeoutMs
                );
                semanticScores = parseSemanticClassifierResponse(semanticRaw);
            } catch (error) {
                semanticError = error?.message || String(error);
            }

            const classification = classifyStyleFingerprint(run.response, {
                semanticScores,
                semanticModel: args.semanticEvaluatorModel,
                semanticRaw,
                semanticError,
            });

            classifiedRuns.push({
                ...run,
                semanticEvaluatorModel: args.semanticEvaluatorModel,
                classification,
            });

            completed += 1;
            console.log(`[${completed}/${sourceRuns.length}] ${run.promptName} didactic=${classification.scores.didactic_bias} reassurance=${classification.scores.reassurance_bias} decision=${classification.scores.decision_bias}`);
        }
    } finally {
        if (server?.stop) {
            await server.stop();
        }
    }

    const summary = summarizeFingerprintRuns(classifiedRuns);
    const payload = {
        sourceReport: path.resolve(args.input),
        classifiedAt: new Date().toISOString(),
        model: sourceReport.model,
        suite: sourceReport.suite,
        semanticEvaluatorModel: args.semanticEvaluatorModel,
        prompts: sourceReport.prompts,
        runs: classifiedRuns,
        summary,
    };

    console.log(JSON.stringify(summary, null, 2));
    await maybeWriteJson(args.jsonOut, payload);
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
