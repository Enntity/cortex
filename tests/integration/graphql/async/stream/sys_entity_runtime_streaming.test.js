import test from 'ava';
import net from 'net';
import serverFactory from '../../../../../index.js';
import { createWsClient, ensureWsConnection, collectSubscriptionEvents, validateProgressMessage } from '../../../../helpers/subscriptions.js';
import { config } from '../../../../../config.js';

let testServer;
let wsClient;
let originalPortEnv;
let originalPortConfig;

const getAvailablePort = async () => {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
    server.on('error', reject);
  });
};

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  originalPortEnv = process.env.CORTEX_PORT;
  originalPortConfig = config.get('PORT');
  const port = await getAvailablePort();
  process.env.CORTEX_PORT = String(port);
  config.set('PORT', port);

  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  wsClient = createWsClient();
  await ensureWsConnection(wsClient);
});

test.after.always('cleanup', async () => {
  if (wsClient) wsClient.dispose();
  if (testServer) await testServer.stop();
  if (originalPortEnv === undefined) {
    delete process.env.CORTEX_PORT;
  } else {
    process.env.CORTEX_PORT = originalPortEnv;
  }
  config.set('PORT', originalPortConfig);
});

test.serial('sys_entity_runtime streaming works correctly', async (t) => {
  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!, $chatHistory: [MultiMessage]!, $stream: Boolean!) {
        sys_entity_runtime(text: $text, chatHistory: $chatHistory, stream: $stream) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Tell me about the history of Al Jazeera',
      chatHistory: [{ role: "user", content: ["Tell me about the history of Al Jazeera"] }],
      stream: true
    }
  });

  const requestId = response.body?.singleResult?.data?.sys_entity_runtime?.result;
  t.truthy(requestId);

  const events = await collectSubscriptionEvents(wsClient, {
    query: `
      subscription OnRequestProgress($requestId: String!) {
        requestProgress(requestIds: [$requestId]) {
          requestId
          progress
          data
          info
        }
      }
    `,
    variables: { requestId },
  }, 30000, { requireCompletion: false, minEvents: 1 });

  t.true(events.length > 0);
  for (const event of events) {
    const progress = event.data.requestProgress;
    validateProgressMessage(t, progress, requestId);
    if (progress.data) {
      const parsed = JSON.parse(progress.data);
      t.true(typeof parsed === 'string' || typeof parsed === 'object');
    }
  }
});
