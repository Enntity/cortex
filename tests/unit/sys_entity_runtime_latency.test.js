import test from 'ava';
import { executeEntityAgentCore, prepareEntityLatencyCore } from '../../pathways/system/entity/sys_entity_executor.js';
import {
  buildPredictNextTurnsCall,
  buildResolver,
  buildRouteToolCallResponse,
  buildSetGoalsCall,
  buildToolCall,
  buildToolDefinition,
  isRouteCall,
  restoreConfig,
  setupConfig,
  stubContinuityService,
} from './helpers/entityRuntimeHarness.js';

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
    message.role === 'tool' && String(message.content || '').includes('"query":"Elon Musk today"')
  )));
  t.true(finalPromptArgs.chatHistory.some((message) => (
    String(message.content || '').includes('fast-search-finalize')
  )));
});

test.serial('executeEntityAgentCore preloads continuity before building a direct-reply prompt', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let preloadCount = 0;
  let finalPromptArgs;
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      preloadCount += 1;
      t.is(args.entityId, originals.entityId);
      resolver.continuityContext = [
        '## Current Expression State',
        'Voltage locked.',
        '',
        '## My Internal Compass',
        'Current Focus:',
        '- Stay relational.',
      ].join('\n');
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
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
      finalPromptArgs = args;
      return 'preloaded continuity answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'hi there',
      chatHistory: [{ role: 'user', content: 'hi there' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-preload-direct-reply',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'preloaded continuity answer');
  t.is(preloadCount, 1);
  t.true(finalPromptArgs.skipMemoryLoad);
  t.is(finalPromptArgs.runtimeStage, 'direct_reply');
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## Current Expression State'));
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## My Internal Compass'));
});

test.serial('executeEntityAgentCore preloads continuity before the first planning call', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let preloadCount = 0;
  let initialPromptArgs;
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      preloadCount += 1;
      resolver.continuityContext = [
        '## Shared Vocabulary',
        '- Voltage locked.',
      ].join('\n');
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
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
      return 'planner final answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'check the current AI news',
      chatHistory: [{ role: 'user', content: 'check the current AI news' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-preload-plan',
      runtimeStage: 'plan',
      runtimeConversationMode: 'research',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async (args) => {
      initialPromptArgs = args;
      return 'planner draft answer';
    },
    resolver,
  });

  t.is(result, 'planner final answer');
  t.is(preloadCount, 1);
  t.truthy(initialPromptArgs);
  t.true(initialPromptArgs.skipMemoryLoad);
  t.true(resolver.pathwayPrompt[0].messages[1].content.includes('## Shared Vocabulary'));
});

test.serial('executeEntityAgentCore does not run initial_finalize after a delegated agentic handoff', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let sawInitialFinalize = false;
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
          modeReason: 'current_info',
        });
      }

      if (Array.isArray(args.chatHistory) && args.chatHistory.some((entry) => (
        entry?.role === 'user'
        && typeof entry.content === 'string'
        && entry.content.includes(':initial-finalize]')
      ))) {
        sawInitialFinalize = true;
      }

      if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'DelegateResearch')) {
        return 'Grounded final answer';
      }

      return 'unexpected follow-up';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'check current AI news',
      chatHistory: [{ role: 'user', content: 'check current AI news' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-no-post-agentic-rewrite',
      runtimeStage: 'plan',
      runtimeConversationMode: 'research',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54', researchModel: 'oai-gpt54-mini' },
    },
    runAllPrompts: async () => ({
      tool_calls: [
        buildSetGoalsCall('Check current AI news.', ['Find the latest AI news items.'], 'plan-search-1'),
        buildToolCall('SearchInternet', { q: 'current AI news', userMessage: 'checking now' }, 'search-call-1'),
      ],
    }),
    resolver,
  });

  t.is(result, 'Grounded final answer');
  t.false(sawInitialFinalize);
  t.false(resolver._executionState?.executedTools);
  t.true(resolver._executionState?.enteredSupervisor);
  t.is(resolver._executionState?.answerMode, 'agentic_synthesis');
});

test.serial('executeEntityAgentCore uses a leaner direct-reply path for casual reactions', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let finalPromptArgs;
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      resolver.continuityContext = '## Current Expression State\nTerse and amused.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return buildRouteToolCallResponse({
          mode: 'direct_reply',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'casual_reaction',
          modeReason: 'casual_reaction',
        });
      }
      finalPromptArgs = args;
      return 'nice.';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'nice',
      chatHistory: [
        { role: 'user', content: 'that worked' },
        { role: 'assistant', content: 'good' },
        { role: 'user', content: 'nice' },
      ],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-casual-reaction',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'nice.');
  t.is(finalPromptArgs.reasoningEffort, 'low');
  t.is(finalPromptArgs.runtimeStage, 'direct_reply');
  t.true(finalPromptArgs.chatHistory.length <= 4);
});

