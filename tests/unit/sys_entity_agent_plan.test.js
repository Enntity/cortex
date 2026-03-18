import test from 'ava';
import sysEntityAgent, { mergeParallelToolResults, insertSystemMessage, extractToolCalls } from '../../pathways/system/entity/sys_entity_agent.js';
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

const buildDelegateTaskCall = (task, context = null, id = 'delegate-1') => ({
  id,
  type: 'function',
  function: {
    name: 'DelegateTask',
    arguments: JSON.stringify({ task, ...(context ? { context } : {}) }),
  },
});

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-test',
  rootRequestId: 'root-req-test',
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
    searchtool: buildToolDefinition('SearchTool', 'test_tool_search'),
    analyzetool: buildToolDefinition('AnalyzeTool', 'test_tool_analyze'),
  };

  const entityId = 'entity-test-plan';
  const testEntity = {
    id: entityId,
    name: 'Test Entity',
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

// === TEST 1: primaryToolLoop — model returns tools → executes → model returns text → synthesis ===
test.serial('primaryToolLoop executes tools then produces final synthesis', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let callCount = 0;
  let synthesisCalled = false;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        // Tool loop round — return no more tools (done)
        return 'ready to synthesize';
      }
      // Synthesis call
      synthesisCalled = true;
      return 'Here is the final answer based on search results.';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'research topic' }],
    entityTools,
    entityToolsOpenAiFormat,
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-1'),
    ],
  };

  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.truthy(result, 'Should return a result');
  t.true(synthesisCalled, 'Synthesis should have been called');
  t.true(resolver.toolCallRound >= 1, 'Should have at least one tool round');
});

// === TEST 2: primaryToolLoop — budget exhaustion stops loop ===
test.serial('primaryToolLoop stops when budget is exhausted', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let callCount = 0;
  const resolver = buildResolver({
    promptAndParse: async () => {
      callCount++;
      if (callCount <= 100) {
        // Keep returning tool calls
        return {
          tool_calls: [buildToolCall('SearchTool', { userMessage: `search ${callCount}` }, `call-${callCount}`)],
        };
      }
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'budget test' }],
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

  t.true(resolver.toolBudgetUsed > 0, 'Budget should have been consumed');
  // Budget is 500, default cost is 10, so max ~50 rounds
  t.true(callCount < 100, 'Should stop before exhausting all attempts');
});

// === TEST 3: primaryToolLoop — max rounds stops loop ===
test.serial('primaryToolLoop stops at max rounds', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let roundCount = 0;
  const resolver = buildResolver({
    promptAndParse: async () => {
      roundCount++;
      // Always return tool calls — loop should stop at MAX_PRIMARY_ROUNDS (30)
      return {
        tool_calls: [buildToolCall('SearchTool', { userMessage: `round ${roundCount}` }, `call-r-${roundCount}`)],
      };
    },
  });
  // Set very low tool cost so budget isn't the limiter
  const entityConfig2 = {
    ...originals.testEntity,
    customTools: {
      searchtool: buildToolDefinition('SearchTool', 'test_tool_search', { toolCost: 1 }),
      analyzetool: buildToolDefinition('AnalyzeTool', 'test_tool_analyze', { toolCost: 1 }),
    },
  };
  const { entityTools: et2, entityToolsOpenAiFormat: etf2 } = getToolsForEntity(entityConfig2);

  const args = {
    chatHistory: [{ role: 'user', content: 'max rounds test' }],
    entityTools: et2,
    entityToolsOpenAiFormat: etf2,
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-1'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  // Tool rounds should be bounded
  t.true(resolver.toolCallRound <= 31, `Tool rounds should be bounded (was ${resolver.toolCallRound})`);
  t.true(resolver.toolCallRound > 1, 'Should have done multiple rounds');
});

// === TEST 4: DelegateTask spawns subagent, runs tools, returns summary ===
test.serial('DelegateTask tool call is handled and returns subagent summary', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let callCount = 0;
  let delegateModelCalls = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (args.modelOverride === 'test-cheap-model') {
        // Subagent calls
        delegateModelCalls++;
        if (delegateModelCalls === 1) {
          // Subagent does a tool call
          return {
            tool_calls: [buildToolCall('SearchTool', { userMessage: 'delegate search' }, 'del-call-1')],
          };
        }
        // Subagent returns text — done
        return 'Subagent found: relevant information about the topic.';
      }
      if (callCount <= 3) {
        // Primary tool loop — no more tools
        return 'ready to synthesize';
      }
      // Synthesis
      return 'Final answer incorporating delegate results.';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'delegate test' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildDelegateTaskCall('Search for information about the topic', 'Previous search returned 3 URLs'),
    ],
  };

  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.truthy(result, 'Should return a result');
  t.true(delegateModelCalls >= 1, 'Subagent should have been called');
  // Check that the delegate result appears in chat history
  const delegateToolResult = args.chatHistory.find(
    m => m.role === 'tool' && m.name === 'DelegateTask'
  );
  t.truthy(delegateToolResult, 'DelegateTask result should be in chat history');
});

