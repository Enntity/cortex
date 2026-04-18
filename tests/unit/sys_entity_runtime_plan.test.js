import test from 'ava';
import sysEntityRuntime from '../../pathways/system/entity/sys_entity_runtime.js';
import {
  toolCallbackCore as toolCallback,
  mergeParallelToolResults,
  insertSystemMessage,
  extractToolCalls,
  buildStepInstruction,
  extractUserMessage,
  buildDefaultToolUserMessage,
  buildInitialPlanningTools,
  buildDelegateOnlyPlanningHistory,
  buildDirectReplyHistory,
  buildWorkerStartingHistory,
  buildRuntimeEvidenceLedgerText,
  shouldBreakForInsufficientGrounding,
  shouldForceInitialResearchDelegation,
  passesGate,
  adaptContinuityContextForPromptContext,
} from '../../pathways/system/entity/sys_entity_executor.js';
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

const buildDelegateResearchCall = (goal = 'Test goal', tasks = ['Task 1', 'Task 2'], id = 'delegate-1') => ({
  id,
  type: 'function',
  function: {
    name: 'DelegateResearch',
    arguments: JSON.stringify({ goal, tasks }),
  },
});

const buildDelegateTaskCall = (goal = 'Test goal', task = 'Task 1', id = 'delegate-task-1') => ({
  id,
  type: 'function',
  function: {
    name: 'DelegateTask',
    arguments: JSON.stringify({ goal, task }),
  },
});

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-test',
  rootRequestId: 'root-req-test',
  pathway: sysEntityRuntime,
  toolResultStore: new Map(),
  toolCallCache: new Map(),
  modelExecutor: {
    plugin: {
      truncateMessagesToTargetLength: (messages) => messages,
    },
  },
  ensureMemoryLoaded: async () => ({ enabled: false, attempted: false, loaded: false, skipped: true }),
  promptAndParse: async () => 'final-response',
  ...overrides,
});

const setupConfig = () => {
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    searchtool: buildToolDefinition('SearchTool', 'test_tool_search'),
    analyzetool: buildToolDefinition('AnalyzeTool', 'test_tool_analyze'),
    setbaseavatar: buildToolDefinition('SetBaseAvatar', 'test_tool_avatar', {
      function: {
        name: 'SetBaseAvatar',
        description: 'Test tool for SetBaseAvatar',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            userMessage: { type: 'string' },
          },
          required: [],
        },
      },
    }),
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
    test_tool_avatar: {
      rootResolver: async (_parent, args) => ({
        result: JSON.stringify({ success: true, file: args.file || '' }),
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

// === TEST 1: SetGoals intercepted and stored ===
test.serial('SetGoals is intercepted and stored on pathwayResolver.toolPlan', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  const resolver = buildResolver({
    promptAndParse: async () => 'done',
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'research topic' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Research the topic', ['Search for info', 'Analyze results']),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(resolver.toolPlan, 'toolPlan should be set on resolver');
  t.is(resolver.toolPlan.goal, 'Research the topic');
  t.deepEqual(resolver.toolPlan.steps, ['Search for info', 'Analyze results']);
});

test('sys_entity_runtime exposes the shared tool callback for streaming tool dispatch', (t) => {
  t.is(
    sysEntityRuntime.toolCallback,
    toolCallback,
    'Runtime pathway must expose toolCallback so streaming plugins can dispatch tool_calls',
  );
});

// === TEST 2: SetGoals alongside real tools ===
test.serial('SetGoals result and real tool results both appear in merged messages', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let capturedArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      capturedArgs = args;
      return 'done';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'do research' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Research goal', ['Step 1'], 'plan-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  // Both SetGoals and SearchTool should appear in chat history
  const toolMessages = capturedArgs.chatHistory.filter(m => m.role === 'tool');
  t.true(toolMessages.length >= 2, 'Should have at least 2 tool result messages');

  const planResult = toolMessages.find(m => m.name === 'SetGoals');
  t.truthy(planResult, 'SetGoals result should be in messages');
  t.true(planResult.content.includes('Plan acknowledged'));

  const searchResult = toolMessages.find(m => m.name === 'SearchTool');
  t.truthy(searchResult, 'SearchTool result should be in messages');
});

// === TEST 3: SetGoals-only call ===
test.serial('SetGoals-only call stores plan and produces valid messages without crash', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let capturedArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      capturedArgs = args;
      return 'done';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'plan only' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Solo plan goal', ['Only step']),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(resolver.toolPlan, 'toolPlan should be set');
  t.is(resolver.toolPlan.goal, 'Solo plan goal');

  const toolMessages = capturedArgs.chatHistory.filter(m => m.role === 'tool');
  t.true(toolMessages.length >= 1, 'Should have SetGoals tool result');
});

// === TEST 4: Malformed SetGoals ===
test.serial('Malformed SetGoals degrades gracefully without crash, other tools still execute', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let capturedArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      capturedArgs = args;
      return 'done';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'bad plan' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  // Malformed: arguments is not valid JSON
  const message = {
    tool_calls: [
      {
        id: 'plan-bad',
        type: 'function',
        function: {
          name: 'SetGoals',
          arguments: '{invalid json',
        },
      },
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-1'),
    ],
  };

  // Should not throw
  await toolCallback(args, message, resolver);

  // Plan should NOT be set (malformed)
  t.falsy(resolver.toolPlan, 'toolPlan should not be set for malformed plan');

  // SearchTool should still have executed
  const searchResult = capturedArgs.chatHistory.find(
    m => m.role === 'tool' && m.name === 'SearchTool'
  );
  t.truthy(searchResult, 'SearchTool should still execute alongside malformed SetGoals');
});

// === TEST 5: Plan-aware SYNTHESIZE hint ===
test.serial('Plan-aware SYNTHESIZE hint shows plan goal, steps, and batching directive', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelArgs;
  let callCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        // First cheap model call — capture args
        cheapModelArgs = JSON.parse(JSON.stringify(args));
        return 'SYNTHESIZE'; // Signal done
      }
      return 'final synthesis';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'what is the weather' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Find weather data', ['Search for weather API', 'Parse the results'], 'plan-weather'),
      buildToolCall('SearchTool', { userMessage: 'weather' }, 'call-weather'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(cheapModelArgs, 'Cheap model should have been called');

  // Find the system message in the cheap model's chat history
  const systemMsg = cheapModelArgs.chatHistory.find(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('TODO')
  );
  t.truthy(systemMsg, 'System message should contain TODO');
  t.true(systemMsg.content.includes('Find weather data'), 'Should contain plan goal');
  t.true(systemMsg.content.includes('Search for weather API'), 'Should contain item 1');
  t.true(systemMsg.content.includes('Parse the results'), 'Should contain item 2');
  t.true(systemMsg.content.includes('skip it'), 'Should tell executor to skip satisfied items');
  t.true(systemMsg.content.includes('Do NOT retry'), 'Should warn against retrying failed tools');
  t.true(systemMsg.content.includes('SYNTHESIZE when all items'), 'Should require all items addressed before SYNTHESIZE');
});