test.serial('executeEntityAgentCore records streamed direct-reply text into continuity memory', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  const continuitySpy = stubContinuityService();
  t.teardown(() => continuitySpy.restore());

  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      resolver.continuityContext = '## Current Expression State\nPresent.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
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
      resolver.streamedContent = 'streamed final answer';
      return 'fallback final answer';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'say hi',
      chatHistory: [{ role: 'user', content: 'say hi' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-streamed-memory-direct',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'unexpected planner answer',
    resolver,
  });

  t.is(result, 'fallback final answer');
  const assistantRecord = continuitySpy.calls.find((entry) => (
    entry.type === 'recordTurn'
    && entry.args[2]?.role === 'assistant'
  ));
  t.truthy(assistantRecord);
  t.is(assistantRecord.args[2].content, 'streamed final answer');
});

test.serial('executeEntityAgentCore records the final fallback response when the planner returns empty text', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  const continuitySpy = stubContinuityService();
  t.teardown(() => continuitySpy.restore());

  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      resolver.continuityContext = '## Current Expression State\nPresent.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        return buildRouteToolCallResponse({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'general',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'chat',
          modeAction: 'stay',
          reason: 'needs_answer',
          modeReason: 'needs_answer',
        });
      }
      return 'unexpected follow-up';
    },
  });

  const result = await executeEntityAgentCore({
    args: {
      text: 'say something useful',
      chatHistory: [{ role: 'user', content: 'say something useful' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-empty-planner-fallback',
      runtimeStage: 'plan',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
      authorityEnvelope: { maxToolBudget: 100, maxResearchRounds: 4, maxSearchCalls: 4, maxFetchCalls: 4, maxChildRuns: 1, maxToolCallsPerRound: 4, maxRepeatedSearches: 2, noveltyWindow: 2, minNewEvidencePerWindow: 1, maxEvidenceItems: 10, maxWallClockMs: 60000 },
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => '   ',
    resolver,
  });

  t.true(String(result).startsWith('ERROR_RESPONSE:'));
  const assistantRecord = continuitySpy.calls.find((entry) => (
    entry.type === 'recordTurn'
    && entry.args[2]?.role === 'assistant'
  ));
  t.truthy(assistantRecord);
  t.is(assistantRecord.args[2].content, result);
});

test.serial('prepareEntityLatencyCore warms continuity and fast chat prompt cache without executing tools', async (t) => {
  const originals = setupConfig({});
  t.teardown(() => restoreConfig(originals));

  const promptCalls = [];
  let memoryLoadCount = 0;
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      memoryLoadCount += 1;
      resolver.continuityContext = '## Current Expression State\nReady.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      promptCalls.push(args);
      if (isRouteCall(args)) {
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
      return 'warm';
    },
  });

  const preparation = await prepareEntityLatencyCore({
    args: {
      requestedOutput: 'latency_prepare',
      text: 'hey there',
      chatHistory: [{ role: 'user', content: 'hey there' }],
      agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
    },
    resolver,
  });

  t.true(preparation.prepared);
  t.is(preparation.routeMode, 'direct_reply');
  t.deepEqual(preparation.warmedPurposes, ['fast_chat']);
  t.true(memoryLoadCount >= 1);
  t.true(promptCalls.some((args) => isRouteCall(args)));
  const warmCall = promptCalls.find((args) => !isRouteCall(args));
  t.truthy(warmCall);
  t.is(warmCall.stream, false);
  t.is(warmCall.max_output_tokens, 16);
  t.is(warmCall.max_tokens, 16);
  t.deepEqual(warmCall.tools, []);
  t.truthy(warmCall.promptCache?.key);
  t.is(preparation.artifacts.preparedText, 'hey there');
  t.is(preparation.artifacts.route.mode, 'direct_reply');
  t.true(String(preparation.artifacts.continuityContext || '').includes('Ready.'));
});

