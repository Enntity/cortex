import test from 'ava';
import Gemini3ReasoningVisionPlugin from '../../../server/plugins/gemini3ReasoningVisionPlugin.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import { config } from '../../../config.js';

// Mock logger to prevent issues in tests
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

global.logger = mockLogger;

function createResolverWithPlugin(pluginClass, modelName = 'test-model') {
  const pathway = {
    name: 'test-pathway',
    model: modelName,
    prompt: 'test prompt',
    toolCallback: () => {}
  };
  
  const model = {
    name: modelName,
    type: 'GEMINI-3-REASONING-VISION'
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

// ===== buildFunctionCallPart tests =====

test('buildFunctionCallPart - includes thoughtSignature when present', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const toolCall = {
    function: { name: 'SearchInternet' },
    thoughtSignature: 'abc123signature'
  };
  const args = { query: 'test query' };
  
  const result = plugin.buildFunctionCallPart(toolCall, args);
  
  t.is(result.functionCall.name, 'SearchInternet');
  t.deepEqual(result.functionCall.args, { query: 'test query' });
  t.is(result.thoughtSignature, 'abc123signature', 'Should include thoughtSignature from toolCall');
});

test('buildFunctionCallPart - uses fallback signature when thoughtSignature missing', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const toolCall = {
    function: { name: 'GenerateImage' }
    // No thoughtSignature
  };
  const args = { prompt: 'a cat' };
  
  const result = plugin.buildFunctionCallPart(toolCall, args);
  
  t.is(result.functionCall.name, 'GenerateImage');
  t.deepEqual(result.functionCall.args, { prompt: 'a cat' });
  t.is(result.thoughtSignature, 'skip_thought_signature_validator', 
    'Should use documented fallback signature when missing');
});

// ===== buildToolCallFromFunctionCall tests =====

test('buildToolCallFromFunctionCall - captures thoughtSignature from part.thoughtSignature', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'SearchInternet',
      args: { query: 'weather' }
    },
    thoughtSignature: 'sig_from_part'
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'SearchInternet');
  t.is(JSON.parse(result.function.arguments).query, 'weather');
  t.is(result.thoughtSignature, 'sig_from_part', 'Should capture thoughtSignature from part');
});

test('buildToolCallFromFunctionCall - captures thoughtSignature from functionCall.thoughtSignature', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'GenerateImage',
      args: { prompt: 'sunset' },
      thoughtSignature: 'sig_from_function_call'
    }
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'GenerateImage');
  t.is(result.thoughtSignature, 'sig_from_function_call', 
    'Should capture thoughtSignature from functionCall');
});

test('buildToolCallFromFunctionCall - prefers functionCall.thoughtSignature over part.thoughtSignature', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'TestTool',
      args: {},
      thoughtSignature: 'preferred_sig'
    },
    thoughtSignature: 'fallback_sig'
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.thoughtSignature, 'preferred_sig', 
    'Should prefer functionCall.thoughtSignature');
});

test('buildToolCallFromFunctionCall - handles missing thoughtSignature gracefully', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'SimpleTool',
      args: { value: 42 }
    }
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'SimpleTool');
  t.is(result.thoughtSignature, undefined, 
    'Should not add thoughtSignature if not present in response');
});

test('buildToolCallFromFunctionCall - handles empty args', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'NoArgsTool'
      // No args property
    },
    thoughtSignature: 'test_sig'
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'NoArgsTool');
  t.is(result.function.arguments, '{}', 'Should handle missing args as empty object');
  t.is(result.thoughtSignature, 'test_sig');
});

// ===== Integration-style tests for getRequestParameters =====

test('getRequestParameters - converts assistant role to model role', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Mock getCompiledPrompt to return messages with assistant role
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' }
    ];
    return result;
  };
  
  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });
  
  // The contents should have model role, not assistant
  const modelMessages = params.contents.filter(c => c.role === 'model');
  const assistantMessages = params.contents.filter(c => c.role === 'assistant');
  
  t.true(modelMessages.length > 0 || params.contents.length === 0, 
    'Should convert assistant to model role');
  t.is(assistantMessages.length, 0, 
    'Should not have any assistant role messages');
});

