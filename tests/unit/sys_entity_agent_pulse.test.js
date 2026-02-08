// sys_entity_agent_pulse.test.js
// Tests for pulse-specific agent behaviors:
// - EndPulse tool call breaks the executor loop immediately
// - Pulse invocations (invocationType === 'pulse') skip the SetGoals gate

import test from 'ava';
import sysEntityAgent, { extractToolCalls, passesGate } from '../../pathways/system/entity/sys_entity_agent.js';
import { config } from '../../config.js';
import { getToolsForEntity } from '../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import { getEntityStore } from '../../lib/MongoEntityStore.js';

const buildToolDefinition = (name, pathwayName, overrides = {}) => ({
  pathwayName,
  definition: {
    type: 'function',
    icon: '🧪',
    function: {
      name,
      description: `Test tool for ${name}`,
      parameters: {
        type: 'object',
        properties: {
          userMessage: { type: 'string' },
        },
        required: [],
      },
    },
    ...overrides,
  },
});

const buildToolCall = (name, args = { userMessage: 'run test' }, id = 'call-1') => ({
  id,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

const buildSetGoalsCall = (goal = 'Test goal', steps = ['Step 1', 'Step 2'], id = 'plan-1') => ({
  id,
  type: 'function',
  function: {
    name: 'SetGoals',
    arguments: JSON.stringify({ goal, steps }),
  },
});

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-test-pulse',
  rootRequestId: 'root-req-test-pulse',
  pathway: sysEntityAgent,
  toolResultStore: new Map(),
  toolCallCache: new Map(),
  modelExecutor: {
    plugin: {
      truncateMessagesToTargetLength: (messages) => messages,
    },
  },
  promptAndParse: async () => 'final-response',
  ...overrides,
});

const setupConfig = () => {
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    endpulse: buildToolDefinition('EndPulse', 'test_tool_endpulse', {
      hideExecution: true,
      toolCost: 1,
    }),
    searchtool: buildToolDefinition('SearchTool', 'test_tool_search'),
    analyzetool: buildToolDefinition('AnalyzeTool', 'test_tool_analyze'),
  };

  const entityId = 'entity-test-pulse';
  const testEntity = {
    id: entityId,
    name: 'Test Pulse Entity',
    isDefault: true,
    tools: Object.keys(tools),
    customTools: tools,
  };

  const pathways = {
    ...originalPathways,
    sys_generator_error: {
      rootResolver: async (_parent, args) => ({
        result: `ERROR_RESPONSE: ${args.text}`,
      }),
    },
    test_tool_endpulse: {
      rootResolver: async () => ({
        result: JSON.stringify({ success: true, message: 'Resting.' }),
      }),
    },
    test_tool_search: {
      rootResolver: async () => ({
        result: JSON.stringify({ success: true, data: 'search results' }),
      }),
    },
    test_tool_analyze: {
      rootResolver: async () => ({
        result: JSON.stringify({ success: true, data: 'analysis results' }),
      }),
    },
  };

  config.load({
    pathways,
    entityTools: {},
  });

  const entityStore = getEntityStore();
  entityStore._entityCache.set(entityId, testEntity);
  entityStore._cacheTimestamps.set(entityId, Date.now());

  return {
    entityId,
    testEntity,
    originalPathways,
    originalEntityTools,
  };
};

const restoreConfig = (originals) => {
  config.load({
    pathways: originals.originalPathways,
    entityTools: originals.originalEntityTools,
  });

  const entityStore = getEntityStore();
  entityStore._entityCache.delete(originals.entityId);
  entityStore._cacheTimestamps.delete(originals.entityId);
};