test.serial('prepareEntityLatencyCore predicts likely next turns for view warmups and warms each branch', async (t) => {
  const originals = setupConfig({});
  t.teardown(() => restoreConfig(originals));

  const promptCalls = [];
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      resolver.continuityContext = '## Current Expression State\nReady.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      promptCalls.push(args);
      if (isRouteCall(args)) {
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
      if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'PredictNextTurns')) {
        return {
          tool_calls: [
            buildPredictNextTurnsCall([
              'show me more',
              'what else do you know about Kyoto?',
            ]),
          ],
        };
      }
      return 'warm';
    },
  });

  const preparation = await prepareEntityLatencyCore({
    args: {
      requestedOutput: 'latency_prepare',
      text: '',
      trigger: 'view',
      chatHistory: [
        { role: 'user', content: 'Tell me about Kyoto.' },
        { role: 'assistant', content: 'Kyoto is calm, old, and beautiful.' },
      ],
      agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
      entityId: originals.entityId,
      invocationType: 'anticipate',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
    },
    resolver,
  });

  t.true(preparation.prepared);
  t.is(preparation.routeMode, 'direct_reply');
  t.deepEqual(preparation.warmedPurposes, ['fast_chat']);
  t.deepEqual(
    preparation.predictedBranches.map((branch) => branch.text),
    ['show me more', 'what else do you know about Kyoto?'],
  );
  t.true(preparation.predictedBranches.every((branch) => branch.routeMode === 'direct_reply'));
  t.true(preparation.predictedBranches.every((branch) => (
    Array.isArray(branch.warmedPurposes) && branch.warmedPurposes[0] === 'fast_chat'
  )));
  t.true(preparation.predictedBranches.every((branch) => branch.artifacts?.route?.mode === 'direct_reply'));
  t.is(
    promptCalls.filter((args) => Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'PredictNextTurns')).length,
    1,
  );
  t.is(
    promptCalls.find((args) => Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'PredictNextTurns'))?.reasoningEffort,
    'none',
  );
  t.is(promptCalls.filter((args) => isRouteCall(args)).length, 3);
});

test.serial('prepareEntityLatencyCore strips tool transcript from fast search warmups across providers and ignores warm failures', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  }, {
    modelPolicy: {
      primaryModel: 'gemini-flash-31-lite-vision',
      planningModel: 'gemini-flash-31-lite-vision',
      researchModel: 'gemini-flash-31-lite-vision',
      synthesisModel: 'gemini-flash-31-lite-vision',
      routingModel: 'gemini-flash-31-lite-vision',
    },
  });
  t.teardown(() => restoreConfig(originals));

  for (const modelName of ['gemini-flash-31-lite-vision', 'claude-45-haiku']) {
    const fastSearchCalls = [];
    const resolver = buildResolver({
      ensureMemoryLoaded: async (args) => {
        resolver.continuityContext = '## Current Expression State\nReady.';
        resolver.continuityEntityId = originals.entityId;
        resolver.continuityUserId = args.contextId;
        resolver._continuityPreloaded = true;
        return { enabled: true, attempted: true, loaded: true, source: 'test' };
      },
      promptAndParse: async (args) => {
        if (isRouteCall(args)) {
          return buildRouteToolCallResponse({
            mode: 'direct_search',
            confidence: 'high',
            toolCategory: 'web',
            planningEffort: 'low',
            synthesisEffort: 'low',
            conversationMode: 'research',
            modeAction: 'stay',
            reason: 'fact_lookup',
            modeReason: 'fact_lookup',
          });
        }
        if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'PredictNextTurns')) {
          return {
            tool_calls: [
              buildPredictNextTurnsCall([
                'what is the quarter mile time exactly?',
              ]),
            ],
          };
        }
        if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'SearchInternet')) {
          fastSearchCalls.push(args);
          throw new Error('synthetic warm failure');
        }
        return 'warm';
      },
    });

    const preparation = await prepareEntityLatencyCore({
      args: {
        requestedOutput: 'latency_prepare',
        text: '',
        trigger: 'post_reply',
        chatHistory: [
          { role: 'user', content: 'What is the quarter mile on a new Model Y Performance?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [buildToolCall('SearchInternet', { q: 'Model Y Performance quarter mile' }, 'tool-call-search-1')],
          },
          { role: 'tool', content: '{"result":"stale tool output"}' },
          { role: 'user', content: '[Prior tool result: SearchInternet]\n{"result":"old"}' },
          { role: 'assistant', content: 'Looks like my last attempt glitched. Ask again and I will rerun it clean.' },
        ],
        agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
        entityId: originals.entityId,
        invocationType: 'anticipate',
        stream: false,
        useMemory: true,
        runtimeMode: 'entity-runtime',
        runtimeConversationMode: 'research',
        runtimeConversationModeConfidence: 'high',
        modelPolicy: {
          primaryModel: modelName,
          planningModel: modelName,
          researchModel: modelName,
          synthesisModel: modelName,
          routingModel: modelName,
        },
      },
      resolver,
    });

    t.true(preparation.prepared, modelName);
    t.deepEqual(preparation.warmedPurposes, [], modelName);
    t.true(fastSearchCalls.length >= 1, modelName);
    for (const call of fastSearchCalls) {
      t.false(call.chatHistory.some((message) => message.role === 'tool'), modelName);
      t.false(call.chatHistory.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0), modelName);
      t.false(call.chatHistory.some((message) => String(message.content || '').startsWith('[Prior tool result:')), modelName);
    }
  }
});