test('getRequestParameters - transforms function role to user role', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Create a mock that simulates having a function response
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Search for cats' },
      { 
        role: 'assistant', 
        content: '',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'SearchInternet', arguments: '{"q":"cats"}' },
          thoughtSignature: 'test_sig'
        }]
      },
      { role: 'function', content: 'Found cats', name: 'SearchInternet' }
    ];
    return result;
  };
  
  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });
  
  // After transformation, function role should become user role
  const functionMessages = params.contents.filter(c => c.role === 'function');
  t.is(functionMessages.length, 0, 
    'Should not have any function role messages after transformation');
});

test('getRequestParameters - parallel tool calls produce one functionCall message', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  // Simulate 3 parallel tool calls from one assistant message
  // Parent plugin expects OpenAI format: role:'tool' with tool_call_id (not role:'function')
  // Tool name is derived from tool_call_id.split('_')[0]
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Find info' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'SearchInternet', arguments: '{"q":"cats"}' }, thoughtSignature: 'sig1' },
          { id: 'call_2', function: { name: 'FileCollection', arguments: '{"action":"LIST"}' }, thoughtSignature: 'sig2' },
          { id: 'call_3', function: { name: 'ValidateUrl', arguments: '{"url":"http://example.com"}' }, thoughtSignature: 'sig3' },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchInternet_1', content: 'search results' },
      { role: 'tool', tool_call_id: 'FileCollection_2', content: 'file list' },
      { role: 'tool', tool_call_id: 'ValidateUrl_3', content: 'url valid' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // Count model messages that contain functionCall parts
  const functionCallMessages = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  // Count user messages that contain functionResponse parts
  const functionResponseMessages = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  t.is(functionCallMessages.length, 1,
    'Should produce exactly ONE model message with functionCall parts for parallel calls');

  const functionCallParts = functionCallMessages[0].parts.filter(p => p.functionCall);
  t.is(functionCallParts.length, 3,
    'The single model message should contain all 3 functionCall parts');

  t.is(functionResponseMessages.length, 1,
    'Consecutive functionResponse messages should be merged into one user turn');

  const functionResponseParts = functionResponseMessages[0].parts.filter(p => p.functionResponse);
  t.is(functionResponseParts.length, 3,
    'The single user message should contain all 3 functionResponse parts (per-turn parity with functionCall)');
});

// ===== Dual-model tool loop parity tests (Claude executor + Gemini primary) =====
// These tests verify the fix for: "Please ensure that the number of function response
// parts is equal to the number of function call parts of the function call turn."
// Root cause: Claude-format tool_call_ids (toolu_...) caused functionResponse names
// to resolve as 'toolu' instead of the actual tool name, breaking the parity fix's
// ability to correctly group functionResponse parts with their functionCall turns.

test('parity fix - Claude-format tool_call_ids use message.name for correct functionResponse names', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  // Simulate Claude executor returning 3 parallel tool calls
  // Claude tool_call_ids look like toolu_01Xyz... — split('_')[0] gives 'toolu' (wrong)
  // The name field on tool messages provides the correct name
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Monitor the situation' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_01AdRbigqBjF2fSseUhx8SfG', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"echo hi"}' } },
          { id: 'toolu_01QzEEDD3XFHeeEUFiRb1vq3', type: 'function', function: { name: 'StoreContinuityMemory', arguments: '{"content":"test"}' } },
          { id: 'toolu_01PRahgtB1Lh6CWFA9TaKney', type: 'function', function: { name: 'StoreContinuityMemory', arguments: '{"content":"test2"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01AdRbigqBjF2fSseUhx8SfG', name: 'WorkspaceSSH', content: 'output' },
      { role: 'tool', tool_call_id: 'toolu_01QzEEDD3XFHeeEUFiRb1vq3', name: 'StoreContinuityMemory', content: 'stored' },
      { role: 'tool', tool_call_id: 'toolu_01PRahgtB1Lh6CWFA9TaKney', name: 'StoreContinuityMemory', content: 'stored2' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // The model turn should have 3 functionCall parts
  const functionCallMsgs = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  t.is(functionCallMsgs.length, 1, 'Should have one model turn with functionCalls');
  const fcParts = functionCallMsgs[0].parts.filter(p => p.functionCall);
  t.is(fcParts.length, 3, 'Model turn should have 3 functionCall parts');

  // The user turn should have 3 functionResponse parts (parity)
  const functionResponseMsgs = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );
  t.is(functionResponseMsgs.length, 1, 'Should have one user turn with functionResponses');
  const frParts = functionResponseMsgs[0].parts.filter(p => p.functionResponse);
  t.is(frParts.length, 3, 'User turn should have 3 functionResponse parts (parity with functionCalls)');

  // Verify the functionResponse names are the actual tool names, not 'toolu'
  const frNames = frParts.map(p => p.functionResponse.name);
  t.deepEqual(frNames, ['WorkspaceSSH', 'StoreContinuityMemory', 'StoreContinuityMemory'],
    'functionResponse names should be actual tool names, not "toolu"');
});

