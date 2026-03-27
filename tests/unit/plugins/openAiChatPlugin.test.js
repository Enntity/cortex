import test from 'ava';
import OpenAIChatPlugin from '../../../server/plugins/openAiChatPlugin.js';
import { mockPathwayResolverMessages } from '../../helpers/mocks.js';
import { config } from '../../../config.js';

const { pathway, modelName, model } = mockPathwayResolverMessages;

// Test the constructor
test('constructor', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    t.is(plugin.config, config);
    t.is(plugin.pathwayPrompt, mockPathwayResolverMessages.pathway.prompt);
});

// Test the convertPalmToOpenAIMessages function
test('convertPalmToOpenAIMessages', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const context = 'This is a test context.';
    const examples = [
        {
            input: { author: 'user', content: 'Hello' },
            output: { author: 'assistant', content: 'Hi there!' },
        },
    ];
    const messages = [
        { author: 'user', content: 'How are you?' },
        { author: 'assistant', content: 'I am doing well, thank you!' },
    ];
    const result = plugin.convertPalmToOpenAIMessages(context, examples, messages);
    t.deepEqual(result, [
        { role: 'system', content: 'This is a test context.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am doing well, thank you!' },
    ]);
});

// Test the getRequestParameters function
test('getRequestParameters', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30 };
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    const result = await plugin.getRequestParameters(text, parameters, prompt);
    t.deepEqual(result, {
        messages: [
            {
                content: 'Translate this: Help me',
                role: 'user',
            },
            {
                content: 'Translating: Help me',
                role: 'assistant',
            },
            {
                content: 'Nice work!',
                role: 'user',
            },
        ],
        temperature: 0.7,
    });
});

test('getRequestParameters forwards prompt cache settings when provided', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const result = await plugin.getRequestParameters('Help me', {
        prompt_cache_key: 'entity-runtime|entity-1|chat-1|chat|initial|plan|tools:none',
        prompt_cache_retention: '24h',
    }, mockPathwayResolverMessages.pathway.prompt);

    t.is(result.prompt_cache_key, 'entity-runtime|entity-1|chat-1|chat|initial|plan|tools:none');
    t.is(result.prompt_cache_retention, '24h');
});

test('getRequestParameters hashes overly long prompt cache keys down to OpenAI limits', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const longKey = 'entity-runtime|' + 'tooling,'.repeat(40);
    const result = await plugin.getRequestParameters('Help me', {
        prompt_cache_key: longKey,
    }, mockPathwayResolverMessages.pathway.prompt);

    t.true(result.prompt_cache_key.length <= 64);
    t.not(result.prompt_cache_key, longKey);
    t.true(result.prompt_cache_key.startsWith('er:'));
});

// Test the execute function
test('execute', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30 };
    const prompt = mockPathwayResolverMessages.pathway.prompt;

    // Mock the executeRequest function
    plugin.executeRequest = () => {
        return {
            choices: [
                {
                    message: {
                        content: 'Sure, I can help John who is 30 years old.',
                    },
                },
            ],
        };
    };

    const result = await plugin.execute(text, parameters, prompt, { requestId: 'foo', pathway: {} });
    t.deepEqual(result, {
        choices: [
            {
                message: {
                    content: 'Sure, I can help John who is 30 years old.',
                },
            },
        ],
    });
});

// Test the parseResponse function
test('parseResponse', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const data = {
        choices: [
            {
                message: {
                    content: 'Sure, I can help John who is 30 years old.',
                },
            },
        ],
    };
    const result = plugin.parseResponse(data);
    
    // Verify it's a CortexResponse object
    t.truthy(result);
    t.is(typeof result, 'object');
    t.is(result.constructor.name, 'CortexResponse');
    
    
    // Verify the content using string conversion (triggers toString automatically)
    t.is(String(result), 'Sure, I can help John who is 30 years old.');
    t.is(result.finishReason, 'stop');
});

// Test the logRequestData function
test('logRequestData', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const data = {
        messages: [
            { role: 'user', content: 'User: Help me\nAssistant: Please help John who is 30 years old.' },
        ],
    };
    const responseData = {
        choices: [
            {
                message: {
                    content: 'Sure, I can help John who is 30 years old.',
                },
            },
        ],
    };
    const prompt = mockPathwayResolverMessages.pathway.prompt;

    // Mock console.log function
    const originalConsoleLog = console.log;
    console.log = () => {};

    t.notThrows(() => plugin.logRequestData(data, responseData, prompt));

    console.log = originalConsoleLog;
});
