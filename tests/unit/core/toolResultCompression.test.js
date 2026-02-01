// toolResultCompression.test.js
// Tests for tool result compression utilities

import test from 'ava';
import {
    COMPRESSION_THRESHOLD,
    defaultSummarize,
    compressOlderToolResults,
    rehydrateAllToolResults
} from '../../../pathways/system/entity/tools/shared/tool_result_compression.js';

// --- defaultSummarize ---

test('defaultSummarize compresses SearchResponse JSON by truncating content', t => {
    const input = JSON.stringify({
        _type: 'SearchResponse',
        value: [
            { searchResultId: 'sr1', title: 'Page', url: 'https://example.com', content: 'x'.repeat(5000) },
            { searchResultId: 'sr2', title: 'Page2', url: 'https://example.com/2', content: 'y'.repeat(3000) }
        ]
    });
    const result = defaultSummarize(input, 'FetchWebPageContentJina');
    const parsed = JSON.parse(result);
    t.is(parsed._type, 'SearchResponse');
    t.true(parsed._compressed);
    t.is(parsed.value.length, 2);
    // Content should be truncated to 200 chars + ...
    t.true(parsed.value[0].content.length <= 204);
    t.true(parsed.value[0].content.endsWith('...'));
    // Metadata preserved
    t.is(parsed.value[0].searchResultId, 'sr1');
    t.is(parsed.value[0].title, 'Page');
    t.is(parsed.value[0].url, 'https://example.com');
});

test('defaultSummarize compresses JSON with content field', t => {
    const input = JSON.stringify({ title: 'test', content: 'a'.repeat(5000) });
    const result = defaultSummarize(input, 'SomeTool');
    const parsed = JSON.parse(result);
    t.true(parsed._compressed);
    t.is(parsed._originalChars, 5000);
    t.is(parsed.title, 'test');
    t.true(parsed.content.length <= 304);
    t.true(parsed.content.endsWith('...'));
});

test('defaultSummarize falls back to substring for plain text', t => {
    const input = 'z'.repeat(5000);
    const result = defaultSummarize(input, 'SomeTool');
    t.true(result.length < input.length);
    t.true(result.includes('[Compressed'));
});

test('defaultSummarize handles short JSON content field without adding _compressed', t => {
    const input = JSON.stringify({ title: 'test', content: 'short text' });
    const result = defaultSummarize(input, 'SomeTool');
    const parsed = JSON.parse(result);
    // Short content should still get the _compressed marker since we always compress
    t.true(parsed._compressed);
    t.is(parsed.content, 'short text...');
});

// --- compressOlderToolResults ---

test('compressOlderToolResults returns messages unchanged if store is null', t => {
    const messages = [
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'tc1', content: 'big result' }
    ];
    const result = compressOlderToolResults(messages, null, 2, {});
    t.deepEqual(result, messages);
});

test('compressOlderToolResults returns messages unchanged if store is empty', t => {
    const messages = [
        { role: 'tool', tool_call_id: 'tc1', content: 'big result' }
    ];
    const result = compressOlderToolResults(messages, new Map(), 2, {});
    t.deepEqual(result, messages);
});

test('compressOlderToolResults compresses results from older rounds', t => {
    const store = new Map();
    const bigContent = 'a'.repeat(5000);
    store.set('tc1', {
        toolName: 'SomeTool',
        fullContent: bigContent,
        charCount: bigContent.length,
        round: 1,
        compressed: false
    });

    const messages = [
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'tc1', name: 'SomeTool', content: bigContent },
        { role: 'assistant', content: 'I see' }
    ];

    const result = compressOlderToolResults(messages, store, 2, {});
    // The tool message content should be compressed
    t.not(result[1].content, bigContent);
    t.true(result[1].content.length < bigContent.length);
    // Store entry should be marked compressed
    t.true(store.get('tc1').compressed);
    // Non-tool messages unchanged
    t.is(result[0].content, 'hello');
    t.is(result[2].content, 'I see');
});

test('compressOlderToolResults does NOT compress results from current round', t => {
    const store = new Map();
    const bigContent = 'b'.repeat(5000);
    store.set('tc2', {
        toolName: 'SomeTool',
        fullContent: bigContent,
        charCount: bigContent.length,
        round: 3,
        compressed: false
    });

    const messages = [
        { role: 'tool', tool_call_id: 'tc2', name: 'SomeTool', content: bigContent }
    ];

    const result = compressOlderToolResults(messages, store, 3, {});
    t.is(result[0].content, bigContent);
    t.false(store.get('tc2').compressed);
});

test('compressOlderToolResults skips already-compressed entries', t => {
    const store = new Map();
    store.set('tc3', {
        toolName: 'SomeTool',
        fullContent: 'c'.repeat(5000),
        charCount: 5000,
        round: 1,
        compressed: true
    });

    const compressedContent = 'already compressed summary';
    const messages = [
        { role: 'tool', tool_call_id: 'tc3', name: 'SomeTool', content: compressedContent }
    ];

    const result = compressOlderToolResults(messages, store, 2, {});
    t.is(result[0].content, compressedContent);
});