test('parity fix - dual-model synthesis scenario: Gemini initial + Claude executor rounds', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  // This reproduces the exact production scenario from run.log:
  // 1. Gemini primary returns initial tool calls (Gemini-format IDs)
  // 2. Claude executor runs 2 more rounds (Claude-format IDs)
  // 3. Synthesis call sends the full history back to Gemini
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Execute pulse wake monitoring' },

      // Round 1: Gemini primary's initial response (Gemini-format IDs)
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'WorkspaceSSH_1770012733044_2', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"echo init"}' }, thoughtSignature: 'sig1' },
          { id: 'SearchInternet_1770012733044_5', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"test"}' }, thoughtSignature: 'sig2' },
          { id: 'SearchXPlatform_1770012733044_3', type: 'function', function: { name: 'SearchXPlatform', arguments: '{"text":"test1"}' }, thoughtSignature: 'sig3' },
          { id: 'SearchXPlatform_1770012733044_4', type: 'function', function: { name: 'SearchXPlatform', arguments: '{"text":"test2"}' }, thoughtSignature: 'sig4' },
        ]
      },
      { role: 'tool', tool_call_id: 'WorkspaceSSH_1770012733044_2', name: 'WorkspaceSSH', content: 'scratchpad initialized' },
      { role: 'tool', tool_call_id: 'SearchInternet_1770012733044_5', name: 'SearchInternet', content: 'search results' },
      { role: 'tool', tool_call_id: 'SearchXPlatform_1770012733044_3', name: 'SearchXPlatform', content: 'x results 1' },
      { role: 'tool', tool_call_id: 'SearchXPlatform_1770012733044_4', name: 'SearchXPlatform', content: 'x results 2' },

      // Round 2: Claude executor (Claude-format IDs — the bug trigger)
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_01AdRbigqBjF2fSseUhx8SfG', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"cat > scratchpad"}' } },
          { id: 'toolu_01QzEEDD3XFHeeEUFiRb1vq3', type: 'function', function: { name: 'StoreContinuityMemory', arguments: '{"content":"mem1"}' } },
          { id: 'toolu_01PRahgtB1Lh6CWFA9TaKney', type: 'function', function: { name: 'StoreContinuityMemory', arguments: '{"content":"mem2"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01AdRbigqBjF2fSseUhx8SfG', name: 'WorkspaceSSH', content: 'scratchpad updated' },
      { role: 'tool', tool_call_id: 'toolu_01QzEEDD3XFHeeEUFiRb1vq3', name: 'StoreContinuityMemory', content: 'stored' },
      { role: 'tool', tool_call_id: 'toolu_01PRahgtB1Lh6CWFA9TaKney', name: 'StoreContinuityMemory', content: 'stored2' },

      // Round 3: Claude executor single tool call (Claude-format ID)
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_01XYZendpulse123456789ab', type: 'function', function: { name: 'EndPulse', arguments: '{"reflection":"done"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01XYZendpulse123456789ab', name: 'EndPulse', content: 'pulse ended' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // Collect all functionCall model turns and functionResponse user turns
  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  const frTurns = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  // Should have 3 functionCall turns (one per assistant message)
  t.is(fcTurns.length, 3, 'Should have 3 model turns with functionCalls (one per round)');

  // Should have 3 functionResponse turns (one per round, merged)
  t.is(frTurns.length, 3, 'Should have 3 user turns with functionResponses (one per round)');

  // Verify per-turn parity: each model turn's functionCall count must match
  // the immediately following user turn's functionResponse count
  for (let i = 0; i < fcTurns.length; i++) {
    const fcCount = fcTurns[i].parts.filter(p => p.functionCall).length;
    const frCount = frTurns[i].parts.filter(p => p.functionResponse).length;
    t.is(fcCount, frCount,
      `Round ${i + 1}: functionCall count (${fcCount}) must equal functionResponse count (${frCount})`);
  }

  // Verify specific counts: round 1 = 4, round 2 = 3, round 3 = 1
  t.is(fcTurns[0].parts.filter(p => p.functionCall).length, 4, 'Round 1 (Gemini): 4 tool calls');
  t.is(fcTurns[1].parts.filter(p => p.functionCall).length, 3, 'Round 2 (Claude): 3 tool calls');
  t.is(fcTurns[2].parts.filter(p => p.functionCall).length, 1, 'Round 3 (Claude): 1 tool call');

  // Verify alternating model/user pattern
  const turnsWithTools = params.contents.filter(c =>
    c.parts?.some(p => p.functionCall || p.functionResponse)
  );
  for (let i = 0; i < turnsWithTools.length - 1; i += 2) {
    t.is(turnsWithTools[i].role, 'model', `Turn ${i} should be model`);
    t.true(turnsWithTools[i + 1].role === 'user',
      `Turn ${i + 1} should be user`);
  }
});

