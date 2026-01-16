import test from 'ava';
import sysEntityAgent from '../../pathways/system/entity/sys_entity_agent.js';
import { config } from '../../config.js';
import { getToolsForEntity } from '../../pathways/system/entity/tools/shared/sys_entity_tools.js';

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

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-test',
  rootRequestId: 'root-req-test',
  pathway: sysEntityAgent,
  modelExecutor: {
    plugin: {
      truncateMessagesToTargetLength: (messages) => messages,
    },
  },
  promptAndParse: async () => 'final-response',
  ...overrides,
});

const setupConfig = () => {
  const originalGet = config.get.bind(config);
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    errorjson: buildToolDefinition('ErrorJson', 'test_tool_error_json'),
    throws500: buildToolDefinition('Throws500', 'test_tool_500'),
    timeouttool: buildToolDefinition('TimeoutTool', 'test_tool_timeout'),
    nullresult: buildToolDefinition('NullResult', 'test_tool_null'),
  };

  const entityId = 'entity-test-errors';
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
    test_tool_500: {
      rootResolver: async () => {
        throw new Error('500 Internal Server Error');
      },
    },
    test_tool_timeout: {
      rootResolver: async () => {
        throw new Error('ETIMEDOUT');
      },
    },
    test_tool_null: {
      rootResolver: async () => ({
        result: null,
      }),
    },
  };

  config.load({
    pathways,
    entityTools: {},
  });

  // convict schema does not expose entityConfig; override config.get for tests
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

test.serial('executePathway returns sys_generator_error output on 500 base model error', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const resolver = buildResolver();
  const args = {
    text: 'trigger base model error',
    chatHistory: [{ role: 'user', content: 'hi' }],
    agentContext: [],
    entityId: originals.entityId,
  };

  const runAllPrompts = async () => {
    throw new Error('HTTP 500 from model');
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });
  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('HTTP 500 from model'));
});

test.serial('executePathway falls back when sys_generator_error fails after null model response', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const brokenPathways = {
    ...config.get('pathways'),
    sys_generator_error: {
      rootResolver: async () => {
        throw new Error('sys_generator_error failed');
      },
    },
  };
  config.load({ pathways: brokenPathways });

  const resolver = buildResolver();
  const args = {
    text: 'trigger null response',
    chatHistory: [{ role: 'user', content: 'hi' }],
    agentContext: [],
    entityId: originals.entityId,
  };

  const runAllPrompts = async () => null;
  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.true(result.includes('I apologize, but I encountered an error while processing your request'));
  t.true(result.includes('Model execution returned null'));
});

test.serial('toolCallback surfaces 400 error JSON from tool result', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('400 Bad Request'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('400 Bad Request')
  )));
});

test.serial('toolCallback captures 500 error thrown by tool pathway', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('Throws500')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('500 Internal Server Error'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('500 Internal Server Error')
  )));
});

test.serial('toolCallback captures tool null result as error', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('NullResult')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('returned null result'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('returned null result')
  )));
});

test.serial('toolCallback reports invalid tool call arguments', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = {
    tool_calls: [{
      id: 'bad-tool-call',
      type: 'function',
      function: { name: 'ErrorJson' },
    }],
  };

  const result = await sysEntityAgent.toolCallback(args, message, resolver);
  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('Invalid tool call structure: missing function arguments'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('Invalid tool call structure')
  )));
});

test.serial('toolCallback returns error response when promptAndParse throws', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  const resolver = buildResolver({
    promptAndParse: async () => {
      throw new Error('Model crashed after tool calls');
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('Model crashed after tool calls'));
});

test.serial('executePathway returns error response when tool recursion times out', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  const resolver = buildResolver({
    promptAndParse: async () => {
      throw new Error('Tool recursion timeout');
    },
  });

  const args = {
    text: 'trigger tool recursion',
    chatHistory: [{ role: 'user', content: 'hi' }],
    agentContext: [],
    entityId: originals.entityId,
    entityToolsOpenAiFormat,
  };

  const runAllPrompts = async () => ({
    tool_calls: [buildToolCall('TimeoutTool')],
  });

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });
  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('Tool recursion timeout'));
});

test.serial('toolCallback injects max tool call message once limit reached', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    toolCallCount: 50,
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  await sysEntityAgent.toolCallback(args, message, resolver);

  const systemMessage = promptArgs.chatHistory.find((entry) => (
    entry.role === 'user' &&
    typeof entry.content === 'string' &&
    entry.content.includes('Maximum tool call limit reached')
  ));

  t.truthy(systemMessage);
});