// === TEST 1: EndPulse in executor loop breaks the loop immediately ===
test.serial('EndPulse in executor loop breaks the loop — cheap model called only once', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapModelCallCount++;
        // Return EndPulse — should break the loop
        return {
          tool_calls: [buildToolCall('EndPulse', { userMessage: 'Done for now.' }, `call-endpulse-${cheapModelCallCount}`)],
        };
      }
      // Synthesis call
      synthesisCallCount++;
      return 'Resting now.';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'autonomous pulse work' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse', // Skip gate for clean flow
  };

  // Initial tool calls with SetGoals + SearchTool
  const message = {
    tool_calls: [
      buildSetGoalsCall('Check status', ['Search for info'], 'plan-pulse-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-pulse'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(cheapModelCallCount, 1, 'Cheap model should be called exactly once (EndPulse breaks loop)');
  t.is(synthesisCallCount, 1, 'Synthesis should still run once after EndPulse');
});

// === TEST 2: Without EndPulse, executor loop continues normally ===
test.serial('Executor loop continues when EndPulse is not called (control test)', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapModelCallCount++;
        if (cheapModelCallCount === 1) {
          // First call: return SearchTool (NOT EndPulse) — loop continues
          return {
            tool_calls: [buildToolCall('SearchTool', { userMessage: 'more search' }, `call-search-${cheapModelCallCount}`)],
          };
        }
        // Second call: SYNTHESIZE — loop exits normally
        return 'SYNTHESIZE';
      }
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'do research' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Research', ['Search'], 'plan-no-endpulse'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(cheapModelCallCount, 2, 'Without EndPulse, executor loop continues (2 cheap model calls)');
});

// === TEST 3: Pulse invocations skip the SetGoals gate ===
test.serial('Pulse invocations skip SetGoals gate — no gate retries', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let gateRetryCount = 0;
  let cheapModelCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      // Gate retry detection: primary model, non-streaming
      if (args.modelOverride === 'test-primary-model' && args.stream === false) {
        gateRetryCount++;
        return {
          tool_calls: [
            buildSetGoalsCall('Retry plan', ['Step'], 'plan-retry'),
            buildToolCall('SearchTool', { userMessage: 'retry' }, 'call-retry'),
          ],
        };
      }
      if (args.modelOverride === 'test-cheap-model') {
        cheapModelCallCount++;
        return 'SYNTHESIZE';
      }
      // Synthesis (primary model, stream undefined)
      synthesisCallCount++;
      return 'pulse response';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'pulse work' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse', // Key: should skip gate
  };

  // Tool calls WITHOUT SetGoals — normally triggers gate retry
  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-pulse-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(gateRetryCount, 0, 'No gate retries for pulse invocations');
  t.true(cheapModelCallCount >= 1, 'Executor loop should run');
  t.is(synthesisCallCount, 1, 'Synthesis should run');
});

// === TEST 4: Non-pulse invocations still require SetGoals gate ===
test.serial('Non-pulse invocations without SetGoals trigger gate retry (control test)', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let gateRetryCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-primary-model' && args.stream === false) {
        gateRetryCount++;
        return {
          tool_calls: [
            buildSetGoalsCall('Retry plan', ['Step'], 'plan-retry'),
            buildToolCall('SearchTool', { userMessage: 'retry' }, 'call-retry'),
          ],
        };
      }
      if (args.modelOverride === 'test-cheap-model') return 'SYNTHESIZE';
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'user chat' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    // invocationType NOT set — defaults to non-pulse
  };

  // Tool calls WITHOUT SetGoals — should trigger gate
  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-chat-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.true(gateRetryCount >= 1, 'Non-pulse invocations should trigger gate retries');
});

// === TEST 5: EndPulse alongside other tools still breaks the loop ===
test.serial('EndPulse alongside other tools still breaks executor loop', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapModelCallCount++;
        // Return EndPulse alongside SearchTool — both execute, but loop breaks
        return {
          tool_calls: [
            buildToolCall('SearchTool', { userMessage: 'one last search' }, `call-last-search-${cheapModelCallCount}`),
            buildToolCall('EndPulse', { reflection: 'Done.' }, `call-endpulse-${cheapModelCallCount}`),
          ],
        };
      }
      return 'Resting.';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'pulse work' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Do stuff', ['Search', 'Rest'], 'plan-multi'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-init'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(cheapModelCallCount, 1, 'Loop should break after EndPulse even with other tools in same round');
});

// === TEST 6: EndPulse breaks loop even without a plan ===
test.serial('EndPulse breaks executor loop even when no SetGoals plan exists', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapModelCallCount++;
        return {
          tool_calls: [buildToolCall('EndPulse', { taskContext: 'Continue later.' }, `call-endpulse-noplan-${cheapModelCallCount}`)],
        };
      }
      synthesisCallCount++;
      return 'Going to rest.';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'pulse wake' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse',
  };

  // Pulse with no SetGoals — gate is skipped, tool calls proceed
  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'check' }, 'call-noplan-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(cheapModelCallCount, 1, 'EndPulse should break loop even without a plan');
  t.is(synthesisCallCount, 1, 'Synthesis should still run');
  t.falsy(resolver.toolPlan, 'No plan should exist');
});
