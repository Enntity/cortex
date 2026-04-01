import test from 'ava';
import OpenAIReasoningVisionPlugin from '../../../server/plugins/openAiReasoningVisionPlugin.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import { config } from '../../../config.js';

function createResolverWithPlugin(pluginClass, modelName = 'test-model', modelOverrides = {}) {
  const pathway = {
    name: 'test-pathway',
    model: modelName,
    prompt: 'test prompt',
    toolCallback: () => {}
  };

  const model = {
    name: modelName,
    type: 'OPENAI-REASONING-VISION',
    ...modelOverrides
  };

  const resolver = new PathwayResolver({
    config,
    pathway,
    args: {},
    endpoints: { [modelName]: model }
  });

  resolver.modelExecutor.plugin = new pluginClass(pathway, model);
  return resolver;
}

test('getRequestParameters - applies model reasoningEffortMap for OpenAI reasoning vision models', async t => {
  const resolver = createResolverWithPlugin(
    OpenAIReasoningVisionPlugin,
    'oai-router',
    {
      reasoningEffortMap: {
        none: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'high',
      },
    }
  );
  const plugin = resolver.modelExecutor.plugin;

  const params = await plugin.getRequestParameters(
    'test',
    { reasoningEffort: 'none' },
    { prompt: 'test' }
  );

  t.is(params.reasoning_effort, 'low');
});

test('getRequestParameters - applies xhigh mapping for OpenAI reasoning vision models', async t => {
  const resolver = createResolverWithPlugin(
    OpenAIReasoningVisionPlugin,
    'oai-router',
    {
      reasoningEffortMap: {
        none: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'high',
      },
    }
  );
  const plugin = resolver.modelExecutor.plugin;

  const params = await plugin.getRequestParameters(
    'test',
    { reasoningEffort: 'xhigh' },
    { prompt: 'test' }
  );

  t.is(params.reasoning_effort, 'high');
});
