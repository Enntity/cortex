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

test('parity fix - without name field, Claude tool_call_ids produce wrong functionResponse names', t => {
  // This test documents the bug: when tool messages lack the name field and only
  // have Claude-format tool_call_ids, the functionResponse names are all 'toolu',
  // which causes the parity fix to misgroup tool results across rounds.
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
      // NO name field — this triggers the bug
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

  // Without the name field, tool_call_id.split('_')[0] gives 'toolu' for all
  // functionResponse parts. The parity fix greedily matches the first 'toolu'
  // response to the first assistant message, then the second 'toolu' to the
  // second assistant message, leaving the third orphaned.
  const fcTurns = params.contents.filter(c =>
    c.role === 'model' && c.parts?.some(p => p.functionCall)
  );
  const frTurns = params.contents.filter(c =>
    c.parts?.some(p => p.functionResponse)
  );

  // The parity fix still creates the correct number of model turns
  t.is(fcTurns.length, 2, 'Should still produce 2 model turns with functionCalls');

  // But without the name field, the functionResponse names are all 'toolu'
  const allFrNames = frTurns.flatMap(turn =>
    turn.parts.filter(p => p.functionResponse).map(p => p.functionResponse.name)
  );
  t.true(allFrNames.every(n => n === 'toolu'),
    'Without name field, all functionResponse names are "toolu" (the bug)');

  // The critical failure: parity is broken because the greedy matching
  // assigns one 'toolu' response to the first assistant (which has 2 calls)
  // and one 'toolu' response to the second assistant (which has 1 call),
  // leaving one orphaned
  const round1FcCount = fcTurns[0].parts.filter(p => p.functionCall).length;
  const round1FrCount = frTurns[0].parts.filter(p => p.functionResponse).length;
  // Round 1 has 2 functionCalls but only 1 functionResponse — MISMATCH
  t.not(round1FcCount, round1FrCount,
    'Bug: round 1 parity is broken (2 functionCalls vs 1 functionResponse)');
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

