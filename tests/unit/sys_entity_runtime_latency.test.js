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

const buildRouteToolCallResponse = (payload) => ({
  tool_calls: [
    {
      id: 'route-call-1',
      type: 'function',
      function: {
        name: 'SelectRoute',
        arguments: JSON.stringify(payload),
      },
    },
  ],
});

const isRouteCall = (args = {}) => (
  Array.isArray(args.tools)
  && args.tools.some((tool) => tool.function?.name === 'SelectRoute')
);

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
    test_tool_avatar: {
      rootResolver: async (_parent, args) => ({
        result: JSON.stringify({ success: true, file: args.file || '' }),
      }),
    },
    test_tool_view_images: {
      rootResolver: async (_parent, args) => ({
        result: JSON.stringify({ success: true, files: args.files || [] }),
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

class PrototypePromptResolver {
  constructor(overrides = {}) {
    const { promptAndParse: _ignoredPromptAndParse, ...baseResolver } = buildResolver();
    Object.assign(this, baseResolver);
    Object.assign(this, overrides);
  }

  async promptAndParse(args) {
    if (this._promptAndParseImpl) {
      return this._promptAndParseImpl(args);
    }
    return 'final-response';
  }
}

test.serial('executeEntityAgentCore routes workspace inventory through the model router fast path', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let finalPromptArgs;
  let routePromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
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
  t.truthy(routePromptArgs);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(routePromptArgs.tool_choice, { type: 'function', function: { name: 'SelectRoute' } });
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.modelOverride, 'oai-gpt54-mini');
  t.is(finalPromptArgs.latencyRouteMode, 'workspace_inventory');
  t.truthy(finalPromptArgs.promptCache?.key);
  t.true(finalPromptArgs.chatHistory.length <= 9);
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'tool' && String(message.content).includes('/workspace/files')
  )));
});

test.serial('executeEntityAgentCore uses the model router to narrow planning tools and attach an initial prompt cache key', async (t) => {
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
      if (isRouteCall(args)) {
        return JSON.stringify({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'medium',
          reason: 'current_info',
        });
      }
      return 'final-response';
    },
  });

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
  t.is(initialPromptArgs.styleNeutralizationPatch, '');
  t.deepEqual(
    initialPromptArgs.tools.map((tool) => tool.function?.name),
    ['SearchInternet', 'FetchWebPageContentJina', 'CreateChart', 'SetGoals'],
  );
});

test.serial('executeEntityAgentCore neutralizes final user-facing text when the initial planning pass returns a direct answer', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let initialPromptArgs;
  let finalizePromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return JSON.stringify({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'medium',
          reason: 'current_info',
        });
      }
      finalizePromptArgs = args;
      return 'neutralized final answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'Should a startup rewrite a stable Rails app in Rust? Answer pragmatically.',
      chatHistory: [{ role: 'user', content: 'Should a startup rewrite a stable Rails app in Rust? Answer pragmatically.' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: true,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-initial-finalize',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async (args) => {
      initialPromptArgs = args;
      return 'A verbose drafted answer with bullets:\n- First point\n- Second point';
    },
    resolver,
  });

  t.is(result, 'neutralized final answer');
  t.truthy(initialPromptArgs);
  t.is(initialPromptArgs.styleNeutralizationPatch, '');
  t.truthy(finalizePromptArgs);
  t.deepEqual(finalizePromptArgs.tools, []);
  t.false(finalizePromptArgs.stream);
  t.is(finalizePromptArgs.styleNeutralizationPatch, 'anti_tell_v1');
  t.is(finalizePromptArgs.styleNeutralizationKey, 'anti_tell_v1');
  t.true(finalizePromptArgs.styleNeutralizationInstructions.includes('Preserve the entity identity, relationship context, and natural voice.'));
  t.truthy(finalizePromptArgs.promptCache?.key);
  t.true(finalizePromptArgs.promptCache?.descriptor.includes('anti_tell_v1'));
  t.true(finalizePromptArgs.chatHistory.some((message) => (
    message.role === 'assistant' && String(message.content).includes('A verbose drafted answer with bullets')
  )));
});

