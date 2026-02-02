// toolCallsParsing.test.js
// Tests for tool_calls parsing from strings to objects in plugins
// and tool message content array to text content parts array conversion

import test from 'ava';
import OpenAIVisionPlugin from '../../../server/plugins/openAiVisionPlugin.js';
import GrokVisionPlugin from '../../../server/plugins/grokVisionPlugin.js';
import Gemini15VisionPlugin from '../../../server/plugins/gemini15VisionPlugin.js';
import Gemini3ReasoningVisionPlugin from '../../../server/plugins/gemini3ReasoningVisionPlugin.js';

const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt',
    toolCallback: () => {}
};

const mockModel = {
    name: 'test-model',
    type: 'OPENAI-VISION',
    maxTokenLength: 4096,
    maxReturnTokens: 256
};

test('OpenAIVisionPlugin - parses tool_calls from string array to object array', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const toolCallString = JSON.stringify({
        id: 'call_123',
        type: 'function',
        function: {
            name: 'test_function',
            arguments: '{"param": "value"}'
        }
    });
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCallString] // String array as would come from GraphQL/REST
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'assistant');
    t.truthy(result[0].tool_calls);
    t.is(result[0].tool_calls.length, 1);
    t.is(typeof result[0].tool_calls[0], 'object'); // Should be parsed to object
    t.is(result[0].tool_calls[0].id, 'call_123');
    t.is(result[0].tool_calls[0].type, 'function');
    t.is(result[0].tool_calls[0].function.name, 'test_function');
});

test('OpenAIVisionPlugin - handles tool_calls that are already objects', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: 'call_123',
                type: 'function',
                function: {
                    name: 'test_function',
                    arguments: '{"param": "value"}'
                }
            }] // Already objects
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].tool_calls.length, 1);
    t.is(result[0].tool_calls[0].id, 'call_123');
});

test('OpenAIVisionPlugin - converts tool message content array to text content parts array', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'tool',
            content: ['Result 1', 'Result 2'], // Array of strings as would come from REST
            tool_call_id: 'call_123'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'tool');
    t.true(Array.isArray(result[0].content)); // Should be converted to array of text content parts
    t.is(result[0].content.length, 2);
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Result 1');
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, 'Result 2');
});

test('OpenAIVisionPlugin - preserves tool message with content text parts array', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'tool',
            content: [
                { type: 'text', text: 'Result 1' },
                { type: 'text', text: 'Result 2' }
            ],
            tool_call_id: 'call_123'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.true(Array.isArray(result[0].content)); // Should preserve array format
    t.is(result[0].content.length, 2);
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Result 1');
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, 'Result 2');
});

test('OpenAIVisionPlugin - preserves tool message with string content', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'tool',
            content: 'Simple text result',
            tool_call_id: 'call_123'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(typeof result[0].content, 'string'); // Should preserve string format
    t.is(result[0].content, 'Simple text result');
});

test('GrokVisionPlugin - parses tool_calls from string array to object array', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    const toolCallString = JSON.stringify({
        id: 'call_456',
        type: 'function',
        function: {
            name: 'grok_function',
            arguments: '{"query": "test"}'
        }
    });
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCallString]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].tool_calls.length, 1);
    t.is(typeof result[0].tool_calls[0], 'object');
    t.is(result[0].tool_calls[0].id, 'call_456');
});

test('GrokVisionPlugin - converts tool message content array to text content parts array', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    const messages = [
        {
            role: 'tool',
            content: ['Grok result 1', 'Grok result 2'],
            tool_call_id: 'call_456'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.true(Array.isArray(result[0].content)); // Should be converted to array of text content parts
    t.is(result[0].content.length, 2);
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Grok result 1');
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, 'Grok result 2');
});

