import test from 'ava';
import sysEntityRuntime from '../../pathways/system/entity/sys_entity_runtime.js';
import { executeEntityAgentCore } from '../../pathways/system/entity/sys_entity_executor.js';
import { config } from '../../config.js';
import { getEntityStore } from '../../lib/MongoEntityStore.js';

const buildToolDefinition = (name, pathwayName, properties = {}) => ({
  pathwayName,
  definition: {
    type: 'function',
    icon: '🧪',
    function: {
      name,
      description: `Test tool for ${name}`,
      parameters: {
        type: 'object',
        properties,
        required: [],
      },
    },
  },
});

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-latency-test',
  rootRequestId: 'root-req-latency-test',
  pathway: sysEntityRuntime,
  modelName: 'oai-gpt54',
  pathwayResultData: {},
  modelExecutor: {
    plugin: {
      truncateMessagesToTargetLength: (messages) => messages,
      getModelMaxPromptTokens: () => 10_000_000,
    },
  },
  promptAndParse: async () => 'final-response',
  ...overrides,
});

const setupConfig = (customTools) => {
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};
  const entityId = 'entity-test-latency';

  const pathways = {
    ...originalPathways,
    sys_generator_error: {
      rootResolver: async (_parent, args) => ({
        result: `ERROR_RESPONSE: ${args.text}`,
      }),
    },
    test_tool_workspace: {
      rootResolver: async (_parent, args) => ({
        result: JSON.stringify({ success: true, command: args.command }),
      }),
    },
    test_tool_search: {
      rootResolver: async (_parent, args) => ({
        result: JSON.stringify({ success: true, query: args.q || args.text || '' }),
      }),
    },
    test_tool_fetch: {
      rootResolver: async (_parent, args) => ({
        result: JSON.stringify({ success: true, url: args.url || '' }),
      }),
    },
    test_tool_chart: {
      rootResolver: async () => ({
        result: JSON.stringify({ success: true, chart: true }),
      }),
    },
  };

  const testEntity = {
    id: entityId,
    name: 'Latency Test Entity',
    isDefault: true,
    tools: Object.keys(customTools),
    customTools,
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

test.serial('executeEntityAgentCore bypasses the planner for direct workspace inventory routes', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let finalPromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      finalPromptArgs = args;
      return 'workspace answer';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'What other files do you see in the workspace?',
      chatHistory: [{ role: 'user', content: 'What other files do you see in the workspace?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'workspace answer');
  t.false(plannerCalled);
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.latencyRouteMode, 'workspace_inventory');
  t.truthy(finalPromptArgs.promptCache?.key);
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'tool' && String(message.content).includes('/workspace/files')
  )));
});

test.serial('executeEntityAgentCore shortlists planning tools and attaches an initial prompt cache key', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    fetchwebpagecontentjina: buildToolDefinition('FetchWebPageContentJina', 'test_tool_fetch', {
      url: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    createchart: buildToolDefinition('CreateChart', 'test_tool_chart', {
      detailedInstructions: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let initialPromptArgs;
  const resolver = buildResolver();

  const result = await executeEntityAgentCore({
    args: {
      text: 'Search the latest AI news and make a chart of the main themes.',
      chatHistory: [{ role: 'user', content: 'Search the latest AI news and make a chart of the main themes.' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
    },
    runAllPrompts: async (args) => {
      initialPromptArgs = args;
      return 'planner answer';
    },
    resolver,
  });

  t.is(result, 'planner answer');
  t.truthy(initialPromptArgs);
  t.truthy(initialPromptArgs.promptCache?.key);
  t.deepEqual(
    initialPromptArgs.tools.map((tool) => tool.function?.name),
    ['SearchInternet', 'FetchWebPageContentJina', 'CreateChart', 'SetGoals'],
  );
});

test.serial('executeEntityAgentCore bypasses the planner for direct conversational replies', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let finalPromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      finalPromptArgs = args;
      return 'chatty answer';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'Hey you. Miss me?',
      chatHistory: [{ role: 'user', content: 'Hey you. Miss me?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'chatty answer');
  t.false(plannerCalled);
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.latencyRouteMode, 'casual_chat');
  t.truthy(finalPromptArgs.promptCache?.key);
});

test.serial('executeEntityAgentCore uses the model router for ambiguous workspace inspection turns', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routePromptArgs;
  let finalPromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (args.modelOverride === 'oai-gpt54-nano') {
        routePromptArgs = args;
        return JSON.stringify({
          mode: 'workspace_inventory',
          confidence: 'high',
          toolCategory: 'workspace',
          planningEffort: 'low',
          synthesisEffort: 'low',
          reason: 'workspace_inventory',
        });
      }
      finalPromptArgs = args;
      return 'workspace answer';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'What do you see in your workspace?',
      chatHistory: [{ role: 'user', content: 'What do you see in your workspace?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'workspace answer');
  t.false(plannerCalled);
  t.truthy(routePromptArgs);
  t.deepEqual(routePromptArgs.tools, []);
  t.is(routePromptArgs.reasoningEffort, 'low');
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.latencyRouteMode, 'workspace_inventory');
  t.is(finalPromptArgs.reasoningEffort, 'low');
});

test.serial('executeEntityAgentCore lets the model router choose planning effort and tool family', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    fetchwebpagecontentjina: buildToolDefinition('FetchWebPageContentJina', 'test_tool_fetch', {
      url: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    createchart: buildToolDefinition('CreateChart', 'test_tool_chart', {
      detailedInstructions: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let initialPromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (args.modelOverride === 'oai-gpt54-nano') {
        return JSON.stringify({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'medium',
          reason: 'current_info',
        });
      }
      return 'unexpected direct model call';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'Give me the latest AI headlines in a quick chart.',
      chatHistory: [{ role: 'user', content: 'Give me the latest AI headlines in a quick chart.' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
    },
    runAllPrompts: async (args) => {
      initialPromptArgs = args;
      return 'planner answer';
    },
    resolver,
  });

  t.is(result, 'planner answer');
  t.truthy(initialPromptArgs);
  t.is(initialPromptArgs.reasoningEffort, 'low');
  t.deepEqual(
    initialPromptArgs.tools.map((tool) => tool.function?.name),
    ['SearchInternet', 'FetchWebPageContentJina', 'CreateChart', 'SetGoals'],
  );
});
