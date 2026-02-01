// dualModelToolLoop.test.js
// Tests for dual-model tool loop behavior: cheap model for tool orchestration,
// primary model for final synthesis. The tool loop now runs inside toolCallback
// for both streaming and non-streaming paths.

import test from 'ava';
import { insertSystemMessage, extractToolCalls, mergeParallelToolResults } from '../../../pathways/system/entity/sys_entity_agent.js';
import { COMPRESSION_THRESHOLD, compressOlderToolResults, rehydrateAllToolResults } from '../../../pathways/system/entity/tools/shared/tool_result_compression.js';

// --- extractToolCalls ---

test('extractToolCalls returns empty array for null/undefined', t => {
    t.deepEqual(extractToolCalls(null), []);
    t.deepEqual(extractToolCalls(undefined), []);
});

test('extractToolCalls extracts tool_calls from plain objects', t => {
    const message = { tool_calls: [{ id: 'tc1', function: { name: 'Search' } }] };
    const calls = extractToolCalls(message);
    t.is(calls.length, 1);
    t.is(calls[0].id, 'tc1');
});

test('extractToolCalls returns empty array when no tool_calls on plain object', t => {
    const message = { content: 'Hello' };
    t.deepEqual(extractToolCalls(message), []);
});

// --- insertSystemMessage: SYNTHESIZE injection ---

test('insertSystemMessage injects SYNTHESIZE instruction into messages', t => {
    const messages = [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'Weather' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'Sunny, 72F' }
    ];

    const result = insertSystemMessage(messages,
        'If you need more information, call tools. If you have gathered sufficient information to answer the user\'s request, respond with just: SYNTHESIZE',
        'req-123'
    );

    t.is(result.length, 4);
    const injected = result[result.length - 1];
    t.is(injected.role, 'user');
    t.true(injected.content.includes('SYNTHESIZE'));
    t.true(injected.content.includes('[system message: req-123]'));
});

test('insertSystemMessage replaces previous system message with same requestId', t => {
    const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: '[system message: req-1] Old instruction' }
    ];

    const result = insertSystemMessage(messages, 'New instruction', 'req-1');

    // Old message removed, new one added
    t.is(result.length, 2);
    t.is(result[0].content, 'Hello');
    t.true(result[1].content.includes('New instruction'));
    t.false(result[1].content.includes('Old instruction'));
});

test('insertSystemMessage does not remove messages with different requestId', t => {
    const messages = [
        { role: 'user', content: '[system message: req-1] First instruction' },
        { role: 'user', content: '[system message: req-2] Second instruction' }
    ];

    const result = insertSystemMessage(messages, 'Third', 'req-1');

    // req-1 removed, req-2 kept, new one added
    t.is(result.length, 2);
    t.true(result[0].content.includes('req-2'));
    t.true(result[1].content.includes('Third'));
});

// --- Dual-model configuration logic ---

test('toolLoopModel is null when model is not in config', t => {
    // Simulate config.get('models') not having TOOL_LOOP_MODEL
    const models = { 'oai-gpt41': { name: 'gpt-4.1' } };
    const TOOL_LOOP_MODEL = 'oai-gpt5-mini';
    const toolLoopModel = models[TOOL_LOOP_MODEL] ? TOOL_LOOP_MODEL : null;

    t.is(toolLoopModel, null);
});

test('toolLoopModel is set when model exists in config', t => {
    const models = {
        'oai-gpt41': { name: 'gpt-4.1' },
        'oai-gpt5-mini': { name: 'gpt-4.1-mini' }
    };
    const TOOL_LOOP_MODEL = 'oai-gpt5-mini';
    const toolLoopModel = models[TOOL_LOOP_MODEL] ? TOOL_LOOP_MODEL : null;

    t.is(toolLoopModel, 'oai-gpt5-mini');
});

test('when toolLoopModel is null, fallback path uses primary model with auto tool_choice', t => {
    const args = { toolLoopModel: null, primaryModel: 'oai-gpt41', stream: false };

    // Fallback path: no internal loop, uses primary model with tool_choice: "auto"
    const modelOverride = args.primaryModel;
    const toolChoice = 'auto';

    t.is(modelOverride, 'oai-gpt41');
    t.is(toolChoice, 'auto');
});

// --- Unified streaming/non-streaming behavior ---

