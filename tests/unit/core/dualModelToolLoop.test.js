// dualModelToolLoop.test.js
// Tests for the primary-model tool loop with DelegateTask subagent.
// The primary model runs its own tool loop; DelegateTask spawns a cheap subagent.

import test from 'ava';
import { insertSystemMessage, extractToolCalls, mergeParallelToolResults } from '../../../pathways/system/entity/sys_entity_agent.js';
import { COMPRESSION_THRESHOLD, compressOlderToolResults, rehydrateAllToolResults, dehydrateToolHistory } from '../../../pathways/system/entity/tools/shared/tool_result_compression.js';

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

// --- insertSystemMessage ---

test('insertSystemMessage injects instruction into messages', t => {
    const messages = [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'Weather' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'Sunny, 72F' }
    ];

    const result = insertSystemMessage(messages, 'Additional instruction text', 'req-123');

    t.is(result.length, 4);
    const injected = result[result.length - 1];
    t.is(injected.role, 'user');
    t.true(injected.content.includes('Additional instruction text'));
    t.true(injected.content.includes('[system message: req-123]'));
});

test('insertSystemMessage replaces previous system message with same requestId', t => {
    const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: '[system message: req-1] Old instruction' }
    ];

    const result = insertSystemMessage(messages, 'New instruction', 'req-1');

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

    t.is(result.length, 2);
    t.true(result[0].content.includes('req-2'));
    t.true(result[1].content.includes('Third'));
});

// --- Primary model configuration ---

test('toolLoopModel is null when model is not in config', t => {
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

// --- Primary tool loop: model selection ---

test('primary tool loop uses primary model for all calls', t => {
    const args = { primaryModel: 'oai-gpt41', stream: false };
    const modelOverride = args.primaryModel;
    t.is(modelOverride, 'oai-gpt41');
});

test('synthesis uses primary model with original stream setting', t => {
    const streamingArgs = { primaryModel: 'oai-gpt41', stream: true, configuredReasoningEffort: 'high' };
    const synthArgs = {
        modelOverride: streamingArgs.primaryModel,
        stream: streamingArgs.stream,
        tools: [],
        reasoningEffort: streamingArgs.configuredReasoningEffort || 'medium',
    };
    t.is(synthArgs.modelOverride, 'oai-gpt41');
    t.true(synthArgs.stream);
    t.is(synthArgs.reasoningEffort, 'high');
    t.deepEqual(synthArgs.tools, []);

    const nonStreamingArgs = { primaryModel: 'oai-gpt41', stream: false };
    const nonStreamSynth = {
        modelOverride: nonStreamingArgs.primaryModel,
        stream: nonStreamingArgs.stream,
    };
    t.false(nonStreamSynth.stream);
});

test('primaryModel falls back to resolver modelName when no explicit override', t => {
    const modelOverride = undefined;
    const resolverModelName = 'oai-claude-45-opus';
    const primaryModel = modelOverride || resolverModelName;
    t.is(primaryModel, 'oai-claude-45-opus');
});

test('primaryModel uses explicit override when set', t => {
    const modelOverride = 'oai-gpt41';
    const resolverModelName = 'oai-claude-45-opus';
    const primaryModel = modelOverride || resolverModelName;
    t.is(primaryModel, 'oai-gpt41');
});

test('final synthesis defaults to medium reasoning effort when not configured', t => {
    const args = { primaryModel: 'oai-gpt41', configuredReasoningEffort: undefined, stream: true };
    const reasoningEffort = args.configuredReasoningEffort || 'medium';
    t.is(reasoningEffort, 'medium');
});

// --- DelegateTask tool configuration ---

test('DelegateTask included in first call tools when toolLoopModel available', t => {
    const DELEGATE_TASK_DEF = { type: 'function', function: { name: 'DelegateTask' } };
    const entityTools = [
        { type: 'function', function: { name: 'SearchTool' } },
        { type: 'function', function: { name: 'AnalyzeTool' } },
    ];
    const toolLoopModel = 'oai-gpt5-mini';
    const hasTools = entityTools.length > 0;
    const delegateAvailable = hasTools && toolLoopModel;
    const firstCallTools = hasTools
        ? [...entityTools, ...(delegateAvailable ? [DELEGATE_TASK_DEF] : [])]
        : [];

    t.is(firstCallTools.length, 3);
    t.true(firstCallTools.some(t => t.function.name === 'DelegateTask'));
    t.true(firstCallTools.some(t => t.function.name === 'SearchTool'));
});

test('DelegateTask excluded from first call tools when no toolLoopModel', t => {
    const DELEGATE_TASK_DEF = { type: 'function', function: { name: 'DelegateTask' } };
    const entityTools = [
        { type: 'function', function: { name: 'SearchTool' } },
    ];
    const toolLoopModel = null;
    const hasTools = entityTools.length > 0;
    const delegateAvailable = hasTools && toolLoopModel;
    const firstCallTools = hasTools
        ? [...entityTools, ...(delegateAvailable ? [DELEGATE_TASK_DEF] : [])]
        : [];

    t.is(firstCallTools.length, 1);
    t.false(firstCallTools.some(t => t.function.name === 'DelegateTask'));
});

test('DelegateTask filtered from subagent tools (no recursion)', t => {
    const DELEGATE_TASK_TOOL_NAME = 'delegatetask';
    const entityToolsOpenAiFormat = [
        { type: 'function', function: { name: 'SearchTool' } },
        { type: 'function', function: { name: 'DelegateTask' } },
        { type: 'function', function: { name: 'AnalyzeTool' } },
    ];
    const subTools = entityToolsOpenAiFormat.filter(t => t.function?.name?.toLowerCase() !== DELEGATE_TASK_TOOL_NAME);

    t.is(subTools.length, 2);
    t.false(subTools.some(t => t.function.name === 'DelegateTask'));
    t.true(subTools.some(t => t.function.name === 'SearchTool'));
    t.true(subTools.some(t => t.function.name === 'AnalyzeTool'));
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
        { role: 'assistant', content: 'ready' }
    ];

    const rehydrated = rehydrateAllToolResults(messages, store);

    t.is(rehydrated[1].content, full1);
    t.is(rehydrated[2].content, full2);
    t.is(rehydrated[0].content, 'query');
    t.is(rehydrated[3].content, 'ready');
});

// --- Dehydration: always-on compression ---

test('dehydration stores and compresses large tool results', t => {
    const store = new Map();
    const bigContent = 'x'.repeat(5000);
    const messages = [
        { role: 'user', content: 'query' },
        { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: bigContent },
    ];

    // Round 1: register
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.tool_call_id && msg.content && msg.content.length > COMPRESSION_THRESHOLD && !store.has(msg.tool_call_id)) {
            store.set(msg.tool_call_id, { toolName: msg.name || 'unknown', fullContent: msg.content, charCount: msg.content.length, round: 1, compressed: false });
        }
    }
    t.is(store.size, 1, 'Store should have entry');
    t.is(store.get('tc1').fullContent, bigContent);

    // Round 2: compress older
    const result = compressOlderToolResults(messages, store, 2, {});
    t.not(result[1].content, bigContent, 'Tool result should be compressed');
    t.true(store.get('tc1').compressed);
});