// === TEST 6: No plan fallback ===
test.serial('Generic SYNTHESIZE hint used when no plan exists', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelArgs;
  let callCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        cheapModelArgs = JSON.parse(JSON.stringify(args));
        return 'SYNTHESIZE';
      }
      return 'final synthesis';
    },
  });

  // No toolPlan set — malformed SetGoals passes gate but doesn't store plan

  const args = {
    chatHistory: [{ role: 'user', content: 'hello' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      { id: 'plan-bad-6', type: 'function', function: { name: 'SetGoals', arguments: '{invalid json' } },
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(cheapModelArgs, 'Cheap model should have been called');

  const systemMsg = cheapModelArgs.chatHistory.find(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SYNTHESIZE')
  );
  t.truthy(systemMsg, 'System message should contain SYNTHESIZE');
  t.true(
    systemMsg.content.includes('Use tools only when they advance the task'),
    'Should use generic hint when no plan'
  );
  t.false(
    systemMsg.content.includes('PLAN'),
    'Should NOT contain PLAN keyword in generic hint'
  );
});

// === TEST 7: SetGoals stripped from synthesis context ===
test.serial('SetGoals tool_call and result are stripped before synthesis model call', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisArgs;
  let callCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        // Cheap model says SYNTHESIZE
        return 'SYNTHESIZE';
      }
      // This is the synthesis call — capture args
      synthesisArgs = JSON.parse(JSON.stringify(args));
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

  // Send SetGoals + SearchTool together
  const message = {
    tool_calls: [
      buildSetGoalsCall('Research goal', ['Step 1', 'Step 2'], 'plan-strip-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-strip-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(synthesisArgs, 'Synthesis model should have been called');

  // SetGoals should NOT be in the synthesis context
  const setPlanToolResult = synthesisArgs.chatHistory.find(
    m => m.role === 'tool' && m.name === 'SetGoals'
  );
  t.falsy(setPlanToolResult, 'SetGoals tool result should be stripped from synthesis context');

  // Check no tool_calls reference SetGoals
  for (const msg of synthesisArgs.chatHistory) {
    if (msg.tool_calls) {
      const hasPlan = msg.tool_calls.some(tc => tc.function?.name === 'SetGoals');
      t.false(hasPlan, 'No tool_calls in synthesis context should reference SetGoals');
    }
  }

  // SearchTool SHOULD still be in synthesis context
  const searchResult = synthesisArgs.chatHistory.find(
    m => m.role === 'tool' && m.name === 'SearchTool'
  );
  t.truthy(searchResult, 'SearchTool result should remain in synthesis context');
});

// === TEST 8: SetGoals not in cheap model tools ===
test.serial('SetGoals is not in cheap model tool list', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelToolNames;
  let callCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        // Capture the tools given to the cheap model
        cheapModelToolNames = (args.tools || []).map(t => t.function?.name);
        return 'SYNTHESIZE';
      }
      return 'final synthesis';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'test tools' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Test tools goal', ['Step 1'], 'plan-tools-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-tools-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(cheapModelToolNames, 'Should have captured cheap model tools');
  t.false(
    cheapModelToolNames.includes('SetGoals'),
    'Cheap model should NOT have SetGoals in its tools'
  );
});

// === TEST 9: Budget not charged for SetGoals ===
test.serial('SetGoals does not consume tool budget (skipBudget: true)', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  const resolver = buildResolver({
    promptAndParse: async () => 'done',
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'plan budget test' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  // Only SetGoals — should cost 0
  const message = {
    tool_calls: [
      buildSetGoalsCall('Budget test', ['Step 1']),
    ],
  };

  await toolCallback(args, message, resolver);

  t.is(resolver.toolBudgetUsed, 0, 'SetGoals should not consume any budget');
  t.is(resolver.toolCallRound, 1, 'Should still count as a tool round');
});

// === TEST 10: Plan hint includes round number ===
test.serial('Plan hint includes current round number for model orientation', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapModelArgsList = [];
  let callCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        // First cheap model call — capture and return more tool calls
        cheapModelArgsList.push(JSON.parse(JSON.stringify(args)));
        return {
          tool_calls: [buildToolCall('AnalyzeTool', { userMessage: 'analyze' }, 'call-analyze-1')],
        };
      }
      if (callCount === 2) {
        // Second cheap model call — capture and done
        cheapModelArgsList.push(JSON.parse(JSON.stringify(args)));
        return 'SYNTHESIZE';
      }
      return 'final synthesis';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'do task' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Two-step task', ['Step one', 'Step two'], 'plan-step-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-search-step'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.true(cheapModelArgsList.length >= 1, 'Should have at least one cheap model call');
  // Both calls should show the full plan with round number
  for (const cheapArgs of cheapModelArgsList) {
    const systemMsg = cheapArgs.chatHistory.find(
      m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('TODO')
    );
    t.truthy(systemMsg, 'Each round should have todo hint');
    t.true(systemMsg.content.includes('skip it'), 'Should tell executor to skip satisfied items');
    t.true(systemMsg.content.includes('Step one'), 'Should show all items');
    t.true(systemMsg.content.includes('Step two'), 'Should show all items');
  }
});

// === TEST 11: Replan via DelegateResearch in supervisor review triggers new executor loop ===
test.serial('DelegateResearch call from supervisor review triggers replan and re-enters executor loop', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let callCount = 0;
  let replanDetected = false;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      callCount++;
      if (callCount === 1) {
        // Supervisor review call — return a DelegateResearch tool call (replan signal)
        return {
          tool_calls: [buildDelegateResearchCall('New plan goal', ['New step 1', 'New step 2'], 'delegate-1')],
        };
      }
      if (callCount === 2) {
        // Delegated worker round — return tool calls
        replanDetected = true;
        return {
          tool_calls: [buildToolCall('SearchTool', { userMessage: 'new search' }, 'call-new-1')],
        };
      }
      // Final synthesis after the worker round
      return 'final answer after replan';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'test replan' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Original goal', ['Original step'], 'plan-orig-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-orig-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.true(replanDetected, 'Replan should have triggered re-entry into executor loop');
  t.is(resolver.toolPlan.goal, 'New plan goal', 'Plan should be updated to new goal');
  t.deepEqual(resolver.toolPlan.steps, ['New step 1', 'New step 2'], 'Plan steps should be updated');
});

