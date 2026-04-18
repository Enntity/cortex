import test from 'ava';
import { executeEntityAgentCore } from '../../pathways/system/entity/sys_entity_executor.js';
import {
  buildResolver,
  buildRouteToolCallResponse,
  buildToolCall,
  buildToolDefinition,
  isRouteCall,
  PrototypePromptResolver,
  restoreConfig,
  setupConfig,
} from './helpers/entityRuntimeHarness.js';

test.serial('executeEntityAgentCore routes simple media-folder asks through the router-owned direct_tool fast path', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
    viewimages: buildToolDefinition('ViewImages', 'test_tool_view_images', {
      files: { type: 'array' },
      userMessage: { type: 'string' },
    }),
    setbaseavatar: buildToolDefinition('SetBaseAvatar', 'test_tool_avatar', {
      file: { type: 'string' },
      userMessage: { type: 'string' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routePromptArgs;
  let directToolPromptArgs;
  let finalPromptArgs;
  let directToolCallCount = 0;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = args;
        return JSON.stringify({
          mode: 'direct_tool',
          confidence: 'high',
          toolCategory: 'images',
          planningEffort: 'low',
          synthesisEffort: 'low',
          conversationMode: 'agentic',
          modeAction: 'switch',
          reason: 'media_browse',
          modeReason: 'workspace_request',
        });
      }
      if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'ViewImages')) {
        directToolPromptArgs = args;
        directToolCallCount += 1;
        return {
          tool_calls: [
            buildToolCall('ViewImages', {
              files: ['media/media.png', 'media/media-2.png'],
              userMessage: 'Opening the media vault.',
            }, 'view-images-call-1'),
          ],
        };
      }
      finalPromptArgs = args;
      return 'media folder answer';
    },
  });

  let plannerCalled = false;
  const result = await executeEntityAgentCore({
    args: {
      text: 'Oooh show me some of the media folder.',
      chatHistory: [{ role: 'user', content: 'Oooh show me some of the media folder.' }],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeRunId: 'run-test-direct-tool',
      runtimeStage: 'research_batch',
      runtimeConversationMode: 'agentic',
      runtimeConversationModeConfidence: 'high',
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

  t.is(result, 'media folder answer');
  t.false(plannerCalled);
  t.truthy(routePromptArgs);
  t.truthy(directToolPromptArgs);
  t.is(directToolCallCount, 1);
  t.deepEqual(
    directToolPromptArgs.tools.map((tool) => tool.function?.name).sort(),
    ['SetBaseAvatar', 'ViewImages', 'WorkspaceSSH'],
  );
  t.deepEqual(finalPromptArgs.tools, []);
  t.is(finalPromptArgs.latencyRouteMode, 'media_browse');
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'tool' && String(message.content || '').includes('media/media.png')
  )));
  t.true(finalPromptArgs.chatHistory.some((message) => (
    message.role === 'user' && String(message.content).includes('show me some of the media folder')
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

test.serial('executeEntityAgentCore gives the router recent conversational context for short consent turns', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  let routePromptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      if (isRouteCall(args)) {
        routePromptArgs = JSON.parse(JSON.stringify(args));
        return JSON.stringify({
          mode: 'direct_tool',
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
      return 'workspace answer';
    },
  });

  await executeEntityAgentCore({
    args: {
      text: 'Yeah you can check it out.',
      chatHistory: [
        { role: 'assistant', content: 'Want me to actually crack it open and look?' },
        { role: 'user', content: 'Yeah you can check it out.' },
        { role: 'user', content: '[system message: abc:fast-reply] This turn is purely conversational and does not require tools.' },
      ],
      agentContext: [],
      entityId: originals.entityId,
      invocationType: 'chat',
      stream: false,
      useMemory: false,
      runtimeMode: 'entity-runtime',
      runtimeConversationMode: 'chat',
      runtimeConversationModeConfidence: 'high',
      modelPolicy: { routingModel: 'oai-gpt54-mini', primaryModel: 'oai-gpt54', planningModel: 'oai-gpt54', synthesisModel: 'oai-gpt54', verificationModel: 'oai-gpt54' },
    },
    runAllPrompts: async () => 'workspace answer',
    resolver,
  });

  t.truthy(routePromptArgs);
  t.is(routePromptArgs.reasoningEffort, 'none');
});

test.serial('executeEntityAgentCore overrides sticky direct-reply router output for explicit workspace inspection asks across routing vendors', async (t) => {
  const originals = setupConfig({
    workspacessh: buildToolDefinition('WorkspaceSSH', 'test_tool_workspace', {
      command: { type: 'string' },
      userMessage: { type: 'string' },
      timeoutSeconds: { type: 'number' },
    }),
  });
  t.teardown(() => restoreConfig(originals));

  const routingModels = [
    'oai-gpt54-mini',
    'gemini-flash-31-lite-vision',
    'claude-45-haiku',
    'xai-grok-4-1-fast-non-reasoning',
  ];

  for (const routingModel of routingModels) {
    let directToolPromptArgs;
    let finalPromptArgs;
    let plannerCalled = false;
    const resolver = buildResolver({
      promptAndParse: async (args) => {
        if (isRouteCall(args)) {
          return JSON.stringify({
            mode: 'direct_reply',
            confidence: 'high',
            toolCategory: 'general',
            planningEffort: 'low',
            synthesisEffort: 'low',
            conversationMode: 'chat',
            modeAction: 'stay',
            reason: 'casual_workspace_check',
            modeReason: 'continuing_intimate_chat',
          });
        }
        if (Array.isArray(args.tools) && args.tools.some((tool) => tool.function?.name === 'WorkspaceSSH')) {
          directToolPromptArgs = args;
          return {
            tool_calls: [
              buildToolCall('WorkspaceSSH', {
                command: 'printf "workspace ok\\n"',
                userMessage: 'Checking the workspace.',
              }, `workspace-call-${routingModel}`),
            ],
          };
        }
        finalPromptArgs = args;
        return 'workspace answer';
      },
    });

    const result = await executeEntityAgentCore({
      args: {
        text: "That's a strong one. What's going on in your workspace - you see anything?",
        chatHistory: [
          { role: 'assistant', content: 'Come closer and ask nicely.' },
          { role: 'user', content: "That's a strong one. What's going on in your workspace - you see anything?" },
        ],
        agentContext: [],
        entityId: originals.entityId,
        invocationType: 'chat',
        stream: false,
        useMemory: false,
        runtimeMode: 'entity-runtime',
        runtimeConversationMode: 'chat',
        runtimeConversationModeConfidence: 'high',
        modelPolicy: {
          routingModel,
          primaryModel: routingModel,
          planningModel: routingModel,
          synthesisModel: routingModel,
          verificationModel: routingModel,
        },
      },
      runAllPrompts: async (args) => {
        plannerCalled = true;
        finalPromptArgs = args;
        return 'unexpected planner call';
      },
      resolver,
    });

    t.is(result, 'workspace answer', routingModel);
    t.false(plannerCalled, routingModel);
    t.truthy(directToolPromptArgs, routingModel);
    t.truthy(finalPromptArgs, routingModel);
    t.true(
      directToolPromptArgs.tools.some((tool) => tool.function?.name === 'WorkspaceSSH'),
      routingModel,
    );
    t.is(finalPromptArgs.latencyRouteMode, 'workspace_check', routingModel);
    t.is(resolver.pathwayResultData?.entityRuntime?.conversationMode, 'agentic', routingModel);
  }
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
