import test from 'ava';
import { dehydrateToolHistory, defaultSummarize, COMPRESSION_THRESHOLD } from '../../pathways/system/entity/tools/shared/tool_result_compression.js';
import { sliceByTurns } from '../../pathways/system/entity/sys_entity_agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeToolCall = (name, id, args = {}) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
});

const makeAssistantWithTools = (toolCalls, content = '') => ({
    role: 'assistant',
    content,
    tool_calls: toolCalls,
});

const makeToolResponse = (toolCallId, name, content) => ({
    role: 'tool',
    tool_call_id: toolCallId,
    name,
    content,
});

const makeUserMessage = (content) => ({ role: 'user', content });
const makeAssistantMessage = (content) => ({ role: 'assistant', content });

// ─── dehydrateToolHistory tests ─────────────────────────────────────────────

test('dehydrateToolHistory: extracts tool_call/tool_response pairs', (t) => {
    const chatHistory = [
        makeUserMessage('hello'),
        makeAssistantWithTools([makeToolCall('GoogleSearch', 'tc-1', { q: 'test' })]),
        makeToolResponse('tc-1', 'GoogleSearch', 'search results here'),
        makeAssistantMessage('Here are the results.'),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);

    t.is(result.length, 2);
    t.is(result[0].role, 'assistant');
    t.is(result[0].tool_calls.length, 1);
    t.is(result[0].tool_calls[0].function.name, 'GoogleSearch');
    t.is(result[1].role, 'tool');
    t.is(result[1].tool_call_id, 'tc-1');
    t.is(result[1].name, 'GoogleSearch');
    t.is(result[1].content, 'search results here');
});

test('dehydrateToolHistory: strips SetGoals tool_calls and responses', (t) => {
    const chatHistory = [
        makeAssistantWithTools([
            makeToolCall('SetGoals', 'plan-1', { goal: 'test', steps: ['a'] }),
            makeToolCall('GoogleSearch', 'tc-1', { q: 'test' }),
        ]),
        makeToolResponse('plan-1', 'SetGoals', 'acknowledged'),
        makeToolResponse('tc-1', 'GoogleSearch', 'results'),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);

    t.is(result.length, 2); // 1 assistant + 1 tool response
    t.is(result[0].tool_calls.length, 1);
    t.is(result[0].tool_calls[0].function.name, 'GoogleSearch');
    // SetGoals response should not appear
    t.true(result.every(m => m.name !== 'SetGoals'));
});

test('dehydrateToolHistory: skips assistant messages with only SetGoals', (t) => {
    const chatHistory = [
        makeAssistantWithTools([makeToolCall('SetGoals', 'plan-1', { goal: 'test', steps: ['a'] })]),
        makeToolResponse('plan-1', 'SetGoals', 'acknowledged'),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);
    t.is(result.length, 0);
});

test('dehydrateToolHistory: compresses large tool results', (t) => {
    const largeContent = 'x'.repeat(COMPRESSION_THRESHOLD + 100);
    const chatHistory = [
        makeAssistantWithTools([makeToolCall('GoogleSearch', 'tc-1', { q: 'test' })]),
        makeToolResponse('tc-1', 'GoogleSearch', largeContent),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);

    t.is(result.length, 2);
    t.true(result[1].content.length < largeContent.length, 'result should be compressed');
});

test('dehydrateToolHistory: uses entity tool summarize when available', (t) => {
    const chatHistory = [
        makeAssistantWithTools([makeToolCall('CustomTool', 'tc-1', {})]),
        makeToolResponse('tc-1', 'CustomTool', 'x'.repeat(COMPRESSION_THRESHOLD + 100)),
    ];

    const entityTools = {
        customtool: {
            summarize: (content) => 'custom-summary',
        },
    };

    const result = dehydrateToolHistory(chatHistory, entityTools, 0);
    t.is(result[1].content, 'custom-summary');
});

test('dehydrateToolHistory: respects startIndex', (t) => {
    const chatHistory = [
        // Pre-existing history (before tool loop)
        makeAssistantWithTools([makeToolCall('OldTool', 'old-1', {})]),
        makeToolResponse('old-1', 'OldTool', 'old result'),
        // New tool loop (starts at index 2)
        makeAssistantWithTools([makeToolCall('NewTool', 'new-1', {})]),
        makeToolResponse('new-1', 'NewTool', 'new result'),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 2);

    t.is(result.length, 2);
    t.is(result[0].tool_calls[0].function.name, 'NewTool');
});

test('dehydrateToolHistory: caps at 10 pairs', (t) => {
    const chatHistory = [];
    for (let i = 0; i < 12; i++) {
        chatHistory.push(makeAssistantWithTools([makeToolCall(`Tool${i}`, `tc-${i}`, {})]));
        chatHistory.push(makeToolResponse(`tc-${i}`, `Tool${i}`, `result ${i}`));
    }

    const result = dehydrateToolHistory(chatHistory, {}, 0);

    // Count assistant messages in result
    const assistantCount = result.filter(m => m.role === 'assistant').length;
    t.is(assistantCount, 10, 'should cap at 10 assistant tool_call groups');
});

