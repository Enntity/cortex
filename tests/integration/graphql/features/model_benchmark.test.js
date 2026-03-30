// model_benchmark.test.js
// Simple benchmark test for supported LLM models via GraphQL

import test from 'ava';
import serverFactory from '../../../../index.js';
import { config } from '../../../../config.js';

let testServer;

const LLM_MODEL_TYPES = new Set([
  'OPENAI-CHAT',
  'OPENAI-CHAT-EXTENSION',
  'OPENAI-COMPLETION',
  'OPENAI-RESPONSES',
  'OPENAI-REASONING',
  'OPENAI-REASONING-VISION',
  'OPENAI-VISION',
  'GEMINI-1.5-VISION',
  'GEMINI-3-REASONING-VISION',
  'CLAUDE-ANTHROPIC',
  'CLAUDE-4-VERTEX',
  'GROQ-CHAT',
  'GROK-VISION',
  'GROK-RESPONSES',
  'OLLAMA-CHAT',
  'OLLAMA-COMPLETION',
  'COHERE-GENERATE',
  'COHERE-SUMMARIZE',
  'AZURE-FOUNDRY-AGENTS',
  'LOCAL-CPP-MODEL',
]);

const DEFAULT_FAST_MODEL_CANDIDATES = [
  'gemini-flash-31-lite-vision',
  'gemini-flash-3-vision',
  'oai-gpt54-mini',
  'oai-gpt54-nano',
  'oai-gpt41-mini',
  'oai-gpt41-nano',
  'oai-gpt5-mini',
  'claude-45-haiku',
];

const TEST_PROMPTS = [
  {
    name: 'Shortest',
    text: 'Reply with exactly one word: OK.',
  },
  {
    name: 'Longer',
    text: 'Explain how photosynthesis works in 5-7 sentences for a curious high-school student.',
  },
];

const parseCsvEnv = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
};

const parsePositiveIntEnv = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const calculatePercentile = (sortedValues, percentile) => {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  const normalizedIndex = Math.min(sortedValues.length - 1, Math.max(0, index));
  return sortedValues[normalizedIndex];
};

const getBenchmarkModels = () => {
  const models = config.get('models') || {};
  const configuredModels = Object.entries(models)
    .filter(([, model]) => model && LLM_MODEL_TYPES.has(model.type))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  const configuredSet = new Set(configuredModels);
  const requestedModels = parseCsvEnv(process.env.BENCHMARK_MODELS);
  if (requestedModels.length > 0) {
    return requestedModels.filter(name => configuredSet.has(name));
  }

  const fastConfiguredModels = DEFAULT_FAST_MODEL_CANDIDATES.filter(name => configuredSet.has(name));
  return fastConfiguredModels.length > 0 ? fastConfiguredModels : configuredModels;
};

const getBenchmarkCases = () => {
  const models = getBenchmarkModels();
  const compareReasoningModels = new Set(parseCsvEnv(process.env.BENCHMARK_COMPARE_REASONING_FOR));

  return models.flatMap(model => {
    const cases = [{
      benchmarkName: model,
      model,
      reasoningEffort: '',
    }];

    if (compareReasoningModels.has(model)) {
      cases.push({
        benchmarkName: `${model} [reasoning:none]`,
        model,
        reasoningEffort: 'none',
      });
    }

    return cases;
  });
};

test.before(async () => {
  const { server } = await serverFactory();
  await server.start();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
});