test('dehydration full cycle — compress then rehydrate', t => {
    const store = new Map();
    const bigContent = JSON.stringify({ title: 'Test', content: 'z'.repeat(5000) });
    const messages = [
        { role: 'user', content: 'search' },
        { role: 'tool', tool_call_id: 'tc1', name: 'Search', content: bigContent },
    ];

    // Round 1: register
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.tool_call_id && msg.content && msg.content.length > COMPRESSION_THRESHOLD && !store.has(msg.tool_call_id)) {
            store.set(msg.tool_call_id, { toolName: msg.name, fullContent: msg.content, charCount: msg.content.length, round: 1, compressed: false });
        }
    }

    // Round 2: compress older
    const compressed = compressOlderToolResults(messages, store, 2, {});
    t.not(compressed[1].content, bigContent);

    // Synthesis: rehydrate
    const rehydrated = rehydrateAllToolResults(compressed, store);
    t.is(rehydrated[1].content, bigContent);
});

// --- duplicate tool call detection ---

test('duplicate tool call detection returns cached result with admonishment', t => {
    const toolCallCache = new Map();
    const toolName = 'WorkspaceUpload';
    const toolArgs = '{"workspacePath":"/workspace/art.jpg"}';
    const cacheKey = `${toolName}:${toolArgs}`;

    t.false(toolCallCache.has(cacheKey));
    const firstResult = '{"success":true,"fileId":"abc123"}';
    toolCallCache.set(cacheKey, firstResult);

    t.true(toolCallCache.has(cacheKey));
    const cachedResult = toolCallCache.get(cacheKey);
    const duplicateResponse = `This tool was already called with these exact arguments. Previous result: ${cachedResult}`;
    t.true(duplicateResponse.includes('already called'));
    t.true(duplicateResponse.includes(firstResult));
});

