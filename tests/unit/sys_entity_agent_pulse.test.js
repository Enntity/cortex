// sys_entity_agent_pulse.test.js
// Tests for pulse-specific agent behaviors:
// - EndPulse tool call breaks the primary tool loop immediately

import test from 'ava';
import sysEntityAgent, { extractToolCalls } from '../../pathways/system/entity/sys_entity_agent.js';
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

// === TEST 1: EndPulse breaks the primary tool loop immediately ===
test.serial('EndPulse in tool loop breaks the loop — primary model not called again', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let toolLoopCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (args.tools && args.tools.length > 0) {
        toolLoopCallCount++;
        // Return EndPulse — should break the loop
        return {
          tool_calls: [buildToolCall('EndPulse', { userMessage: 'Done for now.' }, `call-endpulse-${toolLoopCallCount}`)],
        };
      }
      // Synthesis call (no tools)
      synthesisCallCount++;
      return 'Resting now.';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'autonomous pulse work' }],
    entityTools,
    entityToolsOpenAiFormat,
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse',
  };

  // Initial tool calls: SearchTool
  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-pulse'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  // EndPulse should break the loop — only one tool loop call needed
  t.is(toolLoopCallCount, 1, 'Tool loop should be called exactly once (EndPulse breaks loop)');
  t.is(synthesisCallCount, 1, 'Synthesis should still run once after EndPulse');
});

// === TEST 2: Without EndPulse, tool loop continues normally ===
test.serial('Tool loop continues when EndPulse is not called (control test)', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let toolLoopCallCount = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (args.tools && args.tools.length > 0) {
        toolLoopCallCount++;
        if (toolLoopCallCount === 1) {
          // First call: return SearchTool (NOT EndPulse) — loop continues
          return {
            tool_calls: [buildToolCall('SearchTool', { userMessage: 'more search' }, `call-search-${toolLoopCallCount}`)],
          };
        }
        // Second call: no tools — loop exits
        return 'done with tools';
      }
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'do research' }],
    entityTools,
    entityToolsOpenAiFormat,
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(toolLoopCallCount, 2, 'Without EndPulse, tool loop continues (2 calls)');
});

// === TEST 3: EndPulse alongside other tools still breaks the loop ===
test.serial('EndPulse alongside other tools still breaks tool loop', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let toolLoopCallCount = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (args.tools && args.tools.length > 0) {
        toolLoopCallCount++;
        // Return EndPulse alongside SearchTool — both execute, but loop breaks
        return {
          tool_calls: [
            buildToolCall('SearchTool', { userMessage: 'one last search' }, `call-last-search-${toolLoopCallCount}`),
            buildToolCall('EndPulse', { reflection: 'Done.' }, `call-endpulse-${toolLoopCallCount}`),
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
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse',
  };

  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-init'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(toolLoopCallCount, 1, 'Loop should break after EndPulse even with other tools in same round');
});

// === TEST 4: EndPulse breaks loop even without prior tools ===
test.serial('EndPulse breaks tool loop as first tool call', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let toolLoopCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (args.tools && args.tools.length > 0) {
        toolLoopCallCount++;
        return {
          tool_calls: [buildToolCall('EndPulse', { taskContext: 'Nothing to do.' }, `call-endpulse-nowork-${toolLoopCallCount}`)],
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
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
    invocationType: 'pulse',
  };

  // Pulse with just SearchTool initially, then EndPulse from model
  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'check' }, 'call-noplan-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(toolLoopCallCount, 1, 'EndPulse should break loop immediately');
  t.is(synthesisCallCount, 1, 'Synthesis should still run');
});