test('parity fix - without name field, position-based matching maintains parity', t => {
  // Without the name field on tool messages, the position-based rebuild still
  // maintains correct parity because it processes messages in order, not by name.
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  // Two rounds of Claude tool calls WITHOUT name field on tool messages
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'do something' },
      // Round 1: 2 tool calls
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01AAAA', type: 'function', function: { name: 'ToolA', arguments: '{}' } },
          { id: 'toolu_01BBBB', type: 'function', function: { name: 'ToolB', arguments: '{}' } },
        ]
      },
      // NO name field — falls back to 'unknown_tool' but parity is correct
      { role: 'tool', tool_call_id: 'toolu_01AAAA', content: 'result A' },
      { role: 'tool', tool_call_id: 'toolu_01BBBB', content: 'result B' },
      // Round 2: 1 tool call
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01CCCC', type: 'function', function: { name: 'ToolC', arguments: '{}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01CCCC', content: 'result C' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  const frTurns = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  t.is(fcTurns.length, 2, 'Should produce 2 model turns with functionCalls');
  t.is(frTurns.length, 2, 'Should produce 2 user turns with functionResponses');

  // Parity is maintained: round 1 has 2 calls and 2 responses
  const round1FcCount = fcTurns[0].parts.filter(p => p.functionCall).length;
  const round1FrCount = frTurns[0].parts.filter(p => p.functionResponse).length;
  t.is(round1FcCount, 2, 'Round 1 should have 2 functionCall parts');
  t.is(round1FrCount, 2, 'Round 1 should have 2 functionResponse parts');

  // Round 2 has 1 call and 1 response
  const round2FcCount = fcTurns[1].parts.filter(p => p.functionCall).length;
  const round2FrCount = frTurns[1].parts.filter(p => p.functionResponse).length;
  t.is(round2FcCount, 1, 'Round 2 should have 1 functionCall part');
  t.is(round2FrCount, 1, 'Round 2 should have 1 functionResponse part');
});