test('Gemini 2.5 Vision Plugin - converts tool message content array to string', async (t) => {
    const plugin = new Gemini15VisionPlugin(mockPathway, { ...mockModel, type: 'GEMINI-1.5-VISION' });
    
    const messages = [
        {
            role: 'tool',
            content: ['Gemini result 1', 'Gemini result 2'],
            tool_call_id: 'call_789'
        }
    ];
    
    const result = plugin.convertMessagesToGemini(messages);
    
    // Check that the tool message was converted properly
    const toolMessage = result.modifiedMessages.find(msg => msg.role === 'function');
    t.truthy(toolMessage);
    t.is(typeof toolMessage.parts[0].functionResponse.response.content, 'string');
    t.is(toolMessage.parts[0].functionResponse.response.content, 'Gemini result 1\nGemini result 2');
});

test('OpenAIVisionPlugin - handles mixed tool_calls (strings and objects)', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const toolCall1String = JSON.stringify({
        id: 'call_1',
        type: 'function',
        function: { name: 'func1', arguments: '{}' }
    });
    
    const toolCall2Object = {
        id: 'call_2',
        type: 'function',
        function: { name: 'func2', arguments: '{}' }
    };
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall1String, toolCall2Object] // Mixed
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result[0].tool_calls.length, 2);
    t.is(typeof result[0].tool_calls[0], 'object'); // Parsed from string
    t.is(typeof result[0].tool_calls[1], 'object'); // Already object
    t.is(result[0].tool_calls[0].id, 'call_1');
    t.is(result[0].tool_calls[1].id, 'call_2');
});

test('OpenAIVisionPlugin - converts non-whitelisted JSON objects in content arrays to text', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    // Create a JSON object that is NOT a whitelisted content type
    const nonWhitelistedObject = {
        customType: 'metadata',
        data: { key: 'value', nested: { info: 'test' } }
    };
    
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Hello' }, // Valid whitelisted type
                JSON.stringify(nonWhitelistedObject), // JSON string of non-whitelisted object
                nonWhitelistedObject // Direct object (not whitelisted)
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(Array.isArray(result[0].content), true);
    t.is(result[0].content.length, 3);
    
    // First item should be valid text type
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Hello');
    
    // Second item (JSON string of non-whitelisted object) should be converted to text
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Third item (direct non-whitelisted object) should be converted to text
    t.is(result[0].content[2].type, 'text');
    t.is(result[0].content[2].text, JSON.stringify(nonWhitelistedObject));
});