test.serial('prepareEntityLatencyCore skips heavy planner speculation for plan routes', async (t) => {
  const originals = setupConfig({
    searchmemory: buildToolDefinition('SearchMemory', 'test_tool_memory_search', {
      query: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  const promptCalls = [];
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      resolver.continuityContext = '## Current Expression State\nReady.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      promptCalls.push(args);
      if (isRouteCall(args)) {
        return buildRouteToolCallResponse({
          mode: 'plan',
          confidence: 'high',
          toolCategory: 'memory',
          planningEffort: 'low',
          synthesisEffort: 'medium',
          conversationMode: 'agentic',
          modeAction: 'switch',
          reason: 'memory_lookup_request',
          modeReason: 'memory_lookup_request',
        });
      }
      return 'unexpected warm planner call';
    },
  });

  const preparation = await prepareEntityLatencyCore({
    args: {
      requestedOutput: 'latency_prepare',
      text: 'What do you know about me?',
      chatHistory: [{ role: 'user', content: 'What do you know about me?' }],
      agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'low',
    },
    resolver,
  });

  t.true(preparation.prepared);
  t.is(preparation.routeMode, 'plan');
  t.true(preparation.speculationSkipped);
  t.deepEqual(preparation.warmedPurposes, []);
  t.true(promptCalls.some((args) => isRouteCall(args)));
  const nonRouteCalls = promptCalls.filter((args) => !isRouteCall(args));
  t.true(nonRouteCalls.length <= 1);
  if (nonRouteCalls.length === 1) {
    t.true(Array.isArray(nonRouteCalls[0].tools));
    t.true(nonRouteCalls[0].tools.every((tool) => tool.function?.name === 'SearchMemory'));
  }
});

test.serial('prepareEntityLatencyCore stores speculative read-only research results as reusable evidence', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  const promptCalls = [];
  const resolver = buildResolver({
    ensureMemoryLoaded: async (args) => {
      resolver.continuityContext = '## Current Expression State\nReady.';
      resolver.continuityEntityId = originals.entityId;
      resolver.continuityUserId = args.contextId;
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      promptCalls.push(args);
      if (isRouteCall(args)) {
        return buildRouteToolCallResponse({
          mode: 'direct_search',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'research',
          modeAction: 'stay',
          reason: 'fact_lookup',
          modeReason: 'fact_lookup',
        });
      }
      if (
        Array.isArray(args.tools)
        && args.tools.some((tool) => tool.function?.name === 'SearchInternet')
        && Array.isArray(args.chatHistory)
        && args.chatHistory.some((message) => String(message.content || '').includes('[system message: speculative-research]'))
      ) {
        return {
          tool_calls: [
            buildToolCall('SearchInternet', { q: 'quarter mile record runs', userMessage: 'Checking latest record runs.' }, 'spec-search-1'),
          ],
        };
      }
      return 'warm';
    },
  });

  const preparation = await prepareEntityLatencyCore({
    args: {
      requestedOutput: 'latency_prepare',
      text: 'look for record runs',
      chatHistory: [{ role: 'user', content: 'look for record runs' }],
      agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      runtimeMode: 'entity-runtime',
      runtimeConversationMode: 'research',
      runtimeConversationModeConfidence: 'high',
    },
    resolver,
  });

  t.true(preparation.prepared);
  t.is(preparation.routeMode, 'direct_search');
  t.true(Array.isArray(preparation.artifacts.speculativeEvidence));
  t.is(preparation.artifacts.speculativeEvidence.length, 1);
  t.is(preparation.artifacts.speculativeEvidence[0].toolName, 'SearchInternet');
  t.true(preparation.artifacts.speculativeEvidence[0].content.includes('quarter mile record runs'));
});

