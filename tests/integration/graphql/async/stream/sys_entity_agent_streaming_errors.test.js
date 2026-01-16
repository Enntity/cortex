import test from 'ava';
import serverFactory from '../../../../../index.js';
import { createWsClient, ensureWsConnection, collectSubscriptionEvents, validateProgressMessage } from '../../../../helpers/subscriptions.js';
import { config } from '../../../../../config.js';
import { PathwayResolver } from '../../../../../server/pathwayResolver.js';

const buildToolDefinition = (name, pathwayName) => ({
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

const setupConfig = () => {
  const originalGet = config.get.bind(config);
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    errorjson: buildToolDefinition('ErrorJson', 'test_tool_error_json'),
  };

  const entityId = 'entity-test-stream-errors';
  const entityConfig = {
    [entityId]: {
      id: entityId,
      isDefault: true,
      tools: Object.keys(tools),
      customTools: tools,
    },
  };

  const pathways = {
    ...originalPathways,
    sys_generator_error: {
      rootResolver: async (_parent, args) => ({
        result: `ERROR_RESPONSE: ${args.text}`,
      }),
    },
    test_tool_error_json: {
      rootResolver: async () => ({
        result: JSON.stringify({ error: true, message: '400 Bad Request' }),
      }),
    },
  };

  config.load({
    pathways,
    entityTools: {},
  });

  config.get = (key) => {
    if (key === 'entityConfig') {
      return entityConfig;
    }
    return originalGet(key);
  };

  return {
    entityId,
    originalGet,
    originalPathways,
    originalEntityTools,
  };
};

const restoreConfig = (originals) => {
  config.load({
    pathways: originals.originalPathways,
    entityTools: originals.originalEntityTools,
  });
  config.get = originals.originalGet;
};

let testServer;
let wsClient;
let originalPromptAndParse;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  wsClient = createWsClient();
  await ensureWsConnection(wsClient);

  originalPromptAndParse = PathwayResolver.prototype.promptAndParse;
});

test.after.always('cleanup', async () => {
  PathwayResolver.prototype.promptAndParse = originalPromptAndParse;
  if (wsClient) wsClient.dispose();
  if (testServer) await testServer.stop();
});

test.serial('sys_entity_agent streaming completes when model crashes after tools', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  PathwayResolver.prototype.promptAndParse = async function promptAndParseStub(args) {
    if (args?.title === 'test-crash-after-tools') {
      const hasToolResult = (args.chatHistory || []).some((entry) => entry.role === 'tool');
      if (!hasToolResult) {
        return { tool_calls: [buildToolCall('ErrorJson')] };
      }
      throw new Error('Model crashed after tool calls');
    }
    return originalPromptAndParse.call(this, args);
  };

  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!, $chatHistory: [MultiMessage]!, $stream: Boolean!, $entityId: String!, $title: String) {
        sys_entity_agent(text: $text, chatHistory: $chatHistory, stream: $stream, entityId: $entityId, title: $title) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Trigger tool flow then crash',
      chatHistory: [{ role: 'user', content: ['Trigger tool flow then crash'] }],
      stream: true,
      entityId: originals.entityId,
      title: 'test-crash-after-tools',
    },
  });

  const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
  t.truthy(requestId);

  const events = await collectSubscriptionEvents(wsClient, {
    query: `
      subscription OnRequestProgress($requestId: String!) {
        requestProgress(requestIds: [$requestId]) {
          requestId
          progress
          data
          info
          error
        }
      }
    `,
    variables: { requestId },
  }, 30000, { requireCompletion: true, minEvents: 1 });

  t.true(events.length > 0);
  const completionEvent = events.find((event) => event?.data?.requestProgress?.progress === 1);
  t.truthy(completionEvent);

  const progress = completionEvent.data.requestProgress;
  validateProgressMessage(t, progress, requestId);

  const finalData = JSON.parse(progress.data || '""');
  t.true(typeof finalData === 'string');
  t.true(finalData.includes('ERROR_RESPONSE'));
  t.true(finalData.includes('Model crashed after tool calls'));
});