test('Gemini 1.5 Vision Plugin - uses message.name for tool name with Claude-format tool_call_ids', (t) => {
    const plugin = new Gemini15VisionPlugin(mockPathway, { ...mockModel, type: 'GEMINI-1.5-VISION' });

    // Claude tool_call_ids look like toolu_01AdRbigqBjF2fSseUhx8SfG
    // split('_')[0] would give 'toolu' which is wrong — message.name should be used
    const messages = [
        { role: 'user', content: 'hello' },
        {
            role: 'assistant',
            content: 'I will search for that.',
            tool_calls: [
                { id: 'toolu_01AdRbigqBjF2fSseUhx8SfG', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"test"}' } },
                { id: 'toolu_01QzEEDD3XFHeeEUFiRb1vq3', type: 'function', function: { name: 'SearchXPlatform', arguments: '{"text":"test"}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'toolu_01AdRbigqBjF2fSseUhx8SfG', name: 'SearchInternet', content: 'search result 1' },
        { role: 'tool', tool_call_id: 'toolu_01QzEEDD3XFHeeEUFiRb1vq3', name: 'SearchXPlatform', content: 'search result 2' }
    ];

    const result = plugin.convertMessagesToGemini(messages);

    // Find tool response messages
    const functionMessages = result.modifiedMessages.filter(msg => msg.role === 'function');
    t.is(functionMessages.length, 2);

    // Verify the tool names are correct (SearchInternet, SearchXPlatform) not 'toolu'
    t.is(functionMessages[0].parts[0].functionResponse.name, 'SearchInternet');
    t.is(functionMessages[1].parts[0].functionResponse.name, 'SearchXPlatform');
});

test('Gemini 1.5 Vision Plugin - falls back to tool_call_id split for Gemini-format IDs without name', (t) => {
    const plugin = new Gemini15VisionPlugin(mockPathway, { ...mockModel, type: 'GEMINI-1.5-VISION' });

    // Gemini tool_call_ids look like SearchInternet_1770012733044_5
    // When name field is absent, split('_')[0] correctly gives 'SearchInternet'
    const messages = [
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'SearchInternet_1770012733044_5', content: 'search result' }
    ];

    const result = plugin.convertMessagesToGemini(messages);
    const functionMessages = result.modifiedMessages.filter(msg => msg.role === 'function');
    t.is(functionMessages.length, 1);
    t.is(functionMessages[0].parts[0].functionResponse.name, 'SearchInternet');
});

test('GrokVisionPlugin - converts non-whitelisted JSON objects in content arrays to text', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    // Create a JSON object that is NOT a whitelisted content type
    const nonWhitelistedObject = {
        customField: 'someValue',
        metadata: { version: 1 }
    };
    
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Test message' }, // Valid whitelisted type
                JSON.stringify(nonWhitelistedObject), // JSON string of non-whitelisted object
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }, // Valid whitelisted type
                nonWhitelistedObject // Direct object (not whitelisted)
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(Array.isArray(result[0].content), true);
    t.is(result[0].content.length, 4);
    
    // First item should be valid text type
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Test message');
    
    // Second item (JSON string of non-whitelisted object) should be converted to text
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Third item should be valid image_url type (if URL validates)
    // Note: This might fail validation, but the type should be preserved if valid
    
    // Fourth item (direct non-whitelisted object) should be converted to text
    t.is(result[0].content[3].type, 'text');
    t.is(result[0].content[3].text, JSON.stringify(nonWhitelistedObject));
});

// Integration test: exercises the FULL production path through Gemini3ReasoningVisionPlugin.getRequestParameters,
// which calls convertMessagesToGemini (base layer) then adds its own functionCall insertion (Gemini3 layer).
// This catches duplication bugs where both layers produce functionCall parts for the same tool_calls.
test('Gemini3ReasoningVisionPlugin - functionCall/functionResponse parity through full getRequestParameters', (t) => {
    const plugin = new Gemini3ReasoningVisionPlugin(mockPathway, { ...mockModel, type: 'GEMINI-3-REASONING-VISION' });

    // Simulate multi-round agent history: two rounds of tool calls + final user message
    const messages = [
        { role: 'user', content: 'daily digest' },
        {
            role: 'assistant', content: 'Let me search.',
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'SearchMemory', arguments: '{"query":"prefs"}' } },
                { id: 'c2', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"news"}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'c1', name: 'SearchMemory', content: 'memory results' },
        { role: 'tool', tool_call_id: 'c2', name: 'SearchInternet', content: 'search results' },
        {
            role: 'assistant', content: '',
            tool_calls: [
                { id: 'c3', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"cyber"}' } }
            ]
        },
        { role: 'tool', tool_call_id: 'c3', name: 'SearchInternet', content: 'cyber results' },
        { role: 'user', content: 'Review results' }
    ];

    // Stub getCompiledPrompt so we don't need real prompt templates
    plugin.getCompiledPrompt = () => ({
        modelPromptText: '',
        modelPromptMessages: messages,
        tokenLength: 100
    });

    const cortexRequest = { pathway: { max_tokens: 1024 } };
    const result = plugin.getRequestParameters('', {}, {}, cortexRequest);

    // Count functionCall and functionResponse parts across all messages
    let functionCallCount = 0;
    let functionResponseCount = 0;
    for (const msg of result.contents) {
        for (const part of msg.parts || []) {
            if (part.functionCall) functionCallCount++;
            if (part.functionResponse) functionResponseCount++;
        }
    }

    t.is(functionCallCount, 3, 'Should have exactly 3 functionCall parts (not doubled)');
    t.is(functionResponseCount, 3, 'Should have exactly 3 functionResponse parts');
    t.is(functionCallCount, functionResponseCount,
        `Parity violation: ${functionCallCount} functionCall vs ${functionResponseCount} functionResponse`);
});