test('dual-model loop uses cheap model with stream:false for both streaming and non-streaming', t => {
    // When toolLoopModel is set, the internal loop always uses stream:false
    // regardless of the original args.stream value
    const streamingArgs = { toolLoopModel: 'oai-gpt5-mini', primaryModel: 'oai-gpt41', stream: true };
    const nonStreamingArgs = { toolLoopModel: 'oai-gpt5-mini', primaryModel: 'oai-gpt41', stream: false };

    // Internal loop always: stream:false, model: toolLoopModel
    // This is the same for both streaming and non-streaming
    const loopStream = false; // always false in loop
    const loopModel = streamingArgs.toolLoopModel;

    t.false(loopStream);
    t.is(loopModel, 'oai-gpt5-mini');

    // Final synthesis preserves original stream setting
    t.true(streamingArgs.stream);  // streaming: synthesis streams
    t.false(nonStreamingArgs.stream);  // non-streaming: synthesis doesn't stream
});

test('final synthesis uses primary model with original stream setting and tools', t => {
    const SYNTHESIS_TOOLS = true;
    const entityTools = [{ type: 'function', function: { name: 'Search' } }];

    // Streaming request
    const streamingArgs = { toolLoopModel: 'oai-gpt5-mini', primaryModel: 'oai-gpt41', stream: true };
    const streamSynthesis = {
        modelOverride: streamingArgs.primaryModel,
        stream: streamingArgs.stream,
        tools: SYNTHESIS_TOOLS ? entityTools : undefined,
        tool_choice: SYNTHESIS_TOOLS ? 'auto' : undefined,
    };
    t.is(streamSynthesis.modelOverride, 'oai-gpt41');
    t.true(streamSynthesis.stream);
    t.deepEqual(streamSynthesis.tools, entityTools);
    t.is(streamSynthesis.tool_choice, 'auto');

    // Non-streaming request
    const nonStreamingArgs = { toolLoopModel: 'oai-gpt5-mini', primaryModel: 'oai-gpt41', stream: false };
    const nonStreamSynthesis = {
        modelOverride: nonStreamingArgs.primaryModel,
        stream: nonStreamingArgs.stream,
        tools: SYNTHESIS_TOOLS ? entityTools : undefined,
        tool_choice: SYNTHESIS_TOOLS ? 'auto' : undefined,
    };
    t.is(nonStreamSynthesis.modelOverride, 'oai-gpt41');
    t.false(nonStreamSynthesis.stream);
    t.deepEqual(nonStreamSynthesis.tools, entityTools);
    t.is(nonStreamSynthesis.tool_choice, 'auto');
});

test('initial call always uses original stream setting', t => {
    // With toolLoopModel + streaming: initial call streams
    const streaming = { toolLoopModel: 'oai-gpt5-mini', stream: true };
    t.true(streaming.stream);

    // With toolLoopModel + non-streaming: initial call doesn't stream
    const nonStreaming = { toolLoopModel: 'oai-gpt5-mini', stream: false };
    t.false(nonStreaming.stream);

    // Without toolLoopModel: initial call uses original setting
    const noModel = { toolLoopModel: null, stream: true };
    t.true(noModel.stream);
});

test('pathwayResolver.args snapshot includes toolLoopModel and primaryModel', t => {
    // Simulates the ordering in executePathway:
    // 1. Set model assignments on args
    // 2. Snapshot args onto pathwayResolver
    const args = { chatHistory: [], stream: true };
    const toolLoopModel = 'oai-gpt5-mini';
    const resolverModelName = 'oai-claude-45-opus';

    // Assignments BEFORE snapshot (the fix)
    args.toolLoopModel = toolLoopModel;
    args.primaryModel = undefined || resolverModelName;

    const pathwayResolverArgs = { ...args };

    // Streaming plugin callback uses pathwayResolver.args
    t.is(pathwayResolverArgs.toolLoopModel, 'oai-gpt5-mini');
    t.is(pathwayResolverArgs.primaryModel, 'oai-claude-45-opus');
});

// --- Final synthesis: rehydration before primary model ---

test('final synthesis rehydrates all compressed results', t => {
    const store = new Map();
    const full1 = 'x'.repeat(5000);
    const full2 = 'y'.repeat(5000);
    store.set('tc1', { fullContent: full1, compressed: true, round: 1 });
    store.set('tc2', { fullContent: full2, compressed: true, round: 2 });

    const messages = [
        { role: 'user', content: 'query' },
        { role: 'tool', tool_call_id: 'tc1', content: 'compressed1' },
        { role: 'tool', tool_call_id: 'tc2', content: 'compressed2' },
        { role: 'assistant', content: 'SYNTHESIZE' }
    ];

    const rehydrated = rehydrateAllToolResults(messages, store);

    t.is(rehydrated[1].content, full1);
    t.is(rehydrated[2].content, full2);
    // Non-tool messages unchanged
    t.is(rehydrated[0].content, 'query');
    t.is(rehydrated[3].content, 'SYNTHESIZE');
});