test.serial('executeEntityAgentCore routes direct conversational replies through the model router fast path', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let finalPromptArgs;
  let routePromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = args;
        return JSON.stringify({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          reason: 'casual_chat',
        });
      }
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
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-direct-reply',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      runtimeOrientationPacket: {
        identity: 'I am Jinx. Neon, sharp, a little dangerous, and very much alive.',
        continuityContext: 'Jason likes fast signal, neon flair, and a real sense of relationship instead of generic assistant talk.',
        currentFocus: [],
      },
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'chatty answer');
  t.false(plannerCalled);
  t.truthy(routePromptArgs);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(routePromptArgs.tool_choice, { type: 'function', function: { name: 'SelectRoute' } });
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.modelOverride, 'oai-gpt54-mini');
  t.is(finalPromptArgs.latencyRouteMode, 'casual_chat');
  t.true(finalPromptArgs.skipMemoryLoad);
  t.is(finalPromptArgs.styleNeutralizationPatch, 'none');
  t.is(finalPromptArgs.styleNeutralizationKey, 'none');
  t.is(finalPromptArgs.styleNeutralizationInstructions, '');
  t.truthy(finalPromptArgs.promptCache?.key);
  t.false(finalPromptArgs.promptCache?.descriptor.includes('anti_tell_v1'));
  t.true(finalPromptArgs.chatHistory.length <= 4);
  t.is(finalPromptArgs.aiName, 'Latency Test Entity');
  t.truthy(resolver.pathwayPrompt?.[0]?.messages?.[1]?.content);
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## Entity DNA'));
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('Neon, sharp, a little dangerous'));
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## Narrative Context'));
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('Jason likes fast signal'));
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'chat');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationModeConfidence, 'high');
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
      if (isRouteCall(args)) {
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
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(routePromptArgs.tool_choice, { type: 'function', function: { name: 'SelectRoute' } });
  t.is(routePromptArgs.reasoningEffort, 'none');
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.latencyRouteMode, 'workspace_inventory');
  t.is(finalPromptArgs.reasoningEffort, 'low');
});

test.serial('executeEntityAgentCore routes avatar changes through the forced router tool call contract', async (t) => {
  const originals = setupConfig({
    setbaseavatar: buildToolDefinition('SetBaseAvatar', 'test_tool_avatar', {
      file: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routePromptArgs;
  let finalPromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = args;
        return buildRouteToolCallResponse({
          mode: 'set_base_avatar',
          confidence: 'high',
          toolCategory: 'images',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'agentic',
          modeAction: 'switch',
          reason: 'set_base_avatar',
          modeReason: 'avatar_change',
        });
      }
      finalPromptArgs = args;
      return 'avatar updated';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'Use jinx_avatar.png as the base avatar.',
      chatHistory: [{ role: 'user', content: 'Use jinx_avatar.png as the base avatar.' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-avatar-route',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'avatar updated');
  t.false(plannerCalled);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.modelOverride, 'oai-gpt54-mini');
  t.is(finalPromptArgs.latencyRouteMode, 'set_base_avatar');
  t.true(finalPromptArgs.chatHistory.length <= 9);
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'tool' && String(message.content).includes('jinx_avatar.png')
  )));
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'agentic');
});

test.serial('executeEntityAgentCore routes image inspection through the forced router tool call contract', async (t) => {
  const originals = setupConfig({
    viewimages: buildToolDefinition('ViewImages', 'test_tool_view_images', {
      files: { type: 'array', items: { type: 'string' } },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routePromptArgs;
  let finalPromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = args;
        return buildRouteToolCallResponse({
          mode: 'view_image',
          confidence: 'high',
          toolCategory: 'images',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'research',
          modeAction: 'switch',
          reason: 'view_image',
          modeReason: 'image_inspection',
        });
      }
      finalPromptArgs = args;
      return 'image analysis';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'Take a close look at moodboard.webp for me.',
      chatHistory: [{ role: 'user', content: 'Take a close look at moodboard.webp for me.' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-view-image-route',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'image analysis');
  t.false(plannerCalled);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.modelOverride, 'oai-gpt54-mini');
  t.is(finalPromptArgs.latencyRouteMode, 'view_image');
  t.true(finalPromptArgs.chatHistory.length <= 9);
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'tool' && String(message.content).includes('moodboard.webp')
  )));
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'research');
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
      if (isRouteCall(args)) {
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

test.serial('executeEntityAgentCore publishes sticky conversation mode changes into runtime result data', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return JSON.stringify({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'medium',
          conversationMode: 'research',
          modeAction: 'switch',
          reason: 'current_info',
          modeReason: 'current_info_request',
        });
      }
      return 'planner answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'What happened in AI today?',
      chatHistory: [{ role: 'user', content: 'What happened in AI today?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-1',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'planner answer',
    resolver,
  });

  t.is(result, 'planner answer');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'research');
  t.is(resolver.pathwayResultData?.entityRuntime?.modeMessage?.mode, 'research');
  t.is(resolver.pathwayResultData?.entityRuntime?.modeMessage?.previousMode, 'chat');
});

