import test from 'ava';
import Gemini15VisionPlugin from '../../../server/plugins/gemini15VisionPlugin.js';
import { requestState } from '../../../server/requestState.js';

const createPlugin = () => {
  const pathway = {
    name: 'test-pathway',
    model: 'gemini-flash-3-vision',
    prompt: 'test prompt',
    toolCallback: () => {}
  };

  const model = {
    name: 'gemini-flash-3-vision',
    type: 'GEMINI-VISION'
  };

  return new Gemini15VisionPlugin(pathway, model);
};

test('processStreamEvent accumulates tool calls across events and dispatches once on STOP', t => {
  // Simulates Gemini 3 Flash pattern: 3 separate SSE events, each with a functionCall
  // + usageMetadata, only the last has finishReason: "STOP".
  // Verify: exactly ONE callback with ALL 3 tool calls.
  const toolCallbackArgs = [];
  const plugin = createPlugin();
  plugin.pathwayToolCallback = (...args) => toolCallbackArgs.push(args);
  plugin.requestId = 'test-req-123';

  const mockResolver = { args: { text: 'test' } };
  requestState['test-req-123'] = { pathwayResolver: mockResolver };

  const responseId = 'resp-abc-123';

  // Event 1: functionCall + usageMetadata, NO finishReason
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'SearchInternet', args: { query: 'topic A' } } }]
        }
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      responseId
    })
  }, {});

  t.is(toolCallbackArgs.length, 0, 'Should NOT dispatch after event 1');
  t.is(plugin.toolCallsBuffer.length, 1, 'Should buffer 1 tool call');

  // Event 2: another functionCall + usageMetadata, NO finishReason
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'SearchInternet', args: { query: 'topic B' } } }]
        }
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      responseId
    })
  }, {});

  t.is(toolCallbackArgs.length, 0, 'Should NOT dispatch after event 2');
  t.is(plugin.toolCallsBuffer.length, 2, 'Should buffer 2 tool calls');

  // Event 3: functionCall + usageMetadata + finishReason: "STOP"
  const result = plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'SearchInternet', args: { query: 'topic C' } } }]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      responseId
    })
  }, {});

  // Exactly ONE callback with ALL 3 tool calls
  t.true(result.toolCallbackInvoked, 'Should set toolCallbackInvoked on STOP');
  t.is(toolCallbackArgs.length, 1, 'Should invoke callback exactly once');

  const toolMessage = toolCallbackArgs[0][1];
  t.is(toolMessage.role, 'assistant');
  t.is(toolMessage.tool_calls.length, 3, 'Should include all 3 accumulated tool calls');
  t.is(toolMessage.tool_calls[0].function.name, 'SearchInternet');
  t.is(toolMessage.tool_calls[1].function.name, 'SearchInternet');
  t.is(toolMessage.tool_calls[2].function.name, 'SearchInternet');

  t.is(plugin.toolCallsBuffer.length, 0, 'Tool buffer should be cleared');

  delete requestState['test-req-123'];
});

test('processStreamEvent does NOT dispatch tool calls without finishReason STOP', t => {
  const toolCallbackArgs = [];
  const plugin = createPlugin();
  plugin.pathwayToolCallback = (...args) => toolCallbackArgs.push(args);
  plugin.requestId = 'test-req-456';

  requestState['test-req-456'] = { pathwayResolver: { args: {} } };

  // Intermediate event: functionCall + usageMetadata but no finishReason
  const event = {
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              name: 'WorkspaceSSH',
              args: { command: 'ls' }
            }
          }]
        }
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      modelVersion: 'gemini-3-flash-preview',
      responseId: 'test-response-id'
    })
  };

  const result = plugin.processStreamEvent(event, {});

  // Should NOT dispatch — waiting for STOP event
  t.falsy(result.toolCallbackInvoked, 'Should not dispatch without finishReason STOP');
  t.is(toolCallbackArgs.length, 0, 'Should not invoke callback');
  t.is(plugin.toolCallsBuffer.length, 1, 'Tool call should remain buffered');

  delete requestState['test-req-456'];
});

test('processStreamEvent resets state only on new responseId', t => {
  const plugin = createPlugin();
  plugin.pathwayToolCallback = () => {};
  plugin.requestId = 'test-req-reset';

  requestState['test-req-reset'] = { pathwayResolver: { args: {} } };

  // Event with responseId "A" — buffer a tool call
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'ToolA', args: {} } }] }
      }],
      responseId: 'response-A'
    })
  }, {});

  t.is(plugin.toolCallsBuffer.length, 1);

  // Another event with SAME responseId "A" — should accumulate, not reset
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'ToolB', args: {} } }] }
      }],
      responseId: 'response-A'
    })
  }, {});

  t.is(plugin.toolCallsBuffer.length, 2, 'Should accumulate within same responseId');

  // Event with NEW responseId "B" — should reset
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'ToolC', args: {} } }] }
      }],
      responseId: 'response-B'
    })
  }, {});

  t.is(plugin.toolCallsBuffer.length, 1, 'Should reset on new responseId');
  t.is(plugin.toolCallsBuffer[0].function.name, 'ToolC');

  delete requestState['test-req-reset'];
});