// === TEST 12: Non-actionable DelegateResearch replans are finalized ===
test.serial('DelegateResearch replans without new executable work are finalized instead of looping', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisCallCount = 0;
  let finalizationCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      // Every cheap model call returns SYNTHESIZE immediately
      if (args.modelOverride === 'test-cheap-model') {
        return 'SYNTHESIZE';
      }
      if ((args.tools || []).length === 0) {
        finalizationCallCount++;
        return 'Final answer after blocked replan';
      }
      // Every supervisor review call returns DelegateResearch (trying to replan infinitely)
      synthesisCallCount++;
      return {
        tool_calls: [buildDelegateResearchCall(`Replan ${synthesisCallCount}`, ['Step A'], `delegate-${synthesisCallCount}`)],
      };
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'infinite replan test' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Initial plan', ['Step 1'], 'plan-inf-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-inf-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Final answer after blocked replan');
  t.is(synthesisCallCount, 2, `Expected exactly one replan attempt before finalization (was ${synthesisCallCount})`);
  t.is(finalizationCallCount, 1, 'Runtime should force one direct finalization call');
});

test.serial('Streamed DelegateResearch with the same plan during synthesis finalizes instead of looping', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptCalls = 0;
  let finalizeArgs = null;
  const resolver = buildResolver({
    toolPlan: { goal: 'Test goal', steps: ['Task 1'] },
    _cycleExecutedToolCount: 0,
    entityRuntimeState: {
      currentStage: 'synthesize',
      stopReason: null,
    },
    promptAndParse: async (args) => {
      promptCalls += 1;
      finalizeArgs = JSON.parse(JSON.stringify(args));
      return 'Finalized from evidence';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'Who owns it?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'gemini-flash-3-vision',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildDelegateResearchCall('Test goal', ['Task 1'], 'delegate-stream-same-plan-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Finalized from evidence');
  t.is(promptCalls, 1, 'Same-plan streamed delegation should go straight to finalization');
  t.deepEqual(finalizeArgs.tools || [], [], 'Finalization should run with no tools exposed');
});

// === TEST 13: Runtime supervisor review keeps delegation-only tools ===
test.serial('Runtime supervisor review keeps delegation-only tools', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisToolNames;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      // Initial executed tools should go straight to supervisor review.
      synthesisToolNames = (args.tools || []).map(t => t.function?.name);
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'test synthesis tools' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Synthesis tools test', ['Step 1'], 'plan-synth-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-synth-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.truthy(synthesisToolNames, 'Should have captured supervisor review tools');
  t.true(synthesisToolNames.includes('DelegateResearch'), 'Supervisor review should have DelegateResearch tool');
  t.true(synthesisToolNames.includes('DelegateTask'), 'Supervisor review should have DelegateTask tool');
  t.deepEqual(synthesisToolNames, ['DelegateResearch', 'DelegateTask'], 'Runtime supervisor review should only keep delegation tools');
});

test.serial('Gemini supervisor review sanitizes prior tool history into text evidence', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisArgs;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        return 'SYNTHESIZE';
      }
      synthesisArgs = JSON.parse(JSON.stringify(args));
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'who owns the arcade?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'gemini-flash-3-vision',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Identify the owner', ['Search for the owner name'], 'plan-gemini-sanitize-1'),
      buildToolCall('SearchTool', { userMessage: 'owner search' }, 'call-gemini-sanitize-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.deepEqual(
    (synthesisArgs.tools || []).map(tool => tool.function?.name),
    ['DelegateResearch', 'DelegateTask'],
    'Gemini supervisor review should keep only delegation tools',
  );

  const hasStructuredSearchHistory = (synthesisArgs.chatHistory || []).some((entry) => (
    (Array.isArray(entry.tool_calls) && entry.tool_calls.some((call) => call.function?.name === 'SearchTool'))
    || (entry.role === 'tool' && entry.name === 'SearchTool')
  ));
  t.false(hasStructuredSearchHistory, 'Gemini supervisor review should not retain raw SearchTool tool history');

  const evidenceLedger = (synthesisArgs.chatHistory || []).find((entry) => (
    typeof entry.content === 'string'
    && entry.content.includes('Runtime evidence ledger:')
    && entry.content.includes('SearchTool')
  ));
  t.truthy(evidenceLedger, 'Gemini supervisor review should retain tool evidence in the runtime evidence ledger');

  const originalHistoryTextLeak = (args.chatHistory || []).find((entry) => (
    typeof entry.content === 'string'
    && entry.content.includes('[Prior tool result: SearchTool]')
  ));
  t.falsy(originalHistoryTextLeak, 'Canonical chat history should not be rewritten with textualized prior tool results');

  const reviewMessage = (synthesisArgs.chatHistory || []).find((entry) => (
    entry.role === 'user'
    && typeof entry.content === 'string'
    && entry.content.includes('Look at the evidence above against the active request')
  ));
  t.truthy(reviewMessage, 'Gemini supervisor review should keep the review instruction in its own injected turn');

  const evidenceWithGluedInstruction = (synthesisArgs.chatHistory || []).find((entry) => (
    typeof entry.content === 'string'
    && entry.content.includes('[Prior tool result: SearchTool]')
    && entry.content.includes('Look at the evidence above against the active request')
  ));
  t.falsy(evidenceWithGluedInstruction, 'Gemini supervisor review should not glue instructions onto textualized evidence');
});

test.serial('Runtime supervisor review message forbids narrated instruction review', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisArgs;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        return 'SYNTHESIZE';
      }
      synthesisArgs = JSON.parse(JSON.stringify(args));
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'what happened?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'gemini-flash-3-vision',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Summarize the latest findings', ['Check the gathered evidence'], 'plan-synth-guard-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-synth-guard-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  const reviewMessage = synthesisArgs.chatHistory.find((entry) => (
    entry.role === 'user'
    && typeof entry.content === 'string'
    && entry.content.includes('Look at the evidence above against the active request')
  ));

  t.truthy(reviewMessage, 'Should include a synthesis review message');
  t.true(reviewMessage.content.includes('If you can answer now, answer in your normal voice'));
  t.true(reviewMessage.content.includes('If one bounded follow-up task remains, call DelegateTask'));
  t.true(reviewMessage.content.includes('If more information gathering is needed in parallel, call DelegateResearch'));
});

