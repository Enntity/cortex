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

const getBenchmarkModels = () => {
  const models = config.get('models') || {};
  return Object.entries(models)
    .filter(([, model]) => model && LLM_MODEL_TYPES.has(model.type))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
};

test.before(async () => {
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
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

const benchmarkModel = async (modelName, promptText, timeoutMs) => {
  const startTime = Date.now();
  try {
    const response = await withTimeout(
      testServer.executeOperation({
        query: `query($text: String!, $model: String) {
          benchmark(text: $text, model: $model) {
            result
            errors
          }
        }`,
        variables: {
          text: promptText,
          model: modelName,
        },
      }),
      timeoutMs
    );

    const duration = Date.now() - startTime;
    const gqlErrors = response.body?.singleResult?.errors || [];
    if (gqlErrors.length > 0) {
      return {
        model: modelName,
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
        model: modelName,
        duration,
        success: false,
        error: pathwayErrors.join('; '),
        responseLength: 0,
      };
    }

    const responseLength = typeof result === 'string' ? result.length : JSON.stringify(result).length;
    return {
      model: modelName,
      duration,
      success: responseLength > 0,
      error: responseLength > 0 ? null : 'Model returned zero-length response',
      responseLength,
    };
  } catch (error) {
    return {
      model: modelName,
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
    'Avg Time'.padEnd(12) +
    'Min'.padEnd(10) +
    'Max'.padEnd(10) +
    'Avg Resp Len'
  );
  console.log('-'.repeat(80));

  for (const result of results) {
    const successRate = `${result.successful}/${result.totalTests}`;
    const status = result.failed > 0 ? '⚠️ ' : '✅ ';
    console.log(
      status + result.model.padEnd(38) +
      successRate.padEnd(10) +
      `${result.avgDuration}ms`.padEnd(12) +
      `${result.minDuration}ms`.padEnd(10) +
      `${result.maxDuration}ms`.padEnd(10) +
      `${result.avgResponseLength}`
    );
  }
};

test('model benchmark - all LLM models via GraphQL', async (t) => {
  t.timeout(1800000); // 30 minutes for a full benchmark run

  const models = getBenchmarkModels();
  if (models.length === 0) {
    t.pass('No LLM models configured for benchmarking');
    return;
  }

  const timeoutMs = 20000;
  const results = [];
  const totalRuns = models.length * TEST_PROMPTS.length;
  let completed = 0;

  console.log(`\n🚀 Starting benchmark for ${models.length} models with ${TEST_PROMPTS.length} prompts each (${totalRuns} total tests)\n`);

  for (const model of models) {
    for (const prompt of TEST_PROMPTS) {
      console.log(`\n🧪 [${completed + 1}/${totalRuns}] ${model} - ${prompt.name}`);
      const result = await benchmarkModel(model, prompt.text, timeoutMs);
      results.push({ ...result, promptName: prompt.name });
      completed += 1;

      if (result.success) {
        console.log(`   ✅ ${result.duration}ms - Response length: ${result.responseLength}`);
      } else {
        console.log(`   ❌ Failed: ${result.error}`);
      }
    }
  }

  console.log(`\n\n✅ All benchmarks completed (${completed}/${totalRuns})`);

  for (const prompt of TEST_PROMPTS) {
    const promptResults = results.filter(r => r.promptName === prompt.name);
    const perModelStats = models.map(model => {
      const modelResults = promptResults.filter(r => r.model === model);
      const successfulResults = modelResults.filter(r => r.success);
      const failedResults = modelResults.filter(r => !r.success);
      const durations = successfulResults.map(r => r.duration);
      const avgDuration = durations.length > 0
        ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
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
        minDuration: durations.length > 0 ? Math.min(...durations) : 0,
        maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
        avgResponseLength,
      };
    });

    printBenchmarkReport(perModelStats, prompt.name);
  }

  t.is(completed, totalRuns, 'All benchmark tests should complete');
});
