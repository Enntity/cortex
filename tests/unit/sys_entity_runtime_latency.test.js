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

const setupConfig = (customTools, entityOverrides = {}) => {
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
    ...entityOverrides,
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

test.serial('executeEntityAgentCore routes workspace inventory asks into plan with workspace tools', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
    setbaseavatar: buildToolDefinition('SetBaseAvatar', 'test_tool_avatar', {
      file: { type: 'string' },
      userMessage: { type: 'string' },
    }),
    viewimages: buildToolDefinition('ViewImages', 'test_tool_view_images', {
      files: { type: 'array' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let finalPromptArgs;
  let routePromptArgs;
  const resolver = buildResolver({
    continuityContext: [
      '## Current Expression State',
      'Emotional resonance: moderately electric and direct.',
      '',
      '## My Internal Compass',
      'Current Focus:',
      '- Keep the voice sharp and relational.',
    ].join('\n'),
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = args;
        return JSON.stringify({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'workspace',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'agentic',
          modeAction: 'switch',
          reason: 'workspace_task',
          modeReason: 'workspace_request',
        });
      }
      if (!finalPromptArgs) {
        finalPromptArgs = args;
      }
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
    runAllPrompts: async (args) => {
      plannerCalled = true;
      finalPromptArgs = args;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'workspace answer');
  t.true(plannerCalled);
  t.truthy(routePromptArgs);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(routePromptArgs.tool_choice, { type: 'function', function: { name: 'SelectRoute' } });
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools.map((tool) => tool.function?.name), ['WorkspaceSSH', 'SetGoals']);
  t.is(finalPromptArgs.latencyRouteMode, 'plan');
  t.is(finalPromptArgs.latencyRouteReason, 'workspace_task');
  t.true(finalPromptArgs.promptContext.includeAvailableFiles);
  t.true(finalPromptArgs.promptContext.includeDateTime);
  t.truthy(finalPromptArgs.promptCache?.key);
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'agentic');
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

  t.is(result, 'final-response');
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
    continuityContext: [
      '## Current Expression State',
      'Emotional resonance: moderately electric and direct.',
      '',
      '## My Internal Compass',
      'Current Focus:',
      '- Keep the voice sharp and relational.',
    ].join('\n'),
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
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async (args) => {
      plannerCalled = true;
      finalPromptArgs = args;
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
  t.is(finalPromptArgs.modelOverride, 'oai-gpt54');
  t.is(finalPromptArgs.latencyRouteMode, 'casual_chat');
  t.true(finalPromptArgs.skipMemoryLoad);
  t.is(finalPromptArgs.styleNeutralizationPatch, 'none');
  t.is(finalPromptArgs.styleNeutralizationKey, 'none');
  t.is(finalPromptArgs.styleNeutralizationInstructions, '');
  t.truthy(finalPromptArgs.promptCache?.key);
  t.false(finalPromptArgs.promptCache?.descriptor.includes('anti_tell_v1'));
  t.true(finalPromptArgs.chatHistory.length <= 4);
  t.is(finalPromptArgs.aiName, 'Latency Test Entity');
  t.deepEqual(finalPromptArgs.initialPlanningToolNames, []);
  t.false(finalPromptArgs.promptContext.includeAvailableFiles);
  t.true(finalPromptArgs.promptContext.includeDateTime);
  t.truthy(resolver.pathwayPrompt?.[0]?.messages?.[1]?.content);
  t.false(resolver.pathwayPrompt[0].messages[1].content.includes('## Entity DNA'));
  t.false(resolver.pathwayPrompt[0].messages[1].content.includes('## Narrative Context'));
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## Current Expression State'));
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## My Internal Compass'));
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'chat');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationModeConfidence, 'high');
});

test.serial('executeEntityAgentCore normalizes legacy mixed user-preferences blocks into clearer static prompt sections when memory is disabled', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  }, {
    identity: [
      'I am Jinx. Neon, sharp, and direct.',
      '## User Preferences',
      'Introduction: I was introduced to Jason by Vesper.',
      'User Name: Jason',
      'Personality Traits: blunt, playful, skeptical',
      'Communication Style: fast, crisp, no-fluff',
      'User Interests: retro tech, workspace debugging',
      'Areas of Expertise/Help: code, systems, research',
    ].join('\n\n').replace('\n\n## User Preferences\n\n', '\n\n## User Preferences\n'),
  });
  t.teardown(() => restoreConfig(originals));

  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return JSON.stringify({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          reason: 'casual_chat',
        });
      }
      return 'chatty answer';
    },
  });

  await executeEntityAgentCore({
    args: {
      text: 'Hey you. Miss me?',
      chatHistory: [{ role: 'user', content: 'Hey you. Miss me?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-legacy-identity-normalization',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner call',
    resolver,
  });

  const renderedPrompt = resolver.pathwayPrompt[0].messages
    .map((message) => String(message?.content || ''))
    .join('\n\n');
  t.true(renderedPrompt.includes('## Entity DNA'));
  t.true(renderedPrompt.includes('## Expression Profile'));
  t.true(renderedPrompt.includes('Personality Traits: blunt, playful, skeptical'));
  t.true(renderedPrompt.includes('Communication Style: fast, crisp, no-fluff'));
  t.true(renderedPrompt.includes('## Relationship Context'));
  t.true(renderedPrompt.includes('User Name: Jason'));
  t.true(renderedPrompt.includes('User Interests: retro tech, workspace debugging'));
  t.false(renderedPrompt.includes('## User Preferences'));
});

test.serial('executeEntityAgentCore routes simple current-info turns through the router-owned direct_search fast path', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routePromptArgs;
  let searchPromptArgs;
  let finalPromptArgs;
  let searchCallCount = 0;
  const resolver = buildResolver({
    continuityContext: [
      '## Current Expression State',
      'Emotional resonance: focused and selective.',
      '',
      '## Shared Vocabulary',
      '- "Voltage locked" → High energy and engagement.',
    ].join('\n'),
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = args;
        return JSON.stringify({
          mode: 'direct_search',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'low',
          reason: 'current_info',
        });
      }
      if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'SearchInternet')) {
        searchPromptArgs = args;
        searchCallCount += 1;
        return {
          tool_calls: [
            {
              id: 'search-call-1',
              type: 'function',
              function: {
                name: 'SearchInternet',
                arguments: JSON.stringify({
                  q: 'Elon Musk today',
                  userMessage: 'Checking the latest feed.',
                }),
              },
            },
          ],
        };
      }
      finalPromptArgs = args;
      return 'search fast-path answer';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: "What's Elon talking about today?",
      chatHistory: [{ role: 'user', content: "What's Elon talking about today?" }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-direct-search',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async (args) => {
      plannerCalled = true;
      finalPromptArgs = args;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'search fast-path answer');
  t.false(plannerCalled);
  t.truthy(routePromptArgs);
  t.truthy(searchPromptArgs);
  t.is(searchCallCount, 1);
  t.deepEqual(searchPromptArgs.tools.map((tool) => tool.function?.name), ['SearchInternet']);
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(searchPromptArgs.modelOverride, 'oai-gpt54-mini');
  t.is(finalPromptArgs.modelOverride, 'oai-gpt54');
  t.is(finalPromptArgs.latencyRouteMode, 'current_info');
  t.false(finalPromptArgs.promptContext.includeAvailableFiles);
  t.true(finalPromptArgs.promptContext.includeDateTime);
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'tool' && String(message.content).includes('Elon Musk today')
  )));
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
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'workspace',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'agentic',
          modeAction: 'switch',
          reason: 'workspace_task',
          modeReason: 'workspace_request',
        });
      }
      if (!finalPromptArgs) {
        finalPromptArgs = args;
      }
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
    runAllPrompts: async (args) => {
      plannerCalled = true;
      finalPromptArgs = args;
      return 'unexpected planner call';
    },
    resolver,
  });

  t.is(result, 'workspace answer');
  t.true(plannerCalled);
  t.truthy(routePromptArgs);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(routePromptArgs.tool_choice, { type: 'function', function: { name: 'SelectRoute' } });
  t.is(routePromptArgs.reasoningEffort, 'none');
  t.truthy(finalPromptArgs);
  t.deepEqual(finalPromptArgs.tools.map((tool) => tool.function?.name), ['WorkspaceSSH', 'SetGoals']);
  t.is(finalPromptArgs.latencyRouteMode, 'plan');
  t.is(finalPromptArgs.latencyRouteReason, 'workspace_task');
  t.is(finalPromptArgs.reasoningEffort, 'low');
  t.true(finalPromptArgs.promptContext.includeAvailableFiles);
  t.true(finalPromptArgs.promptContext.includeDateTime);
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'agentic');
});