test.serial('executeEntityAgentCore reuses speculative preparation artifacts for matched predicted branches', async (t) => {
  const originals = setupConfig({});
  t.teardown(() => restoreConfig(originals));

  let memoryLoadCount = 0;
  let routeCallCount = 0;
  let finalCallArgs = null;
  const resolver = buildResolver({
    ensureMemoryLoaded: async () => {
      memoryLoadCount += 1;
      resolver.continuityContext = 'should not be loaded';
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routeCallCount += 1;
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
      finalCallArgs = args;
      return 'reused speculative reply';
    },
  });

  const speculativePreparation = {
    prepared: true,
    preparedText: '',
    predictedBranches: [
      {
        text: 'show me more',
        artifacts: {
          preparedText: 'show me more',
          preparedTextKey: 'show me more',
          route: {
            mode: 'direct_reply',
            reason: 'casual_chat',
            routeSource: 'speculative_prepare',
            toolCategory: 'general',
            toolName: '',
            initialToolNames: [],
            planningReasoningEffort: 'low',
            synthesisReasoningEffort: 'low',
          },
          continuityContext: '## Current Expression State\nSpeculative continuity.',
          continuityLoaded: true,
          conversationMode: 'chat',
          conversationModeConfidence: 'high',
        },
      },
    ],
  };

  const result = await executeEntityAgentCore({
    args: {
      text: 'show me more',
      chatHistory: [
        { role: 'user', content: 'Tell me about Kyoto.' },
        { role: 'assistant', content: 'Kyoto is calm, old, and beautiful.' },
        { role: 'user', content: 'show me more' },
      ],
      agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      speculativePreparation: JSON.stringify(speculativePreparation),
    },
    runAllPrompts: async () => 'unexpected planner call',
    resolver,
  });

  t.is(result, 'reused speculative reply');
  t.is(routeCallCount, 0);
  t.is(memoryLoadCount, 0);
  t.truthy(finalCallArgs);
  t.true(Array.isArray(finalCallArgs.chatHistory));
  t.true(String(resolver.continuityContext || '').includes('Speculative continuity.'));
});

test.serial('executeEntityAgentCore injects speculative research evidence into the first live fast-search call', async (t) => {
  const originals = setupConfig({
    searchinternet: buildToolDefinition('SearchInternet', 'test_tool_search', {
      q: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routeCallCount = 0;
  let memoryLoadCount = 0;
  let fastSearchCall = null;
  const resolver = buildResolver({
    ensureMemoryLoaded: async () => {
      memoryLoadCount += 1;
      resolver.continuityContext = 'should not be loaded';
      resolver._continuityPreloaded = true;
      return { enabled: true, attempted: true, loaded: true, source: 'test' };
    },
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routeCallCount += 1;
        return buildRouteToolCallResponse({
          mode: 'direct_search',
          confidence: 'high',
          toolCategory: 'web',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'research',
          modeAction: 'stay',
          reason: 'fact_lookup',
          modeReason: 'fact_lookup',
        });
      }
      if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'SearchInternet')) {
        fastSearchCall = args;
        return 'The cached research already shows the current record runs.';
      }
      return 'The cached research already shows the current record runs.';
    },
  });

  const speculativePreparation = {
    prepared: true,
    predictedBranches: [
      {
        text: 'look in the forums for record runs',
        artifacts: {
          preparedText: 'look in the forums for record runs',
          preparedTextKey: 'look in the forums for record runs',
          route: {
            mode: 'direct_search',
            reason: 'fact_lookup',
            routeSource: 'speculative_prepare',
            toolCategory: 'web',
            toolName: '',
            initialToolNames: ['SearchInternet'],
            planningReasoningEffort: 'low',
            synthesisReasoningEffort: 'low',
          },
          continuityContext: '## Current Expression State\nSpeculative continuity.',
          continuityLoaded: true,
          conversationMode: 'research',
          conversationModeConfidence: 'high',
          speculativeEvidence: [
            {
              toolName: 'SearchInternet',
              content: '{"success":true,"query":"quarter mile record runs","message":"Found forum results."}',
            },
          ],
        },
      },
    ],
  };

  const result = await executeEntityAgentCore({
    args: {
      text: 'look in the forums for record runs',
      chatHistory: [
        { role: 'user', content: 'What is the record quarter mile?' },
        { role: 'assistant', content: 'I can check the forums if you want.' },
        { role: 'user', content: 'look in the forums for record runs' },
      ],
      agentContext: [{ contextId: 'user-ctx', contextKey: '', default: true }],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: true,
      speculativePreparation: JSON.stringify(speculativePreparation),
    },
    runAllPrompts: async () => 'unexpected planner call',
    resolver,
  });

  t.is(result, 'The cached research already shows the current record runs.');
  t.is(routeCallCount, 0);
  t.is(memoryLoadCount, 0);
  t.truthy(fastSearchCall);
  t.true(fastSearchCall.chatHistory.some((message) => (
    String(message.content || '').includes('[Prior tool result: SearchInternet]')
  )));
});