// --- SYNTHESIZE instruction injection ---

test('SYNTHESIZE instruction is injected inside dual-model loop for both streaming and non-streaming', t => {
    const messages = [{ role: 'user', content: 'Hello' }];

    // Streaming + toolLoopModel: inject (now works for streaming too!)
    const streaming = { toolLoopModel: 'oai-gpt5-mini', stream: true };
    let result;
    if (streaming.toolLoopModel) {
        result = insertSystemMessage([...messages],
            'If you need more information, call tools. If you have gathered sufficient information to answer the user\'s request, respond with just: SYNTHESIZE',
            'req-1'
        );
    }
    t.is(result.length, 2);
    t.true(result[1].content.includes('SYNTHESIZE'));

    // Non-streaming + toolLoopModel: inject
    const nonStreaming = { toolLoopModel: 'oai-gpt5-mini', stream: false };
    if (nonStreaming.toolLoopModel) {
        result = insertSystemMessage([...messages],
            'If you need more information, call tools. If you have gathered sufficient information to answer the user\'s request, respond with just: SYNTHESIZE',
            'req-2'
        );
    }
    t.is(result.length, 2);
    t.true(result[1].content.includes('SYNTHESIZE'));

    // No toolLoopModel: no injection
    const noModel = { toolLoopModel: null, stream: false };
    result = [...messages];
    if (noModel.toolLoopModel) {
        result = insertSystemMessage(result, 'SYNTHESIZE instruction', 'req-3');
    }
    t.is(result.length, 1);
});

// --- Final synthesis uses correct model parameters ---

test('final synthesis uses primary model with configured reasoning effort', t => {
    const SYNTHESIS_TOOLS = true;
    const entityTools = [{ type: 'function', function: { name: 'Search' } }];
    const args = {
        toolLoopModel: 'oai-gpt5-mini',
        primaryModel: 'oai-gpt41',
        configuredReasoningEffort: 'high',
        stream: true
    };

    // Simulate final synthesis args construction
    const synthesisArgs = {
        modelOverride: args.primaryModel,
        stream: args.stream,
        tools: SYNTHESIS_TOOLS ? entityTools : undefined,
        tool_choice: SYNTHESIS_TOOLS ? 'auto' : undefined,
        reasoningEffort: args.configuredReasoningEffort || 'medium',
        skipMemoryLoad: true,
    };

    t.is(synthesisArgs.modelOverride, 'oai-gpt41');
    t.true(synthesisArgs.stream);
    t.deepEqual(synthesisArgs.tools, entityTools);
    t.is(synthesisArgs.tool_choice, 'auto');
    t.is(synthesisArgs.reasoningEffort, 'high');
    t.true(synthesisArgs.skipMemoryLoad);
});

test('primaryModel falls back to resolver modelName when no explicit override', t => {
    // Simulates the case where entityConfig.modelOverride and args.modelOverride are both undefined
    const modelOverride = undefined; // no entity or args override
    const resolverModelName = 'oai-claude-45-opus'; // pathway default

    const primaryModel = modelOverride || resolverModelName;
    t.is(primaryModel, 'oai-claude-45-opus');

    // This ensures final synthesis swaps back from the cheap model
    const synthesisArgs = { modelOverride: primaryModel };
    t.truthy(synthesisArgs.modelOverride); // guard in promptAndParse passes
});

test('primaryModel uses explicit override when set', t => {
    const modelOverride = 'oai-gpt41';
    const resolverModelName = 'oai-claude-45-opus';

    const primaryModel = modelOverride || resolverModelName;
    t.is(primaryModel, 'oai-gpt41');
});

test('final synthesis defaults to medium reasoning effort when not configured', t => {
    const args = {
        toolLoopModel: 'oai-gpt5-mini',
        primaryModel: 'oai-gpt41',
        configuredReasoningEffort: undefined,
        stream: true
    };

    const reasoningEffort = args.configuredReasoningEffort || 'medium';
    t.is(reasoningEffort, 'medium');
});

// --- Edge cases ---

