import test from 'ava';
import { EventEmitter } from 'events';
import serverFactory from '../../../../../index.js';
import { createWsClient, ensureWsConnection, collectSubscriptionEvents, validateProgressMessage } from '../../../../helpers/subscriptions.js';
import { config } from '../../../../../config.js';
import { PathwayResolver } from '../../../../../server/pathwayResolver.js';
import { getEntityStore } from '../../../../../lib/MongoEntityStore.js';

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
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    errorjson: buildToolDefinition('ErrorJson', 'test_tool_error_json'),
  };

  const entityId = 'entity-test-stream-errors';
  const testEntity = {
    id: entityId,
    name: 'Test Stream Errors Entity',
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

  // Inject test entity into MongoEntityStore cache (bypasses MongoDB)
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

  // Clear test entity from cache
  const entityStore = getEntityStore();
  entityStore._entityCache.delete(originals.entityId);
  entityStore._cacheTimestamps.delete(originals.entityId);
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

test.serial('sys_entity_agent streaming sends error to client when runAllPrompts throws 400 error', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  // Stub promptAndParse to simulate a 400 error from runAllPrompts (which is promptAndParse)
  PathwayResolver.prototype.promptAndParse = async function promptAndParseStub(args) {
    if (args?.title === 'test-400-error') {
      // Simulate runAllPrompts throwing a 400 error (this is what happens when model API returns 400)
      const error = new Error('HTTP 400 Bad Request: Invalid request parameters');
      error.statusCode = 400;
      throw error;
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
      text: 'Trigger 400 error',
      chatHistory: [{ role: 'user', content: ['Trigger 400 error'] }],
      stream: true,
      entityId: originals.entityId,
      title: 'test-400-error',
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

  t.true(events.length > 0, 'Should receive at least one event');
  const completionEvent = events.find((event) => event?.data?.requestProgress?.progress === 1);
  t.truthy(completionEvent, 'Should receive completion event with progress=1');

  const progress = completionEvent.data.requestProgress;
  validateProgressMessage(t, progress, requestId);

  // The error should be sent to the client either in the data field (as error response) or error field
  const finalData = JSON.parse(progress.data || '""');
  const hasErrorInData = typeof finalData === 'string' && (
    finalData.includes('ERROR_RESPONSE') || 
    finalData.includes('400') || 
    finalData.includes('Bad Request')
  );
  const hasErrorInField = progress.error && (
    progress.error.includes('400') || 
    progress.error.includes('Bad Request')
  );

  t.true(
    hasErrorInData || hasErrorInField,
    `Error should be sent to client. Data: ${JSON.stringify(finalData)}, Error field: ${progress.error}`
  );
});

test.serial('sys_entity_agent streaming sends error to client when stream errors with 400', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  // Stub promptAndParse to return a stream that immediately errors
  PathwayResolver.prototype.promptAndParse = async function promptAndParseStub(args) {
    if (args?.title === 'test-stream-400-error') {
      // Create a mock stream that errors immediately with 400
      const errorStream = new EventEmitter();
      
      // Simulate stream erroring immediately
      setImmediate(() => {
        const error = new Error('HTTP 400 Bad Request: Invalid request parameters');
        error.statusCode = 400;
        errorStream.emit('error', error);
      });
      
      return errorStream;
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
      text: 'Trigger stream 400 error',
      chatHistory: [{ role: 'user', content: ['Trigger stream 400 error'] }],
      stream: true,
      entityId: originals.entityId,
      title: 'test-stream-400-error',
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

  t.true(events.length > 0, 'Should receive at least one event');
  const completionEvent = events.find((event) => event?.data?.requestProgress?.progress === 1);
  t.truthy(completionEvent, 'Should receive completion event with progress=1');

  const progress = completionEvent.data.requestProgress;
  validateProgressMessage(t, progress, requestId);

  // The error should be sent to the client - either in error field or data field
  const hasErrorInField = progress.error && (
    progress.error.includes('400') || 
    progress.error.includes('Bad Request') ||
    progress.error.includes('Stream read failed')
  );
  
  const finalData = JSON.parse(progress.data || '""');
  const hasErrorInData = typeof finalData === 'string' && (
    finalData.includes('ERROR_RESPONSE') || 
    finalData.includes('400') || 
    finalData.includes('Bad Request')
  );

  t.true(
    hasErrorInData || hasErrorInField,
    `Error should be sent to client when stream errors. Data: ${JSON.stringify(finalData)}, Error field: ${progress.error}`
  );
});