test('dehydrateToolHistory: handles parallel tool calls', (t) => {
    const chatHistory = [
        makeAssistantWithTools([
            makeToolCall('GoogleSearch', 'tc-1', { q: 'a' }),
            makeToolCall('GoogleNews', 'tc-2', { q: 'b' }),
        ]),
        makeToolResponse('tc-1', 'GoogleSearch', 'results a'),
        makeToolResponse('tc-2', 'GoogleNews', 'results b'),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);

    t.is(result.length, 3); // 1 assistant + 2 tool responses
    t.is(result[0].tool_calls.length, 2);
});

test('dehydrateToolHistory: returns empty array when no tool calls', (t) => {
    const chatHistory = [
        makeUserMessage('hello'),
        makeAssistantMessage('hi there'),
    ];

    const result = dehydrateToolHistory(chatHistory, {}, 0);
    t.deepEqual(result, []);
});

// ─── sliceByTurns tests ────────────────────────────────────────────────────

test('sliceByTurns: keeps last N turns', (t) => {
    const messages = [
        makeUserMessage('turn 1'), makeAssistantMessage('reply 1'),
        makeUserMessage('turn 2'), makeAssistantMessage('reply 2'),
        makeUserMessage('turn 3'), makeAssistantMessage('reply 3'),
        makeUserMessage('turn 4'), makeAssistantMessage('reply 4'),
    ];

    const result = sliceByTurns(messages, 2);

    // Should keep last 2 turns (turn 3, turn 4)
    t.is(result.length, 4);
    t.is(result[0].content, 'turn 3');
});

test('sliceByTurns: preserves tool_call/tool_response pairs', (t) => {
    const messages = [
        makeUserMessage('turn 1'),
        makeAssistantWithTools([makeToolCall('Search', 'tc-1', {})]),
        makeToolResponse('tc-1', 'Search', 'results'),
        makeAssistantMessage('reply 1'),
        makeUserMessage('turn 2'),
        makeAssistantMessage('reply 2'),
    ];

    const result = sliceByTurns(messages, 2);

    // Both turns should be kept, tool pair should be intact
    t.is(result.length, 6);
    t.true(result.some(m => m.role === 'tool' && m.tool_call_id === 'tc-1'));
    t.true(result.some(m => m.tool_calls?.[0]?.id === 'tc-1'));
});

test('sliceByTurns: filters orphaned tool responses', (t) => {
    const messages = [
        // Turn 1 - the assistant tool_call is before the cut
        makeUserMessage('turn 1'),
        makeAssistantWithTools([makeToolCall('Search', 'tc-old', {})]),
        makeToolResponse('tc-old', 'Search', 'old results'),
        makeAssistantMessage('reply 1'),
        // Turn 2
        makeUserMessage('turn 2'),
        makeAssistantMessage('reply 2'),
        // Turn 3
        makeUserMessage('turn 3'),
        makeAssistantMessage('reply 3'),
    ];

    const result = sliceByTurns(messages, 2);

    // Should keep turns 2 and 3, orphaned tool response from turn 1 should be gone
    t.false(result.some(m => m.tool_call_id === 'tc-old'), 'orphaned tool response should be filtered');
});

test('sliceByTurns: returns all messages when fewer than maxTurns', (t) => {
    const messages = [
        makeUserMessage('turn 1'), makeAssistantMessage('reply 1'),
        makeUserMessage('turn 2'), makeAssistantMessage('reply 2'),
    ];

    const result = sliceByTurns(messages, 10);
    t.is(result.length, 4);
});

test('sliceByTurns: handles empty input', (t) => {
    t.deepEqual(sliceByTurns([], 10), []);
    t.deepEqual(sliceByTurns(null, 10), null);
    t.deepEqual(sliceByTurns(undefined, 10), undefined);
});

test('sliceByTurns: handles messages with no user messages', (t) => {
    const messages = [
        makeAssistantMessage('system init'),
        makeAssistantMessage('another message'),
    ];

    const result = sliceByTurns(messages, 10);
    t.is(result.length, 2, 'should keep all messages when no user messages');
});

test('sliceByTurns: handles stringified tool_calls from GraphQL', (t) => {
    // GraphQL sends tool_calls as array of JSON strings
    const messages = [
        makeUserMessage('turn 1'),
        {
            role: 'assistant',
            content: '',
            tool_calls: [JSON.stringify({ id: 'tc-1', type: 'function', function: { name: 'Search', arguments: '{}' } })],
        },
        makeToolResponse('tc-1', 'Search', 'results'),
        makeAssistantMessage('reply 1'),
        makeUserMessage('turn 2'),
        makeAssistantMessage('reply 2'),
    ];

    const result = sliceByTurns(messages, 2);

    // Both turns should be kept, tool pair should be intact even with stringified tool_calls
    t.is(result.length, 6);
    t.true(result.some(m => m.role === 'tool' && m.tool_call_id === 'tc-1'));

    // Stringified tool_calls must be normalized to objects (prevents downstream .function.name crashes)
    const assistantWithToolCalls = result.find(m => m.tool_calls);
    t.truthy(assistantWithToolCalls);
    t.is(typeof assistantWithToolCalls.tool_calls[0], 'object');
    t.is(assistantWithToolCalls.tool_calls[0].function.name, 'Search');
});