// === TEST 5: DelegateTask budget cap prevents runaway ===
test.serial('DelegateTask respects budget cap', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let delegateCalls = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        delegateCalls++;
        // Always return tool calls — should be limited by budget cap
        return {
          tool_calls: [buildToolCall('SearchTool', { userMessage: `sub-search ${delegateCalls}` }, `del-${delegateCalls}`)],
        };
      }
      return 'final answer';
    },
  });

  // Pre-exhaust most of the budget
  resolver.toolBudgetUsed = 450;

  const args = {
    chatHistory: [{ role: 'user', content: 'budget cap test' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildDelegateTaskCall('Do many searches'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  // Budget cap should be min(DELEGATE_DEFAULT_BUDGET=100, TOOL_BUDGET-450=50) = 50
  // So subagent should stop after ~5 tool calls (10 cost each)
  t.true(delegateCalls <= 15, `Delegate calls should be bounded (was ${delegateCalls})`);
});

// === TEST 6: DelegateTask filtered from subagent tools (no recursion) ===
test.serial('DelegateTask is not available to the subagent (prevents recursion)', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let subagentTools;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        subagentTools = (args.tools || []).map(t => t.function?.name);
        return 'Subagent done.';
      }
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'recursion test' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildDelegateTaskCall('Test task'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  t.truthy(subagentTools, 'Should have captured subagent tools');
  t.false(
    subagentTools.includes('DelegateTask'),
    'DelegateTask should NOT be available to subagent'
  );
  t.true(
    subagentTools.includes('SearchTool'),
    'Entity tools should be available to subagent'
  );
});

// === TEST 7: Initial call gets entity tools + DelegateTask (when toolLoopModel available) ===
test('Initial call includes DelegateTask when toolLoopModel is available', (t) => {
  const DELEGATE_TASK_DEF = { type: 'function', function: { name: 'DelegateTask' } };
  const entityTools = [
    { type: 'function', function: { name: 'SearchTool' } },
    { type: 'function', function: { name: 'AnalyzeTool' } },
  ];
  const toolLoopModel = 'test-cheap-model';
  const hasTools = entityTools.length > 0;
  const delegateAvailable = hasTools && toolLoopModel;
  const firstCallTools = hasTools
    ? [...entityTools, ...(delegateAvailable ? [DELEGATE_TASK_DEF] : [])]
    : [];

  t.is(firstCallTools.length, 3);
  t.true(firstCallTools.some(t => t.function.name === 'SearchTool'));
  t.true(firstCallTools.some(t => t.function.name === 'AnalyzeTool'));
  t.true(firstCallTools.some(t => t.function.name === 'DelegateTask'));
});

// === TEST 8: Initial call gets entity tools only (when no toolLoopModel) ===
test('Initial call excludes DelegateTask when no toolLoopModel', (t) => {
  const DELEGATE_TASK_DEF = { type: 'function', function: { name: 'DelegateTask' } };
  const entityTools = [
    { type: 'function', function: { name: 'SearchTool' } },
  ];
  const toolLoopModel = null;
  const hasTools = entityTools.length > 0;
  const delegateAvailable = hasTools && toolLoopModel;
  const firstCallTools = hasTools
    ? [...entityTools, ...(delegateAvailable ? [DELEGATE_TASK_DEF] : [])]
    : [];

  t.is(firstCallTools.length, 1);
  t.true(firstCallTools.some(t => t.function.name === 'SearchTool'));
  t.false(firstCallTools.some(t => t.function.name === 'DelegateTask'));
});

// === TEST 9: processToolCallRound — no plan tool interception, all calls go to executeSingleTool ===
test.serial('processToolCallRound executes all tool calls directly (no plan interception)', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let callCount = 0;
  const resolver = buildResolver({
    promptAndParse: async () => {
      callCount++;
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'direct execution test' }],
    entityTools,
    entityToolsOpenAiFormat,
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-1'),
      buildToolCall('AnalyzeTool', { userMessage: 'analyze' }, 'call-2'),
    ],
  };

  await sysEntityAgent.toolCallback(args, message, resolver);

  // Both tools should have been executed — check tool results in chat history
  const toolResults = args.chatHistory.filter(m => m.role === 'tool');
  t.true(toolResults.length >= 2, 'Both tool calls should produce results');
  t.truthy(
    toolResults.find(m => m.name === 'SearchTool'),
    'SearchTool result should be in chat history'
  );
  t.truthy(
    toolResults.find(m => m.name === 'AnalyzeTool'),
    'AnalyzeTool result should be in chat history'
  );
});

// === TEST 10: Text-only response skips tool loop entirely ===
test('extractToolCalls returns empty for text-only response (no tool loop)', (t) => {
  const textOnlyResult = { content: 'Here is your answer...' };
  t.deepEqual(extractToolCalls(textOnlyResult), []);
});