test.serial('Claude supervisor review sanitizes prior tool history into text evidence', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisArgs;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        return 'SYNTHESIZE';
      }
      synthesisArgs = JSON.parse(JSON.stringify(args));
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'who owns the arcade?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'claude-46-sonnet',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Identify the owner', ['Search for the owner name'], 'plan-claude-sanitize-1'),
      buildToolCall('SearchTool', { userMessage: 'owner search' }, 'call-claude-sanitize-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.deepEqual(
    (synthesisArgs.tools || []).map(tool => tool.function?.name),
    ['DelegateResearch', 'DelegateTask'],
    'Claude supervisor review should keep only delegation tools',
  );

  const hasStructuredSearchHistory = (synthesisArgs.chatHistory || []).some((entry) => (
    (Array.isArray(entry.tool_calls) && entry.tool_calls.some((call) => call.function?.name === 'SearchTool'))
    || (entry.role === 'tool' && entry.name === 'SearchTool')
  ));
  t.false(hasStructuredSearchHistory, 'Claude supervisor review should not retain raw SearchTool tool history');

  const evidenceLedger = (synthesisArgs.chatHistory || []).find((entry) => (
    typeof entry.content === 'string'
    && entry.content.includes('Runtime evidence ledger:')
    && entry.content.includes('SearchTool')
  ));
  t.truthy(evidenceLedger, 'Claude supervisor review should retain tool evidence in the runtime evidence ledger');

  const reviewSystemTurn = (synthesisArgs.chatHistory || []).find((entry) => (
    entry.role === 'system'
    && typeof entry.content === 'string'
    && entry.content.includes('Look at the evidence above against the active request')
  ));
  t.truthy(reviewSystemTurn, 'Claude supervisor review should keep the review instruction in its own system turn');

  const evidenceWithGluedInstruction = (synthesisArgs.chatHistory || []).find((entry) => (
    typeof entry.content === 'string'
    && entry.content.includes('[Prior tool result: SearchTool]')
    && entry.content.includes('Look at the evidence above against the active request')
  ));
  t.falsy(evidenceWithGluedInstruction, 'Claude supervisor review should not glue instructions onto textualized evidence');
});

test.serial('Supervisor review can delegate one serial task that the worker executes end-to-end', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-synth-recover',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapCallCount++;
        if (cheapCallCount === 1) {
          return {
            tool_calls: [buildToolCall('SearchTool', { userMessage: 'run the recovery search' }, 'executor-search-1')],
          };
        }
        return 'SYNTHESIZE';
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateTaskCall('recover synthesis replan', 'Run the recovery search', 'delegate-task-recover-1'),
          ],
        };
      }
      return 'Recovered final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'recover synthesis replan' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Initial arcade plan', ['Identify the venue'], 'plan-recover-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Recovered final answer');
  t.is(cheapCallCount, 2, 'Delegated serial work should use one worker tool round and one worker completion round');
  t.is(synthesisCallCount, 2, 'Synthesis should re-run once after the recovery tool round');
  t.is(resolver.toolBudgetUsed, 10, 'Only the recovered executor search should consume budget');
  t.not(resolver.entityRuntimeState.stopReason, 'stage_tool_block');
  t.is(resolver.toolPlan.goal, 'recover synthesis replan');
});

test.serial('Runtime worker loop can execute SetBaseAvatar after supervisor delegates the final action', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-avatar-followthrough',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapCallCount++;
        if (args.chatHistory?.some((entry) => entry.role === 'tool' && entry.name === 'SetBaseAvatar')) {
          return 'SYNTHESIZE';
        }
        return {
          tool_calls: [
            buildToolCall('SetBaseAvatar', {
              file: '/workspace/files/chats/abc123/jinx_headshot_closeup.webp',
              userMessage: 'Setting the closeup avatar.',
            }, 'worker-avatar-1'),
          ],
        };
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Set the discovered closeup as the base avatar.',
              ['Call SetBaseAvatar with /workspace/files/chats/abc123/jinx_headshot_closeup.webp.'],
              'delegate-avatar-1',
            ),
          ],
        };
      }
      return 'Avatar updated';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'set the renamed closeup avatar' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Find and set the renamed closeup avatar.', ['Find the correct image path'], 'plan-avatar-1'),
      buildToolCall('SearchTool', { userMessage: 'find the renamed avatar file' }, 'search-avatar-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Avatar updated');
  t.is(cheapCallCount, 2, 'Worker should execute the final action and then yield cleanly');
  t.is(synthesisCallCount, 2, 'Supervisor should review once, then finalize after the worker action');
  t.is(resolver.toolBudgetUsed, 20, 'SearchTool and SetBaseAvatar should both consume budget');
  t.not(resolver.entityRuntimeState.stopReason, 'stage_tool_block');
  t.true(
    args.chatHistory.some((entry) => entry.role === 'tool' && entry.name === 'SetBaseAvatar'),
    'Chat history should include the SetBaseAvatar tool result',
  );
});

test.serial('Runtime delegated research fans out worker tasks into parallel child worker calls', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisCallCount = 0;
  const workerTasks = [];
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-fanout-workers',
      authorityEnvelope: {
        maxToolCallsPerRound: 6,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 3,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        const task = String(args.workerTaskBrief || '');
        if (args.chatHistory?.filter((entry) => entry.role === 'tool' && entry.name === 'SearchTool').length > 1) {
          return 'SYNTHESIZE';
        }
        workerTasks.push(task);
        if (task.includes('friends')) {
          return {
            tool_calls: [
              buildToolCall('SearchTool', { userMessage: 'search the friend thread' }, 'worker-friends-1'),
            ],
          };
        }
        if (task.includes('family')) {
          return {
            tool_calls: [
              buildToolCall('SearchTool', { userMessage: 'search the family thread' }, 'worker-family-1'),
            ],
          };
        }
        return 'SYNTHESIZE';
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Identify the user’s orbit from several angles.',
              ['Search for friends and crew names', 'Search for family and relationship references'],
              'delegate-fanout-1',
            ),
          ],
        };
      }
      return 'Fanout final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'Who is in my orbit?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Find the people in the user orbit.', ['Find initial evidence'], 'plan-fanout-1'),
      buildToolCall('SearchTool', { userMessage: 'run the first lookup' }, 'search-fanout-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Fanout final answer');
  t.deepEqual(
    [...new Set(workerTasks)].sort(),
    ['Search for family and relationship references', 'Search for friends and crew names'].sort(),
    'Delegated tasks should be dispatched as separate child worker prompts',
  );
  t.is(resolver.entityRuntimeState.childRuns, 2, 'Fanout should consume child worker budget');
  t.is(
    args.chatHistory.filter((entry) => entry.role === 'tool' && entry.name === 'SearchTool').length,
    3,
    'Merged chat history should include the initial tool result plus both fanout worker results',
  );
  t.is(resolver.toolBudgetUsed, 30, 'Initial search plus two fanout searches should all consume tool budget');
});

