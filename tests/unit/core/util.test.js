// util.test.js
// Tests for utility functions in cortex/lib/util.js

import test from 'ava';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sinon from 'sinon';
import { removeOldImageAndFileContent } from '../../../lib/util.js';
import { generateFileMessageContent, injectFileIntoChatHistory } from '../../../lib/fileUtils.js';

// Test removeOldImageAndFileContent function

test('removeOldImageAndFileContent should return original chat history if empty', t => {
    const chatHistory = [];
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, chatHistory);
});

test('removeOldImageAndFileContent should return original chat history if null or undefined', t => {
    t.deepEqual(removeOldImageAndFileContent(null), null);
    t.deepEqual(removeOldImageAndFileContent(undefined), undefined);
});

test('removeOldImageAndFileContent should not modify chat history without image or file content', t => {
    const chatHistory = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
    ];
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, chatHistory);
});

test('removeOldImageAndFileContent should keep only the last user message with image content', t => {
    const chatHistory = [
        { role: 'user', content: [{ type: 'image_url', url: 'image1.jpg' }, 'Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: [{ type: 'image_url', url: 'image2.jpg' }, 'Text 2'] },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const expected = [
        { role: 'user', content: ['Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: [{ type: 'image_url', url: 'image2.jpg' }, 'Text 2'] },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle string JSON content', t => {
    const chatHistory = [
        { role: 'user', content: JSON.stringify({ type: 'image_url', url: 'image1.jpg' }) },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: JSON.stringify({ type: 'image_url', url: 'image2.jpg' }) },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: JSON.stringify({ type: 'image_url', url: 'image2.jpg' }) },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle object content', t => {
    const chatHistory = [
        { role: 'user', content: { type: 'image_url', url: 'image1.jpg' } },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle file content', t => {
    const chatHistory = [
        { role: 'user', content: { type: 'file', url: 'document1.pdf' } },
        { role: 'assistant', content: 'I see document 1' },
        { role: 'user', content: { type: 'file', url: 'document2.pdf' } },
        { role: 'assistant', content: 'I see document 2' }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'I see document 1' },
        { role: 'user', content: { type: 'file', url: 'document2.pdf' } },
        { role: 'assistant', content: 'I see document 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should only process user messages', t => {
    const chatHistory = [
        { role: 'user', content: { type: 'image_url', url: 'image1.jpg' } },
        { role: 'assistant', content: { type: 'image_url', url: 'response1.jpg' } },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: { type: 'image_url', url: 'response2.jpg' } }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: { type: 'image_url', url: 'response1.jpg' } },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: { type: 'image_url', url: 'response2.jpg' } }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle mixed content types', t => {
    const chatHistory = [
        { role: 'user', content: [{ type: 'image_url', url: 'image1.jpg' }, 'Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: 'Just text' },
        { role: 'assistant', content: 'I see text' },
        { role: 'user', content: [{ type: 'file', url: 'document.pdf' }, 'Text 2'] },
        { role: 'assistant', content: 'I see document' }
    ];
    
    const expected = [
        { role: 'user', content: ['Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: 'Just text' },
        { role: 'assistant', content: 'I see text' },
        { role: 'user', content: [{ type: 'file', url: 'document.pdf' }, 'Text 2'] },
        { role: 'assistant', content: 'I see document' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

// computeFileHash and computeBufferHash removed — no hashing in GCS-only model

// Test generateFileMessageContent function
test('generateFileMessageContent should return null for invalid input', async t => {
    t.is(await generateFileMessageContent(null, 'context-1'), null);
    t.is(await generateFileMessageContent(undefined, 'context-1'), null);
    t.is(await generateFileMessageContent('', 'context-1'), null);
    t.is(await generateFileMessageContent(123, 'context-1'), null);
});

test('generateFileMessageContent should return null when no contextId', async t => {
    const result = await generateFileMessageContent('https://example.com/file.pdf', null);
    
    t.is(result, null);
});

test('generateFileMessageContent should return null for file not in collection', async t => {
    const contextId = `test-normalize-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    const result = await generateFileMessageContent('nonexistent.pdf', contextId);
    t.is(result, null);
});

// Test injectFileIntoChatHistory function
test('injectFileIntoChatHistory should inject file into empty chat history', t => {
    const chatHistory = [];
    const fileContent = {
        type: 'file',
        file: 'https://example.com/test.pdf',
        url: 'https://example.com/test.pdf',
        gcs: 'gs://bucket/test.pdf',
        originalFilename: 'test.pdf'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'user');
    t.true(Array.isArray(result[0].content));
    t.is(result[0].content.length, 1);
    
    // Content should be an object (OpenAI-compatible format), not a JSON string
    const injected = result[0].content[0];
    t.is(typeof injected, 'object');
    t.is(injected.type, 'file');
    t.is(injected.file, 'https://example.com/test.pdf');
    t.is(injected.url, 'https://example.com/test.pdf');
    t.is(injected.gcs, 'gs://bucket/test.pdf');
});

test('injectFileIntoChatHistory should inject file into existing chat history', t => {
    const chatHistory = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
    ];
    const fileContent = {
        type: 'file',
        url: 'https://example.com/test.pdf',
        originalFilename: 'test.pdf'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    t.is(result.length, 3);
    t.is(result[0].role, 'user');
    t.is(result[0].content, 'Hello');
    t.is(result[1].role, 'assistant');
    t.is(result[1].content, 'Hi there!');
    t.is(result[2].role, 'user');
    t.true(Array.isArray(result[2].content));
});

test('injectFileIntoChatHistory should not inject duplicate file by URL', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [{
                type: 'file',
                file: 'https://example.com/test.pdf',
                url: 'https://example.com/test.pdf',
                gcs: 'gs://bucket/test.pdf',
                originalFilename: 'test.pdf'
            }]
        }
    ];
    const fileContent = {
        type: 'file',
        file: 'https://example.com/test.pdf',
        url: 'https://example.com/test.pdf',
        gcs: 'gs://bucket/test.pdf',
        originalFilename: 'test.pdf'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    // Should be unchanged (no duplicate added)
    t.is(result.length, 1);
    t.is(result[0].content.length, 1);
});

test('injectFileIntoChatHistory should not inject duplicate file by GCS URL', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [{
                type: 'file',
                file: 'https://example.com/test.pdf',
                url: 'https://example.com/test.pdf',
                gcs: 'gs://bucket/test.pdf',
                originalFilename: 'test.pdf'
            }]
        }
    ];
    const fileContent = {
        type: 'file',
        file: 'https://example.com/other.pdf',
        url: 'https://example.com/other.pdf',
        gcs: 'gs://bucket/test.pdf', // Same GCS URL
        originalFilename: 'other.pdf'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    // Should be unchanged (no duplicate added)
    t.is(result.length, 1);
    t.is(result[0].content.length, 1);
});

test('injectFileIntoChatHistory should not inject duplicate file by hash', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [{
                type: 'file',
                file: 'https://example.com/test.pdf',
                url: 'https://example.com/test.pdf',
                hash: 'abc123def456',
                originalFilename: 'test.pdf'
            }]
        }
    ];
    const fileContent = {
        type: 'file',
        file: 'https://example.com/other.pdf',
        url: 'https://example.com/other.pdf',
        hash: 'abc123def456', // Same hash
        originalFilename: 'other.pdf'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    // Should be unchanged (no duplicate added)
    t.is(result.length, 1);
    t.is(result[0].content.length, 1);
});

test('injectFileIntoChatHistory should inject different file', t => {
    const chatHistory = [
        {
            role: 'user',
            content: [{
                type: 'file',
                file: 'https://example.com/file1.pdf',
                url: 'https://example.com/file1.pdf',
                originalFilename: 'file1.pdf'
            }]
        }
    ];
    const fileContent = {
        type: 'file',
        file: 'https://example.com/file2.pdf',
        url: 'https://example.com/file2.pdf',
        originalFilename: 'file2.pdf'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    // Should have both files
    t.is(result.length, 2);
    t.is(result[1].role, 'user');
    t.true(Array.isArray(result[1].content));
});

test('injectFileIntoChatHistory should handle null/undefined chat history', t => {
    const fileContent = {
        type: 'file',
        url: 'https://example.com/test.pdf'
    };
    
    const result1 = injectFileIntoChatHistory(null, fileContent);
    t.is(result1.length, 1);
    t.is(result1[0].role, 'user');
    
    const result2 = injectFileIntoChatHistory(undefined, fileContent);
    t.is(result2.length, 1);
    t.is(result2[0].role, 'user');
});

test('injectFileIntoChatHistory should handle null/undefined file content', t => {
    const chatHistory = [
        { role: 'user', content: 'Hello' }
    ];
    
    const result1 = injectFileIntoChatHistory(chatHistory, null);
    t.deepEqual(result1, chatHistory);
    
    const result2 = injectFileIntoChatHistory(chatHistory, undefined);
    t.deepEqual(result2, chatHistory);
});

test('injectFileIntoChatHistory should handle image_url type', t => {
    const chatHistory = [];
    const fileContent = {
        type: 'image_url',
        image_url: { url: 'https://example.com/image.jpg' },
        url: 'https://example.com/image.jpg',
        gcs: 'gs://bucket/image.jpg',
        originalFilename: 'image.jpg'
    };
    
    const result = injectFileIntoChatHistory(chatHistory, fileContent);
    
    t.is(result.length, 1);
    // Content should be an object (OpenAI-compatible format), not a JSON string
    const injected = result[0].content[0];
    t.is(typeof injected, 'object');
    t.is(injected.type, 'image_url');
    t.truthy(injected.image_url);
    t.is(injected.image_url.url, 'https://example.com/image.jpg');
    t.is(injected.url, 'https://example.com/image.jpg');
    t.is(injected.gcs, 'gs://bucket/image.jpg');
});