test('parity fix - name field on tool messages fixes parity for Claude tool_call_ids', t => {
  // Same scenario as above but WITH the name field — parity is correct
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'do something' },
      // Round 1: 2 tool calls
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01AAAA', type: 'function', function: { name: 'ToolA', arguments: '{}' } },
          { id: 'toolu_01BBBB', type: 'function', function: { name: 'ToolB', arguments: '{}' } },
        ]
      },
      // WITH name field — the fix
      { role: 'tool', tool_call_id: 'toolu_01AAAA', name: 'ToolA', content: 'result A' },
      { role: 'tool', tool_call_id: 'toolu_01BBBB', name: 'ToolB', content: 'result B' },
      // Round 2: 1 tool call
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01CCCC', type: 'function', function: { name: 'ToolC', arguments: '{}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01CCCC', name: 'ToolC', content: 'result C' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  const frTurns = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  t.is(fcTurns.length, 2, 'Should produce 2 model turns with functionCalls');
  t.is(frTurns.length, 2, 'Should produce 2 user turns with functionResponses');

  // Per-turn parity must match
  const round1FcCount = fcTurns[0].parts.filter(p => p.functionCall).length;
  const round1FrCount = frTurns[0].parts.filter(p => p.functionResponse).length;
  t.is(round1FcCount, 2, 'Round 1: 2 functionCalls');
  t.is(round1FrCount, 2, 'Round 1: 2 functionResponses (parity!)');

  const round2FcCount = fcTurns[1].parts.filter(p => p.functionCall).length;
  const round2FrCount = frTurns[1].parts.filter(p => p.functionResponse).length;
  t.is(round2FcCount, 1, 'Round 2: 1 functionCall');
  t.is(round2FrCount, 1, 'Round 2: 1 functionResponse (parity!)');

  // Verify correct names
  const round1FrNames = frTurns[0].parts.filter(p => p.functionResponse).map(p => p.functionResponse.name);
  t.deepEqual(round1FrNames, ['ToolA', 'ToolB'], 'Round 1: correct functionResponse names');

  const round2FrNames = frTurns[1].parts.filter(p => p.functionResponse).map(p => p.functionResponse.name);
  t.deepEqual(round2FrNames, ['ToolC'], 'Round 2: correct functionResponse name');
});

test('parity fix - repeated tool names across rounds with Claude IDs resolve correctly', t => {
  // Edge case: the same tool (e.g. WorkspaceSSH) is called in multiple rounds.
  // The parity fix must not confuse tool results from different rounds.
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'multi-round task' },
      // Round 1: WorkspaceSSH + SearchInternet
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01Round1A', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"ls"}' } },
          { id: 'toolu_01Round1B', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"x"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01Round1A', name: 'WorkspaceSSH', content: 'ls output' },
      { role: 'tool', tool_call_id: 'toolu_01Round1B', name: 'SearchInternet', content: 'search result' },
      // Round 2: WorkspaceSSH again (same tool name, different round)
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01Round2A', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"cat file"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01Round2A', name: 'WorkspaceSSH', content: 'file contents' },
      // Round 3: WorkspaceSSH + StoreContinuityMemory
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01Round3A', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"echo done"}' } },
          { id: 'toolu_01Round3B', type: 'function', function: { name: 'StoreContinuityMemory', arguments: '{"content":"x"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01Round3A', name: 'WorkspaceSSH', content: 'done' },
      { role: 'tool', tool_call_id: 'toolu_01Round3B', name: 'StoreContinuityMemory', content: 'stored' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  const frTurns = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  t.is(fcTurns.length, 3, 'Should have 3 model turns (one per round)');
  t.is(frTurns.length, 3, 'Should have 3 user turns (one per round)');

  // Verify per-turn parity
  const expected = [2, 1, 2]; // tool calls per round
  for (let i = 0; i < 3; i++) {
    const fcCount = fcTurns[i].parts.filter(p => p.functionCall).length;
    const frCount = frTurns[i].parts.filter(p => p.functionResponse).length;
    t.is(fcCount, expected[i], `Round ${i + 1}: ${expected[i]} functionCalls`);
    t.is(frCount, expected[i], `Round ${i + 1}: ${expected[i]} functionResponses (parity)`);
  }
});

test('parity fix - assistant message with empty content still gets functionCall turn', t => {
  // When an assistant message has content: null or content: '', the base
  // convertMessagesToGemini may not create a model turn. The parity fix
  // must still insert a functionCall model turn.
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'test' },
      // content: null — no model turn created by base conversion
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'toolu_01AAA', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"test"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01AAA', name: 'SearchInternet', content: 'found it' },
      // content: '' — also may not create a model turn
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'toolu_01BBB', type: 'function', function: { name: 'WorkspaceSSH', arguments: '{"command":"ls"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01BBB', name: 'WorkspaceSSH', content: 'output' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  const frTurns = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  t.is(fcTurns.length, 2, 'Should create functionCall model turns even for null/empty content assistants');
  t.is(frTurns.length, 2, 'Should have matching functionResponse user turns');

  // Both rounds: 1 functionCall = 1 functionResponse
  for (let i = 0; i < 2; i++) {
    const fcCount = fcTurns[i].parts.filter(p => p.functionCall).length;
    const frCount = frTurns[i].parts.filter(p => p.functionResponse).length;
    t.is(fcCount, 1, `Round ${i + 1}: 1 functionCall`);
    t.is(frCount, 1, `Round ${i + 1}: 1 functionResponse`);
  }
});