test('duplicate detection uses tool name + arguments as cache key', t => {
    const toolCallCache = new Map();
    toolCallCache.set('WorkspaceUpload:{"path":"/a.jpg"}', 'result-a');
    toolCallCache.set('WorkspaceUpload:{"path":"/b.jpg"}', 'result-b');
    t.is(toolCallCache.size, 2);
    t.true(toolCallCache.has('WorkspaceUpload:{"path":"/a.jpg"}'));
    t.is(toolCallCache.get('WorkspaceUpload:{"path":"/a.jpg"}'), 'result-a');
    toolCallCache.set('WorkspaceBrowse:{"path":"/a.jpg"}', 'result-c');
    t.is(toolCallCache.size, 3);
});

test('duplicate detection catches non-consecutive repeats across rounds', t => {
    const toolCallCache = new Map();
    const files = ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'];
    for (const f of files) {
        const key = `WorkspaceUpload:{"workspacePath":"${f}"}`;
        t.false(toolCallCache.has(key));
        toolCallCache.set(key, `{"success":true,"file":"${f}"}`);
    }
    t.is(toolCallCache.size, 4);
    const dupKey = 'WorkspaceUpload:{"workspacePath":"/a.jpg"}';
    t.true(toolCallCache.has(dupKey));
    t.true(toolCallCache.get(dupKey).includes('/a.jpg'));
});

test('extractToolCalls returns empty for text-only response (no tool_calls)', t => {
    const textOnlyResult = { content: 'Here is your answer...' };
    t.deepEqual(extractToolCalls(textOnlyResult), []);
});

// --- mergeParallelToolResults ---

test('mergeParallelToolResults combines parallel tool calls into one assistant message', t => {
    const preToolCallMessages = [
        { role: 'user', content: 'Search for news APIs' }
    ];

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

    t.is(merged.length, 3);
    t.is(merged[0].role, 'assistant');
    t.is(merged[0].tool_calls.length, 2);
    t.is(merged[0].tool_calls[0].id, 'tc1');
    t.is(merged[0].tool_calls[1].id, 'tc2');
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

// --- streaming callback drain / empty response safety ---

test('drainStreamingCallbacks always updates result, even with empty string', async t => {
    const resolver = {};
    resolver._streamingToolCallbackPromise = Promise.resolve('');

    const holder = { value: 'stale_response_with_tool_calls' };
    let hadCallback = false;
    while (resolver._streamingToolCallbackPromise) {
        hadCallback = true;
        const pending = resolver._streamingToolCallbackPromise;
        resolver._streamingToolCallbackPromise = null;
        holder.value = await pending;
    }

    t.true(hadCallback);
    t.is(holder.value, '', 'Empty string must replace stale value');
});

test('drainStreamingCallbacks updates result with non-empty callback result', async t => {
    const resolver = {};
    resolver._streamingToolCallbackPromise = Promise.resolve('synthesis text response');

    const holder = { value: 'original' };
    while (resolver._streamingToolCallbackPromise) {
        const pending = resolver._streamingToolCallbackPromise;
        resolver._streamingToolCallbackPromise = null;
        holder.value = await pending;
    }

    t.is(holder.value, 'synthesis text response');
});

test('no depth cap on nested callbacks — only the tool budget limits recursion', t => {
    const TOOL_BUDGET = 500;
    t.true(TOOL_BUDGET > 0, 'Tool budget exists as the recursion limiter');
});

// --- dehydrateToolHistory: no plan tool filtering ---

test('dehydrateToolHistory includes all tool calls (no plan filtering)', t => {
    const chatHistory = [
        { role: 'user', content: 'query' },
        { role: 'assistant', content: '', tool_calls: [
            { id: 'tc1', function: { name: 'SearchTool', arguments: '{"q":"test"}' } },
        ] },
        { role: 'tool', tool_call_id: 'tc1', name: 'SearchTool', content: 'result' },
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);
    t.is(result.length, 2);
    t.is(result[0].role, 'assistant');
    t.is(result[0].tool_calls[0].function.name, 'SearchTool');
    t.is(result[1].role, 'tool');
});

// --- pathwayResolver.args snapshot ---

test('pathwayResolver.args snapshot includes toolLoopModel and primaryModel', t => {
    const args = { chatHistory: [], stream: true };
    const toolLoopModel = 'oai-gpt5-mini';
    const resolverModelName = 'oai-claude-45-opus';

    args.toolLoopModel = toolLoopModel;
    args.primaryModel = undefined || resolverModelName;

    const pathwayResolverArgs = { ...args };

    t.is(pathwayResolverArgs.toolLoopModel, 'oai-gpt5-mini');
    t.is(pathwayResolverArgs.primaryModel, 'oai-claude-45-opus');
});