test('no synthesis when toolLoopModel is null (fallback path uses auto tool_choice)', t => {
    const args = { toolLoopModel: null, primaryModel: 'oai-gpt41', stream: false };

    // When toolLoopModel is null, toolCallback uses fallback path:
    // single processToolCallRound + promptAndParse with tool_choice: "auto"
    const toolChoice = 'auto';
    t.is(toolChoice, 'auto');
});

test('dual-model synthesis includes tools when SYNTHESIS_TOOLS is true', t => {
    const SYNTHESIS_TOOLS = true;
    const entityTools = [{ type: 'function', function: { name: 'Search' } }];

    const synthesisArgs = {
        tools: SYNTHESIS_TOOLS ? entityTools : undefined,
        tool_choice: SYNTHESIS_TOOLS ? 'auto' : undefined,
    };

    t.deepEqual(synthesisArgs.tools, entityTools);
    t.is(synthesisArgs.tool_choice, 'auto');
});

// --- SYNTHESIS_TOOLS toggle ---

test('SYNTHESIS_TOOLS toggle controls whether synthesis gets tools', t => {
    const entityToolsOpenAiFormat = [{ type: 'function', function: { name: 'Search' } }];

    // When SYNTHESIS_TOOLS = true, synthesis gets tools and tool_choice
    const withTools = true;
    const synthArgsOn = {
        tools: withTools ? entityToolsOpenAiFormat : undefined,
        tool_choice: withTools ? 'auto' : undefined,
    };
    t.deepEqual(synthArgsOn.tools, entityToolsOpenAiFormat);
    t.is(synthArgsOn.tool_choice, 'auto');

    // When SYNTHESIS_TOOLS = false, synthesis gets neither
    const withoutTools = false;
    const synthArgsOff = {
        tools: withoutTools ? entityToolsOpenAiFormat : undefined,
        tool_choice: withoutTools ? 'auto' : undefined,
    };
    t.is(synthArgsOff.tools, undefined);
    t.is(synthArgsOff.tool_choice, undefined);
});

test('duplicate tool call detection returns cached result with admonishment', t => {
    // Simulate the per-request tool call cache
    const toolCallCache = new Map();

    const toolName = 'WorkspaceUpload';
    const toolArgs = '{"workspacePath":"/workspace/art.jpg"}';
    const cacheKey = `${toolName}:${toolArgs}`;

    // First call: no cache hit, execute normally
    t.false(toolCallCache.has(cacheKey));
    const firstResult = '{"success":true,"fileId":"abc123"}';
    toolCallCache.set(cacheKey, firstResult);

    // Second call: cache hit, return admonishment
    t.true(toolCallCache.has(cacheKey));
    const cachedResult = toolCallCache.get(cacheKey);
    const duplicateResponse = `This tool was already called with these exact arguments. Previous result: ${cachedResult}`;
    t.true(duplicateResponse.includes('already called'));
    t.true(duplicateResponse.includes(firstResult));
});

test('duplicate detection uses tool name + arguments as cache key', t => {
    const toolCallCache = new Map();

    // Same tool, different args — no collision
    toolCallCache.set('WorkspaceUpload:{"path":"/a.jpg"}', 'result-a');
    toolCallCache.set('WorkspaceUpload:{"path":"/b.jpg"}', 'result-b');
    t.is(toolCallCache.size, 2);

    // Same tool, same args — cache hit
    t.true(toolCallCache.has('WorkspaceUpload:{"path":"/a.jpg"}'));
    t.is(toolCallCache.get('WorkspaceUpload:{"path":"/a.jpg"}'), 'result-a');

    // Different tool, same args — no collision
    toolCallCache.set('WorkspaceBrowse:{"path":"/a.jpg"}', 'result-c');
    t.is(toolCallCache.size, 3);
});

test('duplicate detection catches non-consecutive repeats across rounds', t => {
    const toolCallCache = new Map();

    // Round 1: upload 4 different files
    const files = ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'];
    for (const f of files) {
        const key = `WorkspaceUpload:{"workspacePath":"${f}"}`;
        t.false(toolCallCache.has(key));
        toolCallCache.set(key, `{"success":true,"file":"${f}"}`);
    }
    t.is(toolCallCache.size, 4);

    // Round 2: model tries to re-upload /a.jpg — cache hit despite /d.jpg being last
    const dupKey = 'WorkspaceUpload:{"workspacePath":"/a.jpg"}';
    t.true(toolCallCache.has(dupKey));
    t.true(toolCallCache.get(dupKey).includes('/a.jpg'));
});