test.serial('executeEntityAgentCore fails safe to plan when a high-confidence chat router response is invalid', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let plannerArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return '';
      }
      return 'unexpected direct model call';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'What happened in AI today?',
      chatHistory: [{ role: 'user', content: 'What happened in AI today?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: true,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-router-invalid',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      styleNeutralizationPatch: 'none',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async (args) => {
      plannerArgs = args;
      return 'planner answer';
    },
    resolver,
  });

  t.is(result, 'planner answer');
  t.truthy(plannerArgs);
  t.is(plannerArgs.latencyRouteMode, 'plan');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'chat');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationModeConfidence, 'low');
});

test.serial('executeEntityAgentCore lets speculative chat win for high-confidence chat mode', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routeCalls = 0;
  let chatCalls = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routeCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return JSON.stringify({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'casual_chat',
          modeReason: 'casual_chat',
        });
      }
      chatCalls += 1;
      return 'speculative chat answer';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'heh nice',
      chatHistory: [{ role: 'user', content: 'heh nice' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-spec-chat',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      styleNeutralizationPatch: 'none',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => {
      plannerCalled = true;
      return 'unexpected planner answer';
    },
    resolver,
  });

  t.is(result, 'speculative chat answer');
  t.false(plannerCalled);
  t.is(routeCalls, 1);
  t.is(chatCalls, 1);
});

test.serial('executeEntityAgentCore lets speculative chat win for streamed high-confidence chat mode', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routeCalls = 0;
  let chatCalls = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routeCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return buildRouteToolCallResponse({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'casual_chat',
          modeReason: 'casual_chat',
        });
      }
      chatCalls += 1;
      t.false(args.stream);
      t.is(args.modelOverride, 'oai-gpt54-mini');
      return 'streamed speculative chat answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'lol nice',
      chatHistory: [{ role: 'user', content: 'lol nice' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: true,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-stream-spec-chat',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'streamed speculative chat answer');
  t.is(routeCalls, 1);
  t.is(chatCalls, 1);
});

test.serial('executeEntityAgentCore falls back to normal direct reply when streamed speculative chat returns empty', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routeCalls = 0;
  let chatCalls = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routeCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return buildRouteToolCallResponse({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'casual_chat',
          modeReason: 'casual_chat',
        });
      }
      chatCalls += 1;
      return chatCalls === 1 ? '' : 'fallback direct reply answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'Good!',
      chatHistory: [{ role: 'user', content: 'Good!' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: true,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-empty-spec-chat',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'fallback direct reply answer');
  t.is(routeCalls, 1);
  t.is(chatCalls, 2);
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'chat');
});

test.serial('executeEntityAgentCore avoids returning speculative chat when router vetoes first', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let chatCalls = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return JSON.stringify({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'medium',
          conversationMode: 'research',
          modeAction: 'switch',
          reason: 'current_info',
          modeReason: 'current_info_request',
        });
      }
      chatCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
      return 'speculative chat answer';
    },
  });

  let plannerArgs;
  const result = await executeEntityAgentCore({
    args: {
      text: 'what happened in ai today',
      chatHistory: [{ role: 'user', content: 'what happened in ai today' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-spec-veto',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      styleNeutralizationPatch: 'none',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async (args) => {
      plannerArgs = args;
      return 'planner answer';
    },
    resolver,
  });

  t.is(result, 'planner answer');
  t.truthy(plannerArgs);
  t.is(chatCalls, 1);
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'research');
});

test.serial('executeEntityAgentCore preserves prototype promptAndParse for router and speculative fast chat', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routeCalls = 0;
  let chatCalls = 0;
  const resolver = new PrototypePromptResolver({
    _promptAndParseImpl: async (args) => {
      if (isRouteCall(args)) {
        routeCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return JSON.stringify({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'casual_chat',
          modeReason: 'casual_chat',
        });
      }
      chatCalls += 1;
      return 'prototype speculative answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'nice',
      chatHistory: [{ role: 'user', content: 'nice' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-prototype',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'prototype speculative answer');
  t.is(routeCalls, 1);
  t.is(chatCalls, 1);
});

test.serial('executeEntityAgentCore shadow router uses the router prompt instead of inheriting the parent prompt state', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let sawRouterPrompt = false;
  const resolver = new PrototypePromptResolver({
    prompts: [{ messages: [{ role: 'system', content: 'ORIGINAL_PROMPT_SHOULD_NOT_BE_USED' }] }],
    _promptAndParseImpl: async function (args) {
      if (isRouteCall(args)) {
        const routerSystemPrompt = this.prompts?.[0]?.messages?.[0]?.content || '';
        sawRouterPrompt = routerSystemPrompt.includes('You are a latency router for an agent runtime');
        return buildRouteToolCallResponse({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'casual_chat',
          modeReason: 'casual_chat',
        });
      }
      return 'chat answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'hey',
      chatHistory: [{ role: 'user', content: 'hey' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-shadow-router-prompt',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'chat answer');
  t.true(sawRouterPrompt);
});