test.serial('executeEntityAgentCore routes avatar changes into planning with image tools', async (t) => {
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
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'images',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'agentic',
          modeAction: 'switch',
          reason: 'image_task',
          modeReason: 'avatar_change',
        });
      }
      if (!finalPromptArgs) {
        finalPromptArgs = args;
      }
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
  t.true(plannerCalled);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(resolver.args.initialPlanningToolNames, ['SetBaseAvatar']);
  t.is(resolver.args.latencyRouteMode, 'plan');
  t.is(resolver.args.latencyRouteReason, 'image_task');
  t.true(resolver.args.promptContext.includeAvailableFiles);
  t.true(resolver.args.promptContext.includeDateTime);
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'agentic');
});

test.serial('executeEntityAgentCore routes image inspection into planning with image tools', async (t) => {
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
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'images',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'research',
          modeAction: 'switch',
          reason: 'image_task',
          modeReason: 'image_inspection',
        });
      }
      if (!finalPromptArgs) {
        finalPromptArgs = args;
      }
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
  t.true(plannerCalled);
  t.deepEqual(routePromptArgs.tools.map((tool) => tool.function?.name), ['SelectRoute']);
  t.deepEqual(resolver.args.initialPlanningToolNames, ['ViewImages']);
  t.is(resolver.args.latencyRouteMode, 'plan');
  t.is(resolver.args.latencyRouteReason, 'image_task');
  t.true(resolver.args.promptContext.includeAvailableFiles);
  t.true(resolver.args.promptContext.includeDateTime);
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

  t.is(result, 'unexpected direct model call');
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
  t.is(resolver.pathwayResultData?.entityRuntime?.routeMode, 'plan');
  t.is(resolver.pathwayResultData?.entityRuntime?.routeReason, 'current_info');
  t.is(resolver.pathwayResultData?.entityRuntime?.routeSource, 'model');
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
  t.is(resolver.pathwayResultData?.entityRuntime?.routeMode, 'plan');
});