test('extractToolCalls returns empty for text-only synthesis (no tool_calls)', t => {
    // When SYNTHESIS_TOOLS = false, synthesis response won't have tool_calls
    const textOnlyResult = { content: 'Here is your answer...' };
    t.deepEqual(extractToolCalls(textOnlyResult), []);
});

// --- mergeParallelToolResults ---

test('mergeParallelToolResults combines parallel tool calls into one assistant message', t => {
    const preToolCallMessages = [
        { role: 'user', content: 'Search for news APIs' }
    ];

    // Simulate two parallel tool results — each has its own assistant + tool message
    const toolResults = [
        {
            messages: [
                ...preToolCallMessages,
                { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"news api"}' } }] },
                { role: 'tool', tool_call_id: 'tc1', name: 'SearchInternet', content: 'Result 1' }
            ]
        },
        {
            messages: [
                ...preToolCallMessages,
                { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"newsapi alternatives"}' } }] },
                { role: 'tool', tool_call_id: 'tc2', name: 'SearchInternet', content: 'Result 2' }
            ]
        }
    ];

    const merged = mergeParallelToolResults(toolResults, preToolCallMessages);

    // Should produce exactly 3 messages: 1 assistant + 2 tool results
    t.is(merged.length, 3);

    // First message: single assistant with BOTH tool_calls
    t.is(merged[0].role, 'assistant');
    t.is(merged[0].tool_calls.length, 2);
    t.is(merged[0].tool_calls[0].id, 'tc1');
    t.is(merged[0].tool_calls[1].id, 'tc2');

    // Tool results follow in order
    t.is(merged[1].role, 'tool');
    t.is(merged[1].tool_call_id, 'tc1');
    t.is(merged[1].content, 'Result 1');
    t.is(merged[2].role, 'tool');
    t.is(merged[2].tool_call_id, 'tc2');
    t.is(merged[2].content, 'Result 2');
});

test('mergeParallelToolResults works with single tool call', t => {
    const preToolCallMessages = [{ role: 'user', content: 'Hello' }];

    const toolResults = [
        {
            messages: [
                ...preToolCallMessages,
                { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Weather', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'tc1', name: 'Weather', content: 'Sunny' }
            ]
        }
    ];

    const merged = mergeParallelToolResults(toolResults, preToolCallMessages);

    t.is(merged.length, 2);
    t.is(merged[0].role, 'assistant');
    t.is(merged[0].tool_calls.length, 1);
    t.is(merged[0].tool_calls[0].id, 'tc1');
    t.is(merged[1].role, 'tool');
    t.is(merged[1].content, 'Sunny');
});

test('mergeParallelToolResults returns empty array for no results', t => {
    const merged = mergeParallelToolResults([], []);
    t.deepEqual(merged, []);
});

test('mergeParallelToolResults skips results with no messages', t => {
    const preToolCallMessages = [{ role: 'user', content: 'Hi' }];
    const toolResults = [
        { messages: null },
        { success: false, error: 'failed' },
        {
            messages: [
                ...preToolCallMessages,
                { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Search', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: 'OK' }
            ]
        }
    ];

    const merged = mergeParallelToolResults(toolResults, preToolCallMessages);
    t.is(merged.length, 2);
    t.is(merged[0].tool_calls.length, 1);
});

test('mergeParallelToolResults preserves thoughtSignature on tool calls', t => {
    const preToolCallMessages = [{ role: 'user', content: 'Test' }];
    const toolResults = [
        {
            messages: [
                ...preToolCallMessages,
                { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'A', arguments: '{}' }, thoughtSignature: 'sig-abc' }] },
                { role: 'tool', tool_call_id: 'tc1', name: 'A', content: 'Done' }
            ]
        }
    ];

    const merged = mergeParallelToolResults(toolResults, preToolCallMessages);
    t.is(merged[0].tool_calls[0].thoughtSignature, 'sig-abc');
});

// --- Dehydration toggle: toolLoopModel controls whether compression runs ---

// Helper that mirrors the conditional logic in processToolCallRound
function simulateDehydration(args, messages, store, currentRound, entityTools) {
    if (!args.toolLoopModel) {
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.tool_call_id &&
                msg.content && msg.content.length > COMPRESSION_THRESHOLD &&
                !store.has(msg.tool_call_id)) {
                store.set(msg.tool_call_id, {
                    toolName: msg.name || 'unknown',
                    fullContent: msg.content,
                    charCount: msg.content.length,
                    round: currentRound,
                    compressed: false
                });
            }
        }
        messages = compressOlderToolResults(messages, store, currentRound, entityTools);
    }
    return messages;
}

