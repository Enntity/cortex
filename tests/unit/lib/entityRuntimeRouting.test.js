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

test('shortlistInitialTools narrows a workspace question to the relevant tool family', t => {
    const shortlist = shortlistInitialTools({
        text: 'Show me what files are in the workspace stash',
        availableToolNames: ['WorkspaceSSH', 'ViewImages', 'SearchInternet', 'CreateChart'],
    });

    t.deepEqual(shortlist, ['WorkspaceSSH', 'ViewImages']);
});

test('routeEntityTurn picks the direct workspace fast path for inventory questions', t => {
    const route = routeEntityTurn({
        text: 'What other files do you see in the workspace?',
        availableToolNames: ['WorkspaceSSH', 'ViewImages'],
        invocationType: 'chat',
    });

    t.is(route.mode, 'direct_tool');
    t.is(route.reason, 'workspace_inventory');
    t.is(route.toolName, 'WorkspaceSSH');
    t.true(route.toolArgs.command.includes('/workspace/files'));
});

test('routeEntityTurn picks direct avatar change when an explicit image file is given', t => {
    const route = routeEntityTurn({
        text: 'Try jinx_avatar.png as the base avatar',
        availableToolNames: ['SetBaseAvatar', 'ViewImages'],
        invocationType: 'chat',
    });

    t.is(route.mode, 'direct_tool');
    t.is(route.reason, 'set_base_avatar');
    t.is(route.toolName, 'SetBaseAvatar');
    t.deepEqual(route.toolArgs, {
        file: 'jinx_avatar.png',
        userMessage: 'Switching the base avatar to jinx_avatar.png',
    });
});

test('routeEntityTurn can inspect a recently referenced image without replanning', t => {
    const route = routeEntityTurn({
        text: 'Did you look at it?',
        chatHistory: [
            { role: 'user', content: 'Here is the image: draft.png' },
            { role: 'assistant', content: 'I have it.' },
        ],
        availableToolNames: ['ViewImages'],
        invocationType: 'chat',
    });

    t.is(route.mode, 'direct_tool');
    t.is(route.reason, 'view_image');
    t.is(route.toolName, 'ViewImages');
    t.deepEqual(route.toolArgs.files, ['draft.png']);
});

test('routeEntityTurn picks direct reply for obvious casual chat', t => {
    const route = routeEntityTurn({
        text: 'Hey you. Miss me?',
        availableToolNames: ['WorkspaceSSH', 'SearchInternet', 'ViewImages'],
        invocationType: 'chat',
    });

    t.is(route.mode, 'direct_reply');
    t.is(route.reason, 'casual_chat');
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