test.serial('Delegated worker can autonomously run multiple tool rounds for its assigned task', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let workerCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-autonomous-worker',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        workerCallCount++;
        const hasSearchResult = args.chatHistory.some((entry) => entry.role === 'tool' && entry.name === 'SearchTool');
        const hasAnalyzeResult = args.chatHistory.some((entry) => entry.role === 'tool' && entry.name === 'AnalyzeTool');
        if (!hasSearchResult) {
          return {
            tool_calls: [
              buildToolCall('SearchTool', { userMessage: 'look for names' }, 'worker-auto-search-1'),
            ],
          };
        }
        if (!hasAnalyzeResult) {
          return {
            tool_calls: [
              buildToolCall('AnalyzeTool', { userMessage: 'analyze the names' }, 'worker-auto-analyze-1'),
            ],
          };
        }
        return 'SYNTHESIZE';
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Resolve the assigned orbit slice.',
              ['Find names and then analyze what they mean'],
              'delegate-auto-worker-1',
            ),
          ],
        };
      }
      return 'Autonomous worker final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'Who is in my orbit?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Find the orbit details.', ['Gather enough evidence to answer'], 'plan-auto-worker-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Autonomous worker final answer');
  t.true(workerCallCount >= 3, 'Worker should think, act, then think again before yielding');
  t.true(
    args.chatHistory.some((entry) => entry.role === 'tool' && entry.name === 'SearchTool'),
    'Worker should execute the first research tool itself',
  );
  t.true(
    args.chatHistory.some((entry) => entry.role === 'tool' && entry.name === 'AnalyzeTool'),
    'Worker should execute a follow-up tool in a later autonomous round',
  );
});

test.serial('Supervisor no_executable_work short-circuits finalize when a usable draft already exists', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-short-circuit-finalize',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapCallCount++;
        return 'SYNTHESIZE';
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Try another round',
              ['Find more evidence'],
              'delegate-no-work-1',
            ),
          ],
        };
      }
      return {
        tool_calls: [
          buildDelegateResearchCall(
            'Try a different round',
            ['Check a different angle'],
            'delegate-no-work-1b',
          ),
        ],
      };
    },
  });

  const args = {
    chatHistory: [
      { role: 'user', content: 'what happened?' },
      { role: 'assistant', content: 'Here is the best grounded answer so far.' },
    ],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Explain what happened.', ['Find enough evidence to answer'], 'plan-no-work-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Here is the best grounded answer so far.');
  t.is(cheapCallCount, 1);
  t.is(synthesisCallCount, 2, 'No extra synthesis_finalize pass should run when a usable draft exists');
});

test.serial('Supervisor no_executable_work does one guarded finalize when no usable draft exists', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-guarded-finalize',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapCallCount++;
        return 'SYNTHESIZE';
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Try another round',
              ['Find more evidence'],
              'delegate-no-work-2',
            ),
          ],
        };
      }
      if (synthesisCallCount === 2) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Try a different round',
              ['Check a different angle'],
              'delegate-no-work-2b',
            ),
          ],
        };
      }
      return 'Guarded final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'what happened?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Explain what happened.', ['Find enough evidence to answer'], 'plan-no-work-2'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Guarded final answer');
  t.is(cheapCallCount, 1);
  t.is(synthesisCallCount, 3, 'Exactly one guarded finalize pass should run when no draft exists');
});

test.serial('Supervisor no_executable_work does not reuse the previous turn assistant message as a draft', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let cheapCallCount = 0;
  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-no-stale-draft-reuse',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        cheapCallCount++;
        return 'SYNTHESIZE';
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Try another round',
              ['Find more evidence'],
              'delegate-stale-draft-1',
            ),
          ],
        };
      }
      if (synthesisCallCount === 2) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Try a different round',
              ['Check a different angle'],
              'delegate-stale-draft-2',
            ),
          ],
        };
      }
      return 'Fresh guarded finalize answer after the current user turn.';
    },
  });

  const args = {
    chatHistory: [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'Previous turn answer that must not be reused.' },
      { role: 'user', content: 'current question' },
    ],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Answer the current question.', ['Find enough evidence to answer'], 'plan-stale-draft-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Fresh guarded finalize answer after the current user turn.');
  t.is(cheapCallCount, 1);
  t.is(synthesisCallCount, 3, 'Should do a guarded finalize instead of reusing the previous turn answer');
});

test('extractUserMessage unwraps structured text payloads before routing', (t) => {
  t.is(
    extractUserMessage({
      chatHistory: [{ role: 'user', content: '{"type":"text","text":"What do you know about me?"}' }],
    }),
    'What do you know about me?',
  );

  t.is(
    extractUserMessage({
      chatHistory: [{ role: 'user', content: [{ type: 'text', text: 'Who is in my orbit?' }] }],
    }),
    'Who is in my orbit?',
  );

  t.is(
    extractUserMessage({
      chatHistory: [
        { role: 'user', content: '{"success":true,"message":"Found 5 relevant memories."}' },
        { role: 'user', content: 'Actual current question' },
      ],
    }),
    'Actual current question',
  );
});

test('buildDefaultToolUserMessage derives SearchMemory status copy from the query', (t) => {
  t.is(
    buildDefaultToolUserMessage('SearchMemory', {
      query: 'Who are the specific people in Jason\'s orbit?',
    }),
    'Checking memory for Who are the specific people in Jason\'s orbit.',
  );

  t.is(
    buildDefaultToolUserMessage('SearchMemory', {}),
    'Checking memory.',
  );
});

test('buildInitialPlanningTools keeps one runtime code path for direct work and delegated research', (t) => {
  const planningTools = [
    { function: { name: 'SearchMemory' } },
    { function: { name: 'SearchInternet' } },
  ];

  t.deepEqual(
    buildInitialPlanningTools({
      planningToolsOpenAiFormat: planningTools,
      entityToolsOpenAiFormat: planningTools,
      runtimeEnabled: true,
      delegateOnly: true,
    }).map((tool) => tool.function.name),
    ['DelegateResearch'],
  );

  t.deepEqual(
    buildInitialPlanningTools({
      planningToolsOpenAiFormat: planningTools,
      entityToolsOpenAiFormat: planningTools,
      runtimeEnabled: true,
    }).map((tool) => tool.function.name),
    ['DelegateResearch', 'SearchMemory', 'SearchInternet'],
  );
});