test.serial('executeEntityAgentCore fails safe to plan when a direct reply router response is low confidence', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let plannerArgs;
  let fastChatCalled = false;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return buildRouteToolCallResponse({
          mode: 'direct_reply',
          confidence: 'low',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'chat_mode',
          modeReason: 'unclear_referent',
        });
      }
      fastChatCalled = true;
      return 'unexpected direct reply';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'Who owns that beast?',
      chatHistory: [{ role: 'user', content: 'Who owns that beast?' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: true,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-router-low-confidence',
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
  t.false(fastChatCalled);
  t.truthy(plannerArgs);
  t.is(plannerArgs.latencyRouteMode, 'plan');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'chat');
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationModeConfidence, 'low');
});

test.serial('executeEntityAgentCore runs router first and then direct reply fast path', async (t) => {
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
      t.false(args.stream);
      t.is(args.modelOverride, 'oai-gpt54-mini');
      return 'direct reply answer';
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
      runtimeRunId: 'run-test-direct-reply',
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

  t.is(result, 'direct reply answer');
  t.false(plannerCalled);
  t.is(routeCalls, 1);
  t.is(chatCalls, 1);
});

test.serial('executeEntityAgentCore preserves streaming on direct reply fast path after routing', async (t) => {
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
      t.true(args.stream);
      t.is(args.modelOverride, 'oai-gpt54-mini');
      return 'streamed direct reply answer';
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
      runtimeRunId: 'run-test-stream-direct-reply',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'streamed direct reply answer');
  t.is(routeCalls, 1);
  t.is(chatCalls, 1);
});

test.serial('executeEntityAgentCore does not run direct reply fast path when router selects plan', async (t) => {
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
        return buildRouteToolCallResponse({
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
      return 'unexpected direct reply answer';
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
      runtimeRunId: 'run-test-route-plan',
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
  t.is(chatCalls, 0);
  t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'research');
});

test.serial('executeEntityAgentCore preserves prototype promptAndParse for router and direct reply fast path', async (t) => {
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
      return 'prototype direct reply answer';
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

  t.is(result, 'prototype direct reply answer');
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
