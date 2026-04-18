import test from 'ava';
import net from 'net';
import got from 'got';
import serverFactory from '../../../../../index.js';
import { config } from '../../../../../config.js';

const ROUTING_QUERY = `
  query TestRouting(
    $text: String!
    $chatHistory: [MultiMessage]!
    $requestedOutput: String
    $modelPolicy: String
  ) {
    sys_entity_runtime(
      text: $text
      chatHistory: $chatHistory
      requestedOutput: $requestedOutput
      modelPolicy: $modelPolicy
    ) {
      result
      warnings
      errors
    }
  }
`;

const VENDORS = [
  {
    key: 'openai',
    label: 'OpenAI',
    primaryModel: 'oai-gpt54',
    routingModel: 'oai-gpt54-mini',
  },
  {
    key: 'gemini',
    label: 'Gemini',
    primaryModel: 'gemini-flash-3-vision',
    routingModel: 'gemini-flash-31-lite-vision',
  },
  {
    key: 'claude',
    label: 'Claude',
    primaryModel: 'claude-46-sonnet',
    routingModel: 'claude-45-haiku',
  },
  {
    key: 'grok',
    label: 'Grok',
    primaryModel: 'xai-grok-4-1-fast-reasoning',
    routingModel: 'xai-grok-4-1-fast-non-reasoning',
  },
];

const SCENARIOS = [
  {
    key: 'casual_chat',
    text: 'heh nice',
    chatHistory: [
      { role: 'assistant', content: ['That was pretty slick.'] },
      { role: 'user', content: ['heh nice'] },
    ],
    assert(preparation, t, vendor) {
      t.is(preparation.routeMode, 'direct_reply', `${vendor}: casual chat should stay direct_reply`);
    },
  },
  {
    key: 'current_info',
    text: "What's Elon talking about today?",
    chatHistory: [
      { role: 'user', content: ["What's Elon talking about today?"] },
    ],
    assert(preparation, t, vendor) {
      t.true(
        ['direct_search', 'plan'].includes(preparation.routeMode),
        `${vendor}: current-info lookup should stay on a web-aware route`,
      );
    },
  },
  {
    key: 'media_folder',
    text: 'Show me some of the media folder.',
    chatHistory: [
      { role: 'user', content: ['Show me some of the media folder.'] },
    ],
    assert(preparation, t, vendor) {
      t.is(preparation.routeMode, 'direct_tool', `${vendor}: media-folder browse should use direct_tool`);
    },
  },
  {
    key: 'consent_followup',
    text: 'Yeah you can check it out.',
    chatHistory: [
      { role: 'assistant', content: ['Want me to actually crack it open and look?'] },
      { role: 'user', content: ['Yeah you can check it out.'] },
    ],
    assert(preparation, t, vendor) {
      t.is(preparation.routeMode, 'direct_tool', `${vendor}: referential approval should use direct_tool`);
    },
  },
  {
    key: 'workspace_in_chat_regression',
    text: "That's a strong one. What's going on in your workspace - you see anything?",
    chatHistory: [
      { role: 'assistant', content: ['Come closer and ask nicely.'] },
      { role: 'user', content: ["That's a strong one. What's going on in your workspace - you see anything?"] },
    ],
    assert(preparation, t, vendor) {
      t.is(preparation.routeMode, 'direct_tool', `${vendor}: explicit workspace inspection inside chat should use direct_tool`);
    },
  },
  {
    key: 'avatar_change',
    text: 'Use jinx_avatar.png as the base avatar.',
    chatHistory: [
      { role: 'user', content: ['Use jinx_avatar.png as the base avatar.'] },
    ],
    assert(preparation, t, vendor) {
      t.true(
        ['direct_tool', 'plan'].includes(preparation.routeMode),
        `${vendor}: avatar changes should use a tool-aware route`,
      );
    },
  },
  {
    key: 'image_inspection',
    text: 'Take a close look at moodboard.webp for me.',
    chatHistory: [
      { role: 'user', content: ['Take a close look at moodboard.webp for me.'] },
    ],
    assert(preparation, t, vendor) {
      t.true(
        ['direct_tool', 'plan'].includes(preparation.routeMode),
        `${vendor}: image inspection should use a tool-aware route`,
      );
    },
  },
  {
    key: 'multi_step_research',
    text: 'Compare the latest AI model releases and make a chart.',
    chatHistory: [
      { role: 'user', content: ['Compare the latest AI model releases and make a chart.'] },
    ],
    assert(preparation, t, vendor) {
      t.is(preparation.routeMode, 'plan', `${vendor}: broad comparative research should use plan`);
    },
  },
];