test('buildDelegateOnlyPlanningHistory keeps a broad recent conversational tail for referential follow-ups', (t) => {
  const resolver = buildResolver();
  const history = buildDelegateOnlyPlanningHistory([
    { role: 'assistant', content: 'Old answer' },
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: '', tool_calls: [buildToolCall('SearchTool', { userMessage: 'search' }, 'call-old')] },
    { role: 'tool', tool_call_id: 'call-old', name: 'SearchTool', content: 'Old tool output' },
    { role: 'assistant', content: 'Hero runs means quarter-mile runs for the Model Y Performance.' },
    { role: 'user', content: 'Right, check the forums.' },
    { role: 'user', content: 'Who is in my orbit?' },
  ], resolver, {
    initialToolNames: ['SearchMemory', 'WorkspaceSSH'],
  });

  t.is(history.length, 5);
  t.is(history[0].content, 'Old question');
  t.is(history[1].content, 'Hero runs means quarter-mile runs for the Model Y Performance.');
  t.is(history[2].content, 'Right, check the forums.');
  t.is(history[3].content, 'Who is in my orbit?');
  t.true(history[history.length - 1].content.includes('Delegate the research only.'));
  const insertedSystem = history.find((message) => typeof message.content === 'string' && message.content.includes('Delegate the research only.'));
  t.truthy(insertedSystem);
  t.true(insertedSystem.content.includes('Prefer these source families first: memory.'));
});

test('buildWorkerStartingHistory keeps system instructions and trims conversational history', (t) => {
  const history = buildWorkerStartingHistory([
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: 'Old answer' },
    { role: 'user', content: '[system message: req-test] Follow the delegated task list.' },
    { role: 'assistant', content: '', tool_calls: [buildToolCall('SearchTool', { userMessage: 'search' }, 'call-old')] },
    { role: 'tool', tool_call_id: 'call-old', name: 'SearchTool', content: 'Old tool output' },
    { role: 'assistant', content: 'Recent answer framing' },
    { role: 'user', content: 'Who is in my orbit?' },
  ]);

  t.deepEqual(
    history.map((message) => message.content || message.role),
    [
      '[system message: req-test] Follow the delegated task list.',
      'Old question',
      'Old answer',
      'Recent answer framing',
      'Who is in my orbit?',
    ],
  );
});

test('buildDirectReplyHistory keeps broad recent conversational context without tool transcript', (t) => {
  const history = buildDirectReplyHistory([
    { role: 'assistant', content: 'Earlier framing' },
    { role: 'user', content: 'We are talking about the Model Y Performance.' },
    { role: 'assistant', content: '', tool_calls: [buildToolCall('SearchTool', { userMessage: 'search' }, 'call-old')] },
    { role: 'tool', tool_call_id: 'call-old', name: 'SearchTool', content: 'Old tool output' },
    { role: 'assistant', content: 'Hero runs means quarter-mile runs.' },
    { role: 'user', content: 'Right.' },
    { role: 'assistant', content: 'Forums will probably have the best recent slips.' },
    { role: 'user', content: 'What were the record runs again?' },
  ], {
    maxTurns: 10,
    maxMessages: 20,
  });

  t.deepEqual(
    history.map((message) => message.content),
    [
      'We are talking about the Model Y Performance.',
      'Hero runs means quarter-mile runs.',
      'Right.',
      'Forums will probably have the best recent slips.',
      'What were the record runs again?',
    ],
  );
});

test('buildRuntimeEvidenceLedgerText preserves full evidence bodies', (t) => {
  const text = buildRuntimeEvidenceLedgerText([
    {
      toolName: 'SearchMemory',
      content: 'Found Hobbs and Bahrain references.\nAmanda appears in the recovered artifact.',
      metadata: { toolArgs: { query: 'Who is in Jason\'s orbit?' } },
    },
    {
      toolName: 'WorkspaceSSH',
      content: 'No extra names in workspace files.\nChecked /workspace/files/profile.txt.',
      metadata: { toolArgs: { command: 'grep -r Jason /workspace/files/' } },
    },
  ]);

  t.true(text.startsWith('Runtime evidence ledger:\n'));
  t.true(text.includes("- SearchMemory (Who is in Jason's orbit?)"));
  t.true(text.includes('Amanda appears in the recovered artifact.'));
  t.true(text.includes('- WorkspaceSSH (grep -r Jason /workspace/files/)'));
  t.true(text.includes('Checked /workspace/files/profile.txt.'));
});

test('shouldBreakForInsufficientGrounding trips after repeated thin-novelty replans', (t) => {
  t.true(
    shouldBreakForInsufficientGrounding({
      replanCount: 3,
      toolBudgetUsed: 40,
      entityRuntimeState: {
        stopReason: null,
        evidenceItems: 5,
        childRuns: 3,
        noveltyHistory: [1, 1, 1],
        authorityEnvelope: {
          noveltyWindow: 2,
          maxFanoutWidth: 4,
        },
      },
    }),
  );

  t.true(
    shouldBreakForInsufficientGrounding({
      replanCount: 1,
      toolBudgetUsed: 12,
      entityRuntimeState: {
        stopReason: null,
        evidenceItems: 2,
        childRuns: 2,
        idleWorkerRounds: 1,
        noveltyHistory: [1, 0],
        authorityEnvelope: {
          noveltyWindow: 2,
          maxFanoutWidth: 4,
        },
      },
    }),
  );

  t.false(
    shouldBreakForInsufficientGrounding({
      replanCount: 1,
      toolBudgetUsed: 10,
      entityRuntimeState: {
        stopReason: null,
        evidenceItems: 2,
        childRuns: 1,
        idleWorkerRounds: 0,
        noveltyHistory: [3, 2],
        authorityEnvelope: {
          noveltyWindow: 2,
          maxFanoutWidth: 4,
        },
      },
    }),
  );
});

test('shouldForceInitialResearchDelegation treats research-shaped plan routes as delegate-first research', (t) => {
  t.true(
    shouldForceInitialResearchDelegation({
      mode: 'plan',
      toolCategory: 'memory',
      reason: 'retrieve_user_context',
      initialToolNames: ['SearchMemory', 'StoreContinuityMemory'],
    }, {
      runtimeMode: 'entity-runtime',
      toolLoopModel: 'test-cheap-model',
      runtimeConversationMode: 'agentic',
    }),
  );

  t.true(
    shouldForceInitialResearchDelegation({
      mode: 'plan',
      toolCategory: 'web',
      reason: 'some_new_reason',
      initialToolNames: ['SearchInternet', 'FetchWebPageContentJina'],
    }, {
      runtimeMode: 'entity-runtime',
      toolLoopModel: 'test-cheap-model',
      runtimeConversationMode: 'agentic',
    }),
  );

  t.false(
    shouldForceInitialResearchDelegation({
      mode: 'plan',
      toolCategory: 'workspace',
      reason: 'workspace_task',
      initialToolNames: ['WorkspaceSSH'],
    }, {
      runtimeMode: 'entity-runtime',
      toolLoopModel: 'test-cheap-model',
      runtimeConversationMode: 'agentic',
    }),
  );
});

