import test from 'ava';
import {
    buildPromptCacheKey,
    extractFilenameMentions,
    extractRecentFileReferences,
    routeEntityTurn,
    shortlistInitialTools,
} from '../../../lib/entityRuntime/index.js';

test('extractFilenameMentions returns unique image filenames in mention order', t => {
    const filenames = extractFilenameMentions('Try jinx_avatar.png and then compare it with jinx_avatar.png plus draft.webp.');

    t.deepEqual(filenames, ['jinx_avatar.png', 'draft.webp']);
});

test('extractRecentFileReferences scans prior chat content and tool arguments', t => {
    const files = extractRecentFileReferences([
        { role: 'user', content: 'Look at storyboard.jpg when you can.' },
        {
            role: 'assistant',
            tool_calls: [
                {
                    function: {
                        name: 'ViewImages',
                        arguments: JSON.stringify({ files: ['avatar-final.png'] }),
                    },
                },
            ],
        },
        { role: 'tool', content: JSON.stringify({ selected: 'moodboard.webp' }) },
    ]);

    t.deepEqual(files, ['moodboard.webp', 'avatar-final.png', 'storyboard.jpg']);
});

test('shortlistInitialTools returns an empty shortlist without heuristic routing', t => {
    const shortlist = shortlistInitialTools({
        text: 'Show me what files are in the workspace stash',
        availableToolNames: ['WorkspaceSSH', 'ViewImages', 'SearchInternet', 'CreateChart'],
    });

    t.deepEqual(shortlist, []);
});

test('routeEntityTurn uses high-confidence chat mode to bias toward direct reply', t => {
    const route = routeEntityTurn({
        text: 'What other files do you see in the workspace?',
        availableToolNames: ['WorkspaceSSH', 'ViewImages'],
        invocationType: 'chat',
        conversationMode: 'chat',
        conversationModeConfidence: 'high',
    });

    t.is(route.mode, 'direct_reply');
    t.is(route.reason, 'chat_mode');
    t.deepEqual(route.initialToolNames, []);
});

test('routeEntityTurn keeps low-confidence chat mode on plan until the router confirms intent', t => {
    const route = routeEntityTurn({
        text: 'Hey you. Miss me?',
        availableToolNames: ['WorkspaceSSH', 'SearchInternet', 'ViewImages'],
        invocationType: 'chat',
        conversationMode: 'chat',
        conversationModeConfidence: 'low',
    });

    t.is(route.mode, 'plan');
    t.is(route.reason, 'chat_mode');
});

test('routeEntityTurn uses agentic mode to bias toward planning', t => {
    const route = routeEntityTurn({
        text: 'Try jinx_avatar.png as the base avatar',
        availableToolNames: ['SetBaseAvatar', 'ViewImages'],
        invocationType: 'chat',
        conversationMode: 'agentic',
    });

    t.is(route.mode, 'plan');
    t.is(route.reason, 'agentic_mode');
});

test('routeEntityTurn uses research mode to bias toward planning', t => {
    const route = routeEntityTurn({
        text: 'Did you look at it?',
        chatHistory: [
            { role: 'user', content: 'Here is the image: draft.png' },
            { role: 'assistant', content: 'I have it.' },
        ],
        availableToolNames: ['ViewImages'],
        invocationType: 'chat',
        conversationMode: 'research',
    });

    t.is(route.mode, 'plan');
    t.is(route.reason, 'research_mode');
});

test('routeEntityTurn keeps high-confidence casual chat in direct reply mode', t => {
    const route = routeEntityTurn({
        text: 'Hey you. Miss me?',
        availableToolNames: ['WorkspaceSSH', 'SearchInternet', 'ViewImages'],
        invocationType: 'chat',
        conversationMode: 'chat',
        conversationModeConfidence: 'high',
    });

    t.is(route.mode, 'direct_reply');
    t.is(route.reason, 'chat_mode');
});

test('buildPromptCacheKey is stable and provider-agnostic', t => {
    const keyA = buildPromptCacheKey({
        entityId: 'entity-1',
        contextId: 'chat-1',
        invocationType: 'chat',
        purpose: 'initial',
        model: 'oai-gpt54',
        routeMode: 'plan',
        toolNames: ['SearchInternet', 'CreateChart'],
    });
    const keyB = buildPromptCacheKey({
        entityId: 'entity-1',
        contextId: 'chat-1',
        invocationType: 'chat',
        purpose: 'initial',
        model: 'oai-gpt54',
        routeMode: 'plan',
        toolNames: ['CreateChart', 'SearchInternet'],
    });

    t.is(keyA, keyB);
    t.true(keyA.startsWith('er:initial:'));
    t.true(keyA.length <= 64);
    t.true(buildPromptCacheKey({ model: 'claude-46-sonnet', purpose: 'synthesis' }).startsWith('er:synthesis:'));
});