let testServer;
let baseUrl;
let originalPortEnv;
let originalPortConfig;
let vendorPolicies = new Map();

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

function buildVendorPolicy(vendor, ids = []) {
  if (!ids.includes(vendor.primaryModel) || !ids.includes(vendor.routingModel)) return null;
  const primaryModel = vendor.primaryModel;
  const routingModel = vendor.routingModel;
  const researchModel = routingModel;
  return JSON.stringify({
    primaryModel,
    orientationModel: primaryModel,
    planningModel: primaryModel,
    synthesisModel: primaryModel,
    verificationModel: primaryModel,
    routingModel,
    researchModel,
    childModel: researchModel,
    compressionModel: researchModel,
  });
}

async function fetchAvailableModelIds() {
  try {
    const response = await got(`${baseUrl}/v1/models`, { responseType: 'json' });
    return (response.body?.data || []).map((model) => model.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function runLatencyPrepare({ text, chatHistory, modelPolicy }) {
  const response = await testServer.executeOperation({
    query: ROUTING_QUERY,
    variables: {
      text,
      chatHistory,
      requestedOutput: 'latency_prepare',
      modelPolicy,
    },
  });

  const errors = response.body?.singleResult?.errors || [];
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join('; '));
  }

  const pathway = response.body?.singleResult?.data?.sys_entity_runtime;
  if (pathway?.errors?.length) {
    throw new Error(pathway.errors.join('; '));
  }

  return JSON.parse(pathway?.result || '{}');
}

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  originalPortEnv = process.env.CORTEX_PORT;
  originalPortConfig = config.get('PORT');
  const port = await getAvailablePort();
  process.env.CORTEX_PORT = String(port);
  config.set('PORT', port);
  baseUrl = `http://localhost:${port}`;

  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  const ids = await fetchAvailableModelIds();
  vendorPolicies = new Map(
    VENDORS.map((vendor) => [vendor.key, buildVendorPolicy(vendor, ids)]),
  );
});

test.after.always('cleanup', async () => {
  if (testServer) await testServer.stop();
  if (originalPortEnv === undefined) {
    delete process.env.CORTEX_PORT;
  } else {
    process.env.CORTEX_PORT = originalPortEnv;
  }
  config.set('PORT', originalPortConfig);
});

for (const vendor of VENDORS) {
  for (const scenario of SCENARIOS) {
    test.serial(`live routing: ${vendor.label} -> ${scenario.key}`, async (t) => {
      t.timeout(120000);
      const modelPolicy = vendorPolicies.get(vendor.key);
      if (!modelPolicy) {
        t.pass(`Skipping - no ${vendor.label} routing-capable model family configured`);
        return;
      }

      const preparation = await runLatencyPrepare({
        text: scenario.text,
        chatHistory: scenario.chatHistory,
        modelPolicy,
      });

      t.true(preparation.prepared, `${vendor.label}: latency_prepare should succeed`);
      t.truthy(preparation.routeMode, `${vendor.label}: routeMode should be present`);
      t.is(
        preparation.models?.routingModel,
        vendor.routingModel,
        `${vendor.label}: routing should run on the expected vendor family`,
      );
      scenario.assert(preparation, t, vendor.label);
    });
  }
}