test('adaptContinuityContextForPromptContext removes named memory-tool guidance from delegate-only prompts', (t) => {
  const context = `## Memory Boundaries
The memories above are your current context window. When referencing past interactions, ONLY reference what is explicitly stated above. If a user asks about something not covered here, use SearchMemory to check before claiming to remember or not remember. Never fabricate, infer, or extrapolate memories beyond what is shown. If you're unsure, say so — or search.`;

  const delegateOnly = adaptContinuityContextForPromptContext(context, { runtimeInitialDelegateOnly: true });
  t.false(delegateOnly.includes('use SearchMemory to check before claiming to remember or not remember.'));
  t.true(delegateOnly.includes('treat it as missing evidence instead of claiming to remember it.'));

  const normal = adaptContinuityContextForPromptContext(context, {});
  t.true(normal.includes('use SearchMemory to check before claiming to remember or not remember.'));
});

test('adaptContinuityContextForPromptContext strips named memory-tool guidance across wrapped spacing', (t) => {
  const context = `## Memory Boundaries
The memories above are your current context window.
If a user asks about something not covered here,
use SearchMemory to check before claiming to remember or not remember.
Never fabricate.`;

  const delegateOnly = adaptContinuityContextForPromptContext(context, { runtimeInitialDelegateOnly: true });

  t.false(delegateOnly.includes('use SearchMemory to check before claiming to remember or not remember.'));
  t.true(delegateOnly.includes('treat it as missing evidence instead of claiming to remember it.'));
});

test.serial('Runtime ignores tool calls that were not exposed on the active model step', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptCalls = 0;
  const resolver = buildResolver({
    _activeToolNames: new Set(['delegateresearch']),
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async () => {
      promptCalls++;
      return 'SYNTHESIZE';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'test undeclared tool guard' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'undeclared-call-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(resolver.toolBudgetUsed, 0);
  t.is(promptCalls, 2);
  t.is(result, 'SYNTHESIZE');
});

test.serial('Runtime delegated research respects maxFanoutWidth and can continue the same plan across waves', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisCallCount = 0;
  const workerCalls = [];
  const executedWorkerTasks = new Set();
  const tasks = [
    'Find friend names',
    'Find family names',
    'Find work details',
    'Find hobby details',
    'Find location details',
  ];

  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-fanout-width',
      authorityEnvelope: {
        maxToolCallsPerRound: 6,
        maxSearchCalls: 12,
        maxFetchCalls: 10,
        maxChildRuns: 8,
        maxFanoutWidth: 3,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        const task = String(args.workerTaskBrief || '');
        if (executedWorkerTasks.has(task)) {
          return 'SYNTHESIZE';
        }
        executedWorkerTasks.add(task);
        workerCalls.push({
          task,
          taskCount: Number(args.workerTaskCount || 0),
        });
        return {
          tool_calls: [
            buildToolCall('SearchTool', { userMessage: task || 'run worker lookup' }, `worker-width-${workerCalls.length}`),
          ],
        };
      }

      synthesisCallCount++;
      if (synthesisCallCount <= 2) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Map the orbit from multiple angles.',
              tasks,
              `delegate-width-${synthesisCallCount}`,
            ),
          ],
        };
      }
      return 'Width-aware final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'Who is in my orbit?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Map the people in the orbit.', ['Find initial evidence'], 'plan-width-1'),
      buildToolCall('SearchTool', { userMessage: 'seed orbit lookup' }, 'search-width-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Width-aware final answer');
  t.deepEqual(
    workerCalls.map(({ task }) => task).sort(),
    tasks.slice().sort(),
    'All delegated tasks should eventually run across multiple waves',
  );
  t.deepEqual(
    [...new Set(workerCalls.map(({ taskCount }) => taskCount))].sort((a, b) => a - b),
    [2, 3],
    'First wave should cap at fanout width, then a second wave should finish the remaining tasks',
  );
  t.is(resolver.entityRuntimeState.childRuns, 5, 'Child run budget should track total workers across both waves');
  t.is(synthesisCallCount, 3);
});

test.serial('Supervisor blocks semantically repeated delegate plans when no novel tasks remain', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisCallCount = 0;
  const workerTasks = [];
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-no-novel-plan',
      authorityEnvelope: {
        maxToolCallsPerRound: 6,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 6,
        maxFanoutWidth: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        if (args.chatHistory?.filter((entry) => entry.role === 'tool' && entry.name === 'SearchTool').length > 1) {
          return 'SYNTHESIZE';
        }
        workerTasks.push(String(args.workerTaskBrief || ''));
        return {
          tool_calls: [
            buildToolCall('SearchTool', { userMessage: String(args.workerTaskBrief || 'run lookup') }, `worker-novel-${workerTasks.length}`),
          ],
        };
      }

      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Identify the people in the orbit.',
              [
                'Search memory for friends and crew names',
                'Search memory for family and relationship references',
              ],
              'delegate-novel-1',
            ),
          ],
        };
      }
      if (synthesisCallCount === 2) {
        return {
          tool_calls: [
            buildDelegateResearchCall(
              'Identify the people in the orbit.',
              [
                'Search memory for specific names of friends and crew',
                'Search memory for relationship references in memory',
              ],
              'delegate-novel-2',
            ),
          ],
        };
      }
      return 'Novelty-guarded final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'Who is in my orbit?' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Find the orbit details.', ['Find enough evidence to answer'], 'plan-novel-1'),
      buildToolCall('SearchTool', { userMessage: 'seed orbit lookup' }, 'search-novel-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Novelty-guarded final answer');
  t.deepEqual(
    workerTasks.sort(),
    [
      'Search memory for family and relationship references',
      'Search memory for friends and crew names',
    ].sort(),
    'Second delegate should be blocked because it only restates already-attempted work',
  );
  t.is(resolver.entityRuntimeState.childRuns, 2);
  t.is(synthesisCallCount, 3, 'The third synthesis call should be the guarded finalize pass');
});