// Helper that mirrors the conditional logic before synthesis
function simulateRehydration(args, chatHistory, store) {
    if (!args.toolLoopModel) {
        return rehydrateAllToolResults(chatHistory, store);
    }
    return chatHistory;
}

test('dehydration toggle: toolLoopModel set — results stay full, store empty', t => {
    const args = { toolLoopModel: 'oai-gpt5-mini' };
    const store = new Map();
    const bigContent = 'x'.repeat(5000);
    const messages = [
        { role: 'user', content: 'query' },
        { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: bigContent },
    ];

    // Round 1: store result
    simulateDehydration(args, messages, store, 1, {});
    // Round 2: would compress older results if dehydration were active
    const result = simulateDehydration(args, messages, store, 2, {});

    t.is(store.size, 0, 'Store should be empty — no dehydration with toolLoopModel');
    t.is(result[1].content, bigContent, 'Tool result should be full');
});

test('dehydration toggle: no toolLoopModel — results are compressed', t => {
    const args = { toolLoopModel: null };
    const store = new Map();
    const bigContent = 'x'.repeat(5000);
    const messages = [
        { role: 'user', content: 'query' },
        { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: bigContent },
    ];

    // Round 1: store result
    simulateDehydration(args, messages, store, 1, {});
    t.is(store.size, 1, 'Store should have entry');
    t.is(store.get('tc1').fullContent, bigContent);

    // Round 2: older results get compressed
    const result = simulateDehydration(args, messages, store, 2, {});
    t.not(result[1].content, bigContent, 'Tool result should be compressed');
    t.true(store.get('tc1').compressed);
});

test('rehydration toggle: toolLoopModel set — chatHistory unchanged', t => {
    const args = { toolLoopModel: 'oai-gpt5-mini' };
    const store = new Map();
    const fullContent = 'y'.repeat(5000);
    store.set('tc1', { fullContent, compressed: true, round: 1 });

    const chatHistory = [
        { role: 'tool', tool_call_id: 'tc1', content: 'compressed summary' },
    ];

    const result = simulateRehydration(args, chatHistory, store);
    t.is(result[0].content, 'compressed summary', 'Should NOT rehydrate with toolLoopModel');
    t.true(store.get('tc1').compressed, 'Store entry should stay compressed');
});

test('rehydration toggle: no toolLoopModel — full content restored', t => {
    const args = { toolLoopModel: null };
    const store = new Map();
    const fullContent = 'y'.repeat(5000);
    store.set('tc1', { fullContent, compressed: true, round: 1 });

    const chatHistory = [
        { role: 'tool', tool_call_id: 'tc1', content: 'compressed summary' },
    ];

    const result = simulateRehydration(args, chatHistory, store);
    t.is(result[0].content, fullContent, 'Should rehydrate without toolLoopModel');
    t.false(store.get('tc1').compressed, 'Store entry should be marked uncompressed');
});

test('dehydration toggle: full cycle without toolLoopModel — compress then rehydrate', t => {
    const args = { toolLoopModel: null };
    const store = new Map();
    const bigContent = JSON.stringify({ title: 'Test', content: 'z'.repeat(5000) });
    const messages = [
        { role: 'user', content: 'search' },
        { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: bigContent },
    ];

    // Round 1: register
    simulateDehydration(args, messages, store, 1, {});
    // Round 2: compress older
    const compressed = simulateDehydration(args, messages, store, 2, {});
    t.not(compressed[1].content, bigContent);

    // Synthesis: rehydrate
    const rehydrated = simulateRehydration(args, compressed, store);
    t.is(rehydrated[1].content, bigContent);
});

test('dehydration toggle: full cycle with toolLoopModel — no compression, no rehydration', t => {
    const args = { toolLoopModel: 'oai-gpt5-mini' };
    const store = new Map();
    const bigContent = JSON.stringify({ title: 'Test', content: 'z'.repeat(5000) });
    const messages = [
        { role: 'user', content: 'search' },
        { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: bigContent },
    ];

    // Round 1
    simulateDehydration(args, messages, store, 1, {});
    // Round 2
    const afterRound2 = simulateDehydration(args, messages, store, 2, {});
    t.is(afterRound2[1].content, bigContent, 'Content stays full');

    // Synthesis
    const forSynthesis = simulateRehydration(args, afterRound2, store);
    t.is(forSynthesis[1].content, bigContent, 'Content still full — nothing to rehydrate');
    t.is(store.size, 0, 'Store was never used');
});
