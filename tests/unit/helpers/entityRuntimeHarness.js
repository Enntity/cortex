import sysEntityRuntime from '../../../pathways/system/entity/sys_entity_runtime.js';
import { config } from '../../../config.js';
import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import { getContinuityMemoryService } from '../../../lib/continuity/index.js';

export const buildToolDefinition = (name, pathwayName, properties = {}) => ({
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

export const buildResolver = (overrides = {}) => ({
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
  ensureMemoryLoaded: async () => ({ enabled: false, attempted: false, loaded: false, skipped: true }),
  promptAndParse: async () => 'final-response',
  ...overrides,
});

export const buildRouteToolCallResponse = (payload) => ({
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

export const buildToolCall = (name, args = {}, id = 'tool-call-1') => ({
  id,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

export const buildSetGoalsCall = (goal, steps, id = 'set-goals-1') => (
  buildToolCall('SetGoals', { goal, steps }, id)
);

export const buildPredictNextTurnsCall = (predictions, id = 'predict-next-turns-1') => (
  buildToolCall('PredictNextTurns', { predictions }, id)
);

export const isRouteCall = (args = {}) => (
  Array.isArray(args.tools)
  && args.tools.some((tool) => tool.function?.name === 'SelectRoute')
);

export const setupConfig = (customTools, entityOverrides = {}) => {
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

export const restoreConfig = (originals) => {
  config.load({
    pathways: originals.originalPathways,
    entityTools: originals.originalEntityTools,
  });

  const entityStore = getEntityStore();
  entityStore._entityCache.delete(originals.entityId);
  entityStore._cacheTimestamps.delete(originals.entityId);
};

export class PrototypePromptResolver {
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

export const stubContinuityService = () => {
  const service = getContinuityMemoryService();
  const original = {
    isAvailable: service.isAvailable,
    recordTurn: service.recordTurn,
    triggerSynthesis: service.triggerSynthesis,
    recordPulseTurn: service.recordPulseTurn,
    triggerPulseSynthesis: service.triggerPulseSynthesis,
  };
  const calls = [];

  service.isAvailable = () => true;
  service.recordTurn = (...args) => {
    calls.push({ type: 'recordTurn', args });
  };
  service.triggerSynthesis = (...args) => {
    calls.push({ type: 'triggerSynthesis', args });
  };
  service.recordPulseTurn = (...args) => {
    calls.push({ type: 'recordPulseTurn', args });
  };
  service.triggerPulseSynthesis = (...args) => {
    calls.push({ type: 'triggerPulseSynthesis', args });
  };

  return {
    calls,
    restore() {
      service.isAvailable = original.isAvailable;
      service.recordTurn = original.recordTurn;
      service.triggerSynthesis = original.triggerSynthesis;
      service.recordPulseTurn = original.recordPulseTurn;
      service.triggerPulseSynthesis = original.triggerPulseSynthesis;
    },
  };
};