test('compressOlderToolResults uses custom summarize from entityTools', t => {
    const store = new Map();
    const bigContent = 'd'.repeat(5000);
    store.set('tc4', {
        toolName: 'CustomTool',
        fullContent: bigContent,
        charCount: bigContent.length,
        round: 1,
        compressed: false
    });

    const entityTools = {
        customtool: {
            summarize: (content, toolName) => `CUSTOM_SUMMARY:${content.length}`
        }
    };

    const messages = [
        { role: 'tool', tool_call_id: 'tc4', name: 'CustomTool', content: bigContent }
    ];

    const result = compressOlderToolResults(messages, store, 2, entityTools);
    t.is(result[0].content, `CUSTOM_SUMMARY:${bigContent.length}`);
});

// --- rehydrateAllToolResults ---

test('rehydrateAllToolResults returns messages unchanged if store is null', t => {
    const messages = [{ role: 'tool', tool_call_id: 'tc1', content: 'compressed' }];
    const result = rehydrateAllToolResults(messages, null);
    t.deepEqual(result, messages);
});

test('rehydrateAllToolResults returns messages unchanged if store is empty', t => {
    const messages = [{ role: 'tool', tool_call_id: 'tc1', content: 'compressed' }];
    const result = rehydrateAllToolResults(messages, new Map());
    t.deepEqual(result, messages);
});

test('rehydrateAllToolResults restores all compressed entries', t => {
    const store = new Map();
    const fullContent1 = 'e'.repeat(5000);
    const fullContent2 = 'f'.repeat(5000);
    store.set('tc5', {
        toolName: 'SomeTool',
        fullContent: fullContent1,
        charCount: fullContent1.length,
        round: 1,
        compressed: true
    });
    store.set('tc6', {
        toolName: 'OtherTool',
        fullContent: fullContent2,
        charCount: fullContent2.length,
        round: 2,
        compressed: true
    });

    const messages = [
        { role: 'tool', tool_call_id: 'tc5', name: 'SomeTool', content: 'compressed summary 1' },
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'tc6', name: 'OtherTool', content: 'compressed summary 2' }
    ];

    const result = rehydrateAllToolResults(messages, store);
    t.is(result[0].content, fullContent1);
    t.is(result[1].content, 'hello'); // non-tool unchanged
    t.is(result[2].content, fullContent2);
    // All entries should be marked as uncompressed
    t.false(store.get('tc5').compressed);
    t.false(store.get('tc6').compressed);
});

test('rehydrateAllToolResults marks all entries as uncompressed', t => {
    const store = new Map();
    store.set('tc1', { fullContent: 'data1', compressed: true, round: 1 });
    store.set('tc2', { fullContent: 'data2', compressed: true, round: 2 });
    store.set('tc3', { fullContent: 'data3', compressed: false, round: 3 });

    rehydrateAllToolResults([], store);
    t.false(store.get('tc1').compressed);
    t.false(store.get('tc2').compressed);
    t.false(store.get('tc3').compressed);
});

test('rehydrateAllToolResults skips messages where content already matches fullContent', t => {
    const store = new Map();
    const fullContent = 'g'.repeat(5000);
    store.set('tc7', {
        toolName: 'SomeTool',
        fullContent,
        charCount: fullContent.length,
        round: 1,
        compressed: true
    });

    const messages = [
        { role: 'tool', tool_call_id: 'tc7', name: 'SomeTool', content: fullContent }
    ];

    const result = rehydrateAllToolResults(messages, store);
    t.is(result[0].content, fullContent);
});

test('rehydrateAllToolResults skips tool messages not in store', t => {
    const store = new Map();
    store.set('tc1', { fullContent: 'data1', compressed: true, round: 1 });

    const messages = [
        { role: 'tool', tool_call_id: 'tc_unknown', name: 'SomeTool', content: 'small result' }
    ];

    const result = rehydrateAllToolResults(messages, store);
    t.is(result[0].content, 'small result');
});

// --- COMPRESSION_THRESHOLD ---

test('COMPRESSION_THRESHOLD is 4000', t => {
    t.is(COMPRESSION_THRESHOLD, 4000);
});

// --- Integration: compress then rehydrateAll cycle ---

test('compress then rehydrateAll restores original content', t => {
    const store = new Map();
    const bigContent = JSON.stringify({ title: 'Test', content: 'h'.repeat(5000) });
    store.set('tc8', {
        toolName: 'FetchWebPageContentJina',
        fullContent: bigContent,
        charCount: bigContent.length,
        round: 1,
        compressed: false
    });

    const messages = [
        { role: 'user', content: 'search for something' },
        { role: 'tool', tool_call_id: 'tc8', name: 'FetchWebPageContentJina', content: bigContent },
        { role: 'assistant', content: 'Found results' }
    ];

    // Step 1: Compress on round 2
    const compressed = compressOlderToolResults(messages, store, 2, {});
    t.not(compressed[1].content, bigContent);
    t.true(store.get('tc8').compressed);

    // Step 2: RehydrateAll for final synthesis
    const rehydrated = rehydrateAllToolResults(compressed, store);
    t.is(rehydrated[1].content, bigContent);
    // All entries should be marked uncompressed
    t.false(store.get('tc8').compressed);
});