test.serial('Runtime synthesis history is scoped to the current turn and current-run evidence', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let inspectedHistory = null;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    entityRuntimeState: {
      runId: 'run-scoped-synthesis-history',
      authorityEnvelope: {
        maxToolCallsPerRound: 4,
        maxSearchCalls: 10,
        maxFetchCalls: 10,
        maxChildRuns: 4,
        maxFanoutWidth: 2,
      },
      semanticToolCounts: new Map(),
      semanticEvidenceKeys: new Set(),
      noveltyHistory: [],
      searchCalls: 0,
      fetchCalls: 0,
      childRuns: 0,
      evidenceItems: 0,
      stopReason: null,
      currentStage: 'research_batch',
    },
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-primary-model') {
        inspectedHistory = args.chatHistory;
        return 'Scoped synthesis answer';
      }
      return 'SYNTHESIZE';
    },
  });

  const args = {
    chatHistory: [
      { role: 'user', content: 'Tell me something else' },
      { role: 'assistant', content: 'You just got back from a recent Vegas trip with the crew.' },
      { role: 'user', content: 'Who is in my orbit?' },
    ],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    synthesisModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Answer the orbit question.', ['Find enough grounded evidence'], 'plan-scoped-1'),
      buildToolCall('SearchTool', { userMessage: 'search orbit memory' }, 'search-scoped-1'),
    ],
  };

  const result = await toolCallback(args, message, resolver);

  t.is(result, 'Scoped synthesis answer');
  const serializedHistory = JSON.stringify(inspectedHistory);
  t.true(serializedHistory.includes('Who is in my orbit?'));
  t.true(serializedHistory.includes('search results'));
  t.false(serializedHistory.includes('recent Vegas trip with the crew'));
});

// === TEST 14: buildStepInstruction helper ===
test('buildStepInstruction returns todo-list instruction with all items', (t) => {
  const resolver = {
    toolPlan: { goal: 'Test goal', steps: ['Step A', 'Step B', 'Step C'] },
    toolCallRound: 2,
  };

  const instruction = buildStepInstruction(resolver);

  t.true(instruction.includes('TODO — Goal: Test goal'), 'Should contain todo goal');
  t.true(instruction.includes('Step A'), 'Should show item A');
  t.true(instruction.includes('Step B'), 'Should show item B');
  t.true(instruction.includes('Step C'), 'Should show item C');
  t.true(instruction.includes('skip it'), 'Should tell executor to skip satisfied items');
  t.true(instruction.includes('Do NOT retry'), 'Should warn against retrying failed tools');
  t.true(instruction.includes('SYNTHESIZE when all items'), 'Should require all items addressed before SYNTHESIZE');
});

test('buildStepInstruction returns generic hint when no plan', (t) => {
  const resolver = {};

  const instruction = buildStepInstruction(resolver);

  t.true(instruction.includes('SYNTHESIZE'), 'Should mention SYNTHESIZE');
  t.false(instruction.includes('TODO'), 'Should NOT contain TODO keyword');
});

// === TEST 15: Malformed SetGoals-only passes gate but stores no plan ===
test.serial('Malformed SetGoals-only passes gate, executor runs but no plan stored', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisArgs;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') {
        return 'SYNTHESIZE';
      }
      // Synthesis call
      synthesisArgs = JSON.parse(JSON.stringify(args));
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'malformed plan test' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  // Only SetGoals with malformed args — passes gate (name matches) but no plan stored
  const message = {
    tool_calls: [
      {
        id: 'plan-malformed-only',
        type: 'function',
        function: {
          name: 'SetGoals',
          arguments: '{bad json',
        },
      },
    ],
  };

  await toolCallback(args, message, resolver);

  // Gate passes (SetGoals present), but plan is not stored (malformed args)
  t.falsy(resolver.toolPlan, 'No plan should be stored for malformed args');
  // Synthesis should still be called
  t.truthy(synthesisArgs, 'Synthesis should have been called');
});

// === TEST 16: replanCount accumulates on pathwayResolver ===
test.serial('replanCount accumulates on pathwayResolver across supervisor delegations', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let synthesisCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-cheap-model') return 'SYNTHESIZE';
      // First supervisor review: delegate. Second: text-only (done).
      synthesisCallCount++;
      if (synthesisCallCount === 1) {
        return {
          tool_calls: [buildDelegateResearchCall('Replan goal', ['Step 1'], 'delegate-shared-1')],
        };
      }
      return 'Final answer';
    },
  });

  // Pre-set replanCount to verify it accumulates
  resolver.replanCount = 5;

  const args = {
    chatHistory: [{ role: 'user', content: 'shared replan test' }],
    entityTools,
    entityToolsOpenAiFormat,
    runtimeMode: 'entity-runtime',
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  const message = {
    tool_calls: [
      buildSetGoalsCall('Shared replan test', ['Step 1'], 'plan-shared-1'),
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-shared-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  // replanCount should be 6 — accumulated from pre-set value
  t.is(resolver.replanCount, 6, 'replanCount should accumulate across calls');
});

// === TEST 17: passesGate helper ===
test('passesGate returns true when SetGoals is in tool_calls', (t) => {
  t.true(passesGate([buildSetGoalsCall('Goal', ['Step'])]), 'SetGoals only → pass');
  t.true(passesGate([
    buildSetGoalsCall('Goal', ['Step']),
    buildToolCall('SearchTool', { userMessage: 'x' }),
  ]), 'SetGoals + entity tool → pass');
  t.false(passesGate([buildToolCall('SearchTool', { userMessage: 'x' })]), 'Entity tool only → fail');
  t.false(passesGate([]), 'Empty → fail');
  t.false(passesGate(null), 'Null → fail');
});

// === TEST 18: Gate discards tool_calls missing SetGoals and reprompts ===
test.serial('Gate synthesizes a server-side plan when tool_calls omit SetGoals', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = originals.testEntity;
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let gateRetryCount = 0;
  let executorCallCount = 0;
  const resolver = buildResolver({
    toolLoopModel: 'test-cheap-model',
    promptAndParse: async (args) => {
      if (args.modelOverride === 'test-primary-model' && args.stream === false) {
        // Gate retry — return SetGoals + tools on second attempt
        gateRetryCount++;
        return {
          tool_calls: [
            buildSetGoalsCall('Retry plan', ['Step after retry'], 'plan-retry-1'),
            buildToolCall('SearchTool', { userMessage: 'retry search' }, 'call-retry-1'),
          ],
        };
      }
      if (args.modelOverride === 'test-cheap-model') {
        executorCallCount++;
        return 'SYNTHESIZE';
      }
      // Synthesis
      return 'final answer';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'gate test' }],
    entityTools,
    entityToolsOpenAiFormat,
    toolLoopModel: 'test-cheap-model',
    primaryModel: 'test-primary-model',
    configuredReasoningEffort: 'medium',
  };

  // Initial tool_calls WITHOUT SetGoals — server-side planning should fill the gap
  const message = {
    tool_calls: [
      buildToolCall('SearchTool', { userMessage: 'search' }, 'call-gate-1'),
    ],
  };

  await toolCallback(args, message, resolver);

  t.is(gateRetryCount, 0, 'Gate should not burn an extra retry call');
  t.truthy(resolver.toolPlan, 'Plan should be synthesized server-side');
  t.is(resolver.toolPlan.goal, 'gate test', 'Plan should derive from the active request');
  t.true(executorCallCount >= 1, 'Executor should have been called after gate passed');
});