const withTimeout = (promise, ms) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Model call timed out after ${ms}ms`)), ms)),
  ]);
};

const benchmarkModel = async (benchmarkCase, promptText, timeoutMs) => {
  const { model: modelName, reasoningEffort = '', benchmarkName } = benchmarkCase;
  const startTime = Date.now();
  try {
    const response = await withTimeout(
      testServer.executeOperation({
        query: `query($text: String!, $model: String, $reasoningEffort: String) {
          benchmark(text: $text, model: $model, reasoningEffort: $reasoningEffort) {
            result
            errors
          }
        }`,
        variables: {
          text: promptText,
          model: modelName,
          reasoningEffort,
        },
      }),
      timeoutMs
    );

    const duration = Date.now() - startTime;
    const gqlErrors = response.body?.singleResult?.errors || [];
    if (gqlErrors.length > 0) {
      return {
        model: benchmarkName,
        duration,
        success: false,
        error: gqlErrors.map(e => e.message).join('; '),
        responseLength: 0,
      };
    }

    const result = response.body?.singleResult?.data?.benchmark?.result ?? '';
    const pathwayErrors = response.body?.singleResult?.data?.benchmark?.errors || [];
    if (pathwayErrors.length > 0) {
      return {
        model: benchmarkName,
        duration,
        success: false,
        error: pathwayErrors.join('; '),
        responseLength: 0,
      };
    }

    const responseLength = typeof result === 'string' ? result.length : JSON.stringify(result).length;
    return {
      model: benchmarkName,
      duration,
      success: responseLength > 0,
      error: responseLength > 0 ? null : 'Model returned zero-length response',
      responseLength,
    };
  } catch (error) {
    return {
      model: benchmarkName,
      duration: Date.now() - startTime,
      success: false,
      error: error?.message || String(error),
      responseLength: 0,
    };
  }
};

const printBenchmarkReport = (results, promptName) => {
  console.log('\n' + '='.repeat(80));
  console.log(`MODEL BENCHMARK REPORT (${promptName})`);
  console.log('='.repeat(80));
  console.log(
    'Model'.padEnd(40) +
    'Success'.padEnd(10) +
    'Median'.padEnd(10) +
    'P95'.padEnd(10) +
    'Avg'.padEnd(10) +
    'Min'.padEnd(10) +
    'Max'.padEnd(10) +
    'Avg Resp Len'
  );
  console.log('-'.repeat(80));

  const sortedResults = [...results].sort((a, b) => {
    if (a.successful === 0 && b.successful === 0) {
      return a.model.localeCompare(b.model);
    }
    if (a.successful === 0) {
      return 1;
    }
    if (b.successful === 0) {
      return -1;
    }
    return a.medianDuration - b.medianDuration || a.p95Duration - b.p95Duration || a.model.localeCompare(b.model);
  });

  for (const result of sortedResults) {
    const successRate = `${result.successful}/${result.totalTests}`;
    const status = result.failed > 0 ? '⚠️ ' : '✅ ';
    console.log(
      status + result.model.padEnd(38) +
      successRate.padEnd(10) +
      `${result.medianDuration}ms`.padEnd(10) +
      `${result.p95Duration}ms`.padEnd(10) +
      `${result.avgDuration}ms`.padEnd(10) +
      `${result.minDuration}ms`.padEnd(10) +
      `${result.maxDuration}ms`.padEnd(10) +
      `${result.avgResponseLength}`
    );
  }
};

const buildPerModelStats = (results, models) => {
  return models.map(model => {
    const modelResults = results.filter(r => r.model === model);
    const successfulResults = modelResults.filter(r => r.success);
    const failedResults = modelResults.filter(r => !r.success);
    const durations = successfulResults.map(r => r.duration);
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : 0;
    const medianDuration = durations.length > 0
      ? calculatePercentile(sortedDurations, 50)
      : 0;
    const p95Duration = durations.length > 0
      ? calculatePercentile(sortedDurations, 95)
      : 0;
    const avgResponseLength = successfulResults.length > 0
      ? Math.round(successfulResults.reduce((sum, r) => sum + r.responseLength, 0) / successfulResults.length)
      : 0;

    return {
      model,
      totalTests: modelResults.length,
      successful: successfulResults.length,
      failed: failedResults.length,
      avgDuration,
      medianDuration,
      p95Duration,
      minDuration: durations.length > 0 ? Math.min(...durations) : 0,
      maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
      avgResponseLength,
    };
  });
};

test('model benchmark - all LLM models via GraphQL', async (t) => {
  t.timeout(1800000); // 30 minutes for a full benchmark run

  const benchmarkCases = getBenchmarkCases();
  const caseNames = benchmarkCases.map(item => item.benchmarkName);

  if (benchmarkCases.length === 0) {
    t.pass('No LLM models configured for benchmarking');
    return;
  }

  const timeoutMs = 20000;
  const repeats = parsePositiveIntEnv(process.env.BENCHMARK_REPEATS, 1);
  const results = [];
  const totalRuns = benchmarkCases.length * TEST_PROMPTS.length * repeats;
  let completed = 0;

  console.log(`\n🚀 Starting benchmark for ${benchmarkCases.length} benchmark cases with ${TEST_PROMPTS.length} prompts each and ${repeats} repeats (${totalRuns} total tests)\n`);
  console.log(`Benchmark cases: ${caseNames.join(', ')}\n`);

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const benchmarkCase of benchmarkCases) {
      for (const prompt of TEST_PROMPTS) {
        console.log(`\n🧪 [${completed + 1}/${totalRuns}] repeat ${repeat}/${repeats} - ${benchmarkCase.benchmarkName} - ${prompt.name}`);
        const result = await benchmarkModel(benchmarkCase, prompt.text, timeoutMs);
        results.push({ ...result, promptName: prompt.name, repeat });
        completed += 1;

        if (result.success) {
          console.log(`   ✅ ${result.duration}ms - Response length: ${result.responseLength}`);
        } else {
          console.log(`   ❌ Failed: ${result.error}`);
        }
      }
    }
  }

  console.log(`\n\n✅ All benchmarks completed (${completed}/${totalRuns})`);

  for (const prompt of TEST_PROMPTS) {
    const promptResults = results.filter(r => r.promptName === prompt.name);
    const perModelStats = buildPerModelStats(promptResults, caseNames);

    printBenchmarkReport(perModelStats, prompt.name);
  }

  const overallStats = buildPerModelStats(results, caseNames);
  printBenchmarkReport(overallStats, 'Overall');

  const fastestModel = [...overallStats]
    .filter(result => result.successful > 0)
    .sort((a, b) => a.medianDuration - b.medianDuration || a.p95Duration - b.p95Duration || a.model.localeCompare(b.model))[0];

  if (fastestModel) {
    console.log(`\n🏁 Lowest latency supported model in this run: ${fastestModel.model} (${fastestModel.medianDuration}ms median, ${fastestModel.p95Duration}ms p95)`);
  }

  t.is(completed, totalRuns, 'All benchmark tests should complete');
});