// ===== Digest / synthesis scenario tests =====
// These tests cover the "function response parts didn't match the call parts" error
// that occurs when prepareForSynthesis adds a user-role review message after tool
// results, creating consecutive user turns that Gemini 3 rejects.

test('parity fix - user text after functionResponse is merged into same user turn', t => {
  // Reproduces the exact digest failure: after the tool loop, prepareForSynthesis
  // adds a user-role review message. After parity fix converts function→user,
  // this creates consecutive user turns: user(functionResponse) + user(text).
  // The fix merges them into one user turn.
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Generate a 7-day digest for this entity.' },
      // preservePriorText from initial model response
      { role: 'assistant', content: 'I\'ll search your memory for context to generate the digest.' },
      // Tool call (after SetGoals stripped)
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchMemory_1234_1', type: 'function', function: { name: 'SearchMemory', arguments: '{"query":"recent conversations"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchMemory_1234_1', name: 'SearchMemory', content: '{"memories":[]}' },
      // prepareForSynthesis review message (user-role system message)
      { role: 'user', content: '[system message: abc123] Review the tool results above against your todo list (Goal: Generate digest).' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // Should have no consecutive same-role turns
  for (let i = 1; i < params.contents.length; i++) {
    const prev = params.contents[i - 1];
    const cur = params.contents[i];
    t.not(prev.role, cur.role,
      `Consecutive same-role turns at index ${i - 1}/${i}: ${prev.role}`);
  }

  // Should start with user
  t.is(params.contents[0].role, 'user', 'Must start with user turn');

  // The review text should be merged into the functionResponse user turn
  const userTurnsWithFR = params.contents.filter(c =>
    c.role === 'user' && c.parts?.some(p => p.functionResponse)
  );
  t.is(userTurnsWithFR.length, 1, 'Should have exactly one user turn with functionResponse');

  // That turn should also contain the review text
  const hasText = userTurnsWithFR[0].parts.some(p => p.text && p.text.includes('Review the tool results'));
  t.true(hasText, 'Review message text should be merged into the functionResponse user turn');
});

test('parity fix - even-number slicing does not drop first user message', t => {
  // When the base converter produces an even number of messages, it slices off
  // the first one (a legacy heuristic). If that first message is the user's query,
  // it's lost. The Gemini3 parity fix should restore it.
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    // 4 non-system messages → base converter produces 4 entries (even) → slices first
    // system msgs are extracted separately, leaving: user, model, function, user = 4
    result.modelPromptMessages = [
      { role: 'user', content: 'Generate digest for the past 7 days.' },
      { role: 'assistant', content: 'Let me search for context.' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchMemory_5678_1', type: 'function', function: { name: 'SearchMemory', arguments: '{"query":"digest"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchMemory_5678_1', name: 'SearchMemory', content: '{"memories":[]}' },
      { role: 'user', content: 'Review the tool results and respond.' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // Must start with user
  t.is(params.contents[0].role, 'user', 'Must start with user turn');

  // The original user query must be present
  const userTexts = params.contents
    .filter(c => c.role === 'user')
    .flatMap(c => c.parts.filter(p => p.text).map(p => p.text));
  t.true(userTexts.some(t => t.includes('Generate digest')),
    'Original user query must be preserved even after even-number slicing');
});

test('parity fix - multi-tool digest scenario maintains parity and structure', t => {
  // Full digest scenario: 2 tool rounds (initial + executor) then synthesis review
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Generate a weekly digest.' },
      // Round 1: Initial model response + SearchMemory (SetGoals already stripped)
      { role: 'assistant', content: 'I\'ll gather information for your digest.' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchMemory_100_1', type: 'function', function: { name: 'SearchMemory', arguments: '{"query":"week summary"}' } },
          { id: 'SearchInternet_100_2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"recent news"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchMemory_100_1', name: 'SearchMemory', content: 'memory results' },
      { role: 'tool', tool_call_id: 'SearchInternet_100_2', name: 'SearchInternet', content: 'news results' },
      // Round 2: Executor called one more tool
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'toolu_01Executor123', type: 'function', function: { name: 'SearchMemory', arguments: '{"query":"user preferences"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_01Executor123', name: 'SearchMemory', content: 'preferences results' },
      // Synthesis review message
      { role: 'user', content: '[system message: rid123] Review the tool results above.' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // Must start with user
  t.is(params.contents[0].role, 'user', 'Must start with user turn');

  // No consecutive same-role turns
  for (let i = 1; i < params.contents.length; i++) {
    t.not(params.contents[i - 1].role, params.contents[i].role,
      `No consecutive same-role at ${i - 1}/${i}`);
  }

  // Parity check: each model functionCall turn must be followed by a user turn
  // with matching functionResponse count
  for (let i = 0; i < params.contents.length; i++) {
    const entry = params.contents[i];
    if (entry.role === 'model' && entry.parts?.some(p => p.functionCall)) {
      const fcCount = entry.parts.filter(p => p.functionCall).length;
      const next = params.contents[i + 1];
      t.truthy(next, `Model functionCall turn at ${i} must have a next entry`);
      t.is(next.role, 'user', `Entry after model functionCall must be user`);
      const frCount = next.parts.filter(p => p.functionResponse).length;
      t.is(fcCount, frCount, `Parity: ${fcCount} functionCalls must match ${frCount} functionResponses`);
    }
  }
});

test('parity fix - 4-round digest with repeated SearchInternet maintains parity', t => {
  // Reproduces the exact production digest failure: 4 tool rounds where SearchInternet
  // appears in every round. The old name-based matching would match round 2's
  // SearchInternet results to round 3's assistant (since round 2's was already emitted),
  // breaking parity. Position-based rebuild fixes this.
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;

  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Generate a 7-day AI/tech digest.' },
      // Initial model response (preservePriorText)
      { role: 'assistant', content: 'I\'ll compile your weekly digest by searching multiple sources.' },
      // Round 1: SearchMemory + SearchInternet + SearchInternet (3 tools)
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchMemory_r1_1', type: 'function', function: { name: 'SearchMemory', arguments: '{"query":"digest preferences"}' } },
          { id: 'SearchInternet_r1_2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"AI news this week"}' } },
          { id: 'SearchInternet_r1_3', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"tech industry news"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchMemory_r1_1', name: 'SearchMemory', content: '{"memories":["user likes AI topics"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r1_2', name: 'SearchInternet', content: '{"results":["AI news 1"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r1_3', name: 'SearchInternet', content: '{"results":["tech news 1"]}' },
      // Round 2: SearchInternet x7 (executor deep-dives)
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchInternet_r2_1', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"OpenAI updates"}' } },
          { id: 'SearchInternet_r2_2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Google AI updates"}' } },
          { id: 'SearchInternet_r2_3', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Meta AI updates"}' } },
          { id: 'SearchInternet_r2_4', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Anthropic updates"}' } },
          { id: 'SearchInternet_r2_5', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"semiconductor news"}' } },
          { id: 'SearchInternet_r2_6', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"robotics AI"}' } },
          { id: 'SearchInternet_r2_7', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"AI regulation"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_1', name: 'SearchInternet', content: '{"results":["OpenAI news"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_2', name: 'SearchInternet', content: '{"results":["Google news"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_3', name: 'SearchInternet', content: '{"results":["Meta news"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_4', name: 'SearchInternet', content: '{"results":["Anthropic news"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_5', name: 'SearchInternet', content: '{"results":["chip news"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_6', name: 'SearchInternet', content: '{"results":["robotics news"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r2_7', name: 'SearchInternet', content: '{"results":["regulation news"]}' },
      // Round 3: SearchInternet x5 (more detail)
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchInternet_r3_1', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"GPT-5 release"}' } },
          { id: 'SearchInternet_r3_2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Gemini 3 launch"}' } },
          { id: 'SearchInternet_r3_3', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Apple AI strategy"}' } },
          { id: 'SearchInternet_r3_4', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"AI startup funding"}' } },
          { id: 'SearchInternet_r3_5', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"open source AI models"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchInternet_r3_1', name: 'SearchInternet', content: '{"results":["GPT-5 info"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r3_2', name: 'SearchInternet', content: '{"results":["Gemini 3 info"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r3_3', name: 'SearchInternet', content: '{"results":["Apple AI info"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r3_4', name: 'SearchInternet', content: '{"results":["funding info"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r3_5', name: 'SearchInternet', content: '{"results":["open source info"]}' },
      // Round 4: SearchInternet x4 (final details)
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'SearchInternet_r4_1', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"AI ethics debate"}' } },
          { id: 'SearchInternet_r4_2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"quantum computing AI"}' } },
          { id: 'SearchInternet_r4_3', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"AI healthcare breakthroughs"}' } },
          { id: 'SearchInternet_r4_4', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"autonomous vehicles update"}' } },
        ]
      },
      { role: 'tool', tool_call_id: 'SearchInternet_r4_1', name: 'SearchInternet', content: '{"results":["ethics debate"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r4_2', name: 'SearchInternet', content: '{"results":["quantum info"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r4_3', name: 'SearchInternet', content: '{"results":["healthcare info"]}' },
      { role: 'tool', tool_call_id: 'SearchInternet_r4_4', name: 'SearchInternet', content: '{"results":["vehicles info"]}' },
      // Synthesis review message
      { role: 'user', content: '[system message: rid456] Review the tool results above against your todo list.' },
    ];
    return result;
  };

  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });

  // Must start with user
  t.is(params.contents[0].role, 'user', 'Must start with user turn');

  // No consecutive same-role turns
  for (let i = 1; i < params.contents.length; i++) {
    t.not(params.contents[i - 1].role, params.contents[i].role,
      `No consecutive same-role at ${i - 1}/${i}: both are ${params.contents[i].role}`);
  }

  // Extract functionCall model turns and functionResponse user turns
  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall));
  const frTurns = params.contents.filter(c =>
    c.role === 'user' && c.parts?.some(p => p.functionResponse));

  t.is(fcTurns.length, 4, 'Should have 4 model turns with functionCalls (one per round)');
  t.is(frTurns.length, 4, 'Should have 4 user turns with functionResponses (one per round)');

  // Verify parity for each round
  const expectedCounts = [3, 7, 5, 4]; // tool calls per round
  for (let i = 0; i < 4; i++) {
    const fcCount = fcTurns[i].parts.filter(p => p.functionCall).length;
    const frCount = frTurns[i].parts.filter(p => p.functionResponse).length;
    t.is(fcCount, expectedCounts[i], `Round ${i + 1}: should have ${expectedCounts[i]} functionCall parts`);
    t.is(frCount, expectedCounts[i], `Round ${i + 1}: should have ${expectedCounts[i]} functionResponse parts`);
  }

  // Verify strict alternation: each functionCall turn is immediately followed by its functionResponse turn
  for (let i = 0; i < params.contents.length; i++) {
    const entry = params.contents[i];
    if (entry.role === 'model' && entry.parts?.some(p => p.functionCall)) {
      const next = params.contents[i + 1];
      t.truthy(next, `Model functionCall turn at index ${i} must have a following entry`);
      t.is(next.role, 'user', `Entry after model functionCall at ${i} must be user`);
      t.true(next.parts?.some(p => p.functionResponse),
        `User turn after model functionCall at ${i} must contain functionResponse parts`);
      const fcCount = entry.parts.filter(p => p.functionCall).length;
      const frCount = next.parts.filter(p => p.functionResponse).length;
      t.is(fcCount, frCount,
        `Parity at index ${i}: ${fcCount} functionCalls must equal ${frCount} functionResponses`);
    }
  }
});

test('Gemini3ReasoningVisionPlugin - inherits from Gemini3ImagePlugin', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Should have the parent class methods available
  t.true(typeof plugin.processStreamEvent === 'function', 
    'Should inherit processStreamEvent from parent');
  t.true(typeof plugin.getRequestParameters === 'function', 
    'Should have getRequestParameters method');
  t.true(typeof plugin.buildFunctionCallPart === 'function',
    'Should have buildFunctionCallPart method');
  t.true(typeof plugin.buildToolCallFromFunctionCall === 'function',
    'Should have buildToolCallFromFunctionCall method');
});

