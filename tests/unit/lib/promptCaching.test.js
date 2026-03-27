import test from 'ava';
import {
    applyAnthropicPromptCache,
    applyGooglePromptCache,
    applyXAIPromptCacheHeaders,
    hashPromptCacheConversationId,
} from '../../../lib/promptCaching.js';

test('applyAnthropicPromptCache annotates reusable tools and system content', t => {
    const result = applyAnthropicPromptCache({
        tools: [
            { name: 'SearchInternet', description: 'Searches the web' },
            { name: 'CreateChart', description: 'Creates a chart' },
        ],
        system: 'You are a cached prefix.',
    }, {
        promptCache: {
            key: 'er:initial:abc123',
            descriptor: 'entity-runtime|entity-1|chat-1|chat|initial|plan|tools:searchinternet,createchart',
        },
    });

    t.deepEqual(result.tools[1].cache_control, { type: 'ephemeral' });
    t.true(Array.isArray(result.system));
    t.deepEqual(result.system[0].cache_control, { type: 'ephemeral' });
});

test('applyGooglePromptCache passes through cached content resources when available', t => {
    const result = applyGooglePromptCache({
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    }, {
        promptCache: {
            key: 'er:initial:abc123',
            cachedContent: 'projects/test/locations/us-central1/cachedContents/abc123',
        },
    });

    t.is(result.cachedContent, 'projects/test/locations/us-central1/cachedContents/abc123');
});

test('applyXAIPromptCacheHeaders uses a stable x-grok-conv-id header', t => {
    const result = applyXAIPromptCacheHeaders({
        Authorization: 'Bearer test',
    }, {
        promptCache: {
            key: 'er:initial:abc123',
            conversationId: '0f2d40fb-3ff5-47b7-9cf6-42a6bbcf3ed7',
        },
    });

    t.is(result.Authorization, 'Bearer test');
    t.is(result['x-grok-conv-id'], '0f2d40fb-3ff5-47b7-9cf6-42a6bbcf3ed7');
});

test('hashPromptCacheConversationId returns a deterministic UUID-shaped id', t => {
    const value = hashPromptCacheConversationId('entity-runtime|entity-1|chat-1|chat');

    t.regex(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    t.is(value, hashPromptCacheConversationId('entity-runtime|entity-1|chat-1|chat'));
});
