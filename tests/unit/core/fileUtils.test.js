import test from 'ava';

// Test the pure utility functions in fileUtils.js that don't require
// a running file handler. GCS integration tests are in tests/integration/.

let fileUtils;

test.before(async () => {
    fileUtils = await import('../../../lib/fileUtils.js');
});

// ─── MIME Type Detection ─────────────────────────────────────────────────────

test('getMimeTypeFromFilename: common extensions', t => {
    t.is(fileUtils.getMimeTypeFromFilename('photo.jpg'), 'image/jpeg');
    t.is(fileUtils.getMimeTypeFromFilename('doc.pdf'), 'application/pdf');
    t.is(fileUtils.getMimeTypeFromFilename('script.js'), 'application/javascript');
    t.is(fileUtils.getMimeTypeFromFilename('data.json'), 'application/json');
    t.is(fileUtils.getMimeTypeFromFilename('page.html'), 'text/html');
    t.is(fileUtils.getMimeTypeFromFilename('video.mp4'), 'video/mp4');
    t.is(fileUtils.getMimeTypeFromFilename('audio.mp3'), 'audio/mpeg');
});

test('getMimeTypeFromFilename: with path', t => {
    t.is(fileUtils.getMimeTypeFromFilename('/workspace/files/photo.png'), 'image/png');
    t.is(fileUtils.getMimeTypeFromFilename('sub/dir/file.csv'), 'text/csv');
});

test('getMimeTypeFromFilename: unknown extension returns default', t => {
    const result = fileUtils.getMimeTypeFromFilename('file.xyz');
    t.truthy(result); // returns something (default or false)
});

test('getMimeTypeFromFilename: null/empty returns default', t => {
    const result = fileUtils.getMimeTypeFromFilename(null, 'application/octet-stream');
    t.is(result, 'application/octet-stream');
});

test('isTextMimeType: text types', t => {
    t.true(fileUtils.isTextMimeType('text/plain'));
    t.true(fileUtils.isTextMimeType('text/html'));
    t.true(fileUtils.isTextMimeType('text/csv'));
    t.true(fileUtils.isTextMimeType('application/json'));
    t.true(fileUtils.isTextMimeType('application/xml'));
});

test('isTextMimeType: binary types', t => {
    t.false(fileUtils.isTextMimeType('image/jpeg'));
    t.false(fileUtils.isTextMimeType('video/mp4'));
    t.false(fileUtils.isTextMimeType('application/pdf'));
    t.false(fileUtils.isTextMimeType('application/octet-stream'));
});

// ─── findFileInCollection ────────────────────────────────────────────────────

const mockFiles = [
    { hash: 'abc123', filename: 'report.pdf', displayFilename: 'Q4 Report', url: 'gs://bucket/abc123_report.pdf', contentType: 'application/pdf' },
    { hash: 'def456', filename: 'photo.jpg', displayFilename: 'Vacation Photo', url: 'gs://bucket/def456_photo.jpg', contentType: 'image/jpeg' },
    { hash: 'ghi789', filename: 'data.csv', displayFilename: 'Sales Data', url: 'gs://bucket/ghi789_data.csv', contentType: 'text/csv' },
];

test('findFileInCollection: by exact hash', t => {
    const found = fileUtils.findFileInCollection('abc123', mockFiles);
    t.truthy(found);
    t.is(found.hash, 'abc123');
});

test('findFileInCollection: by filename', t => {
    const found = fileUtils.findFileInCollection('report.pdf', mockFiles);
    t.truthy(found);
    t.is(found.hash, 'abc123');
});

test('findFileInCollection: by displayFilename', t => {
    const found = fileUtils.findFileInCollection('Q4 Report', mockFiles);
    t.truthy(found);
    t.is(found.hash, 'abc123');
});

test('findFileInCollection: case insensitive', t => {
    const found = fileUtils.findFileInCollection('REPORT.PDF', mockFiles);
    t.truthy(found);
    t.is(found.hash, 'abc123');
});

test('findFileInCollection: partial match', t => {
    const found = fileUtils.findFileInCollection('report', mockFiles);
    t.truthy(found);
    t.is(found.hash, 'abc123');
});

test('findFileInCollection: by URL', t => {
    const found = fileUtils.findFileInCollection('gs://bucket/def456_photo.jpg', mockFiles);
    t.truthy(found);
    t.is(found.hash, 'def456');
});

test('findFileInCollection: not found returns null', t => {
    const found = fileUtils.findFileInCollection('nonexistent', mockFiles);
    t.is(found, null);
});

test('findFileInCollection: empty collection returns null', t => {
    const found = fileUtils.findFileInCollection('anything', []);
    t.is(found, null);
});

// ─── getDefaultContext ───────────────────────────────────────────────────────

test('getDefaultContext: returns default context', t => {
    const ctx = fileUtils.getDefaultContext([
        { contextId: 'ctx1', default: false },
        { contextId: 'ctx2', default: true },
    ]);
    t.truthy(ctx);
    t.is(ctx.contextId, 'ctx2');
});

test('getDefaultContext: returns first if none marked default', t => {
    const ctx = fileUtils.getDefaultContext([
        { contextId: 'ctx1' },
        { contextId: 'ctx2' },
    ]);
    t.truthy(ctx);
    t.is(ctx.contextId, 'ctx1');
});

test('getDefaultContext: empty array returns null', t => {
    t.is(fileUtils.getDefaultContext([]), null);
    t.is(fileUtils.getDefaultContext(null), null);
    t.is(fileUtils.getDefaultContext(undefined), null);
});

// ─── buildFileLocation ──────────────────────────────────────────────────────

test('buildFileLocation: basic', t => {
    const loc = fileUtils.buildFileLocation('user-123', {});
    t.is(loc.userId, 'user-123');
});

test('buildFileLocation: with chatId and scope', t => {
    const loc = fileUtils.buildFileLocation('user-123', { chatId: 'chat-abc', fileScope: 'chat' });
    t.is(loc.userId, 'user-123');
    t.is(loc.chatId, 'chat-abc');
    t.is(loc.fileScope, 'chat');
});

// ─── buildFileCreationResponse ──────────────────────────────────────────────

test('buildFileCreationResponse: single file', t => {
    const result = fileUtils.buildFileCreationResponse([
        { url: 'https://example.com/img.png', filename: 'generated.png' }
    ], { action: 'Generation' });
    t.true(typeof result === 'string');
    t.true(result.length > 0);
});

// ─── extractFilenameFromUrl ─────────────────────────────────────────────────

test('extractFilenameFromUrl: simple URL', t => {
    const name = fileUtils.extractFilenameFromUrl('https://example.com/path/file.pdf');
    t.is(name, 'file.pdf');
});

test('extractFilenameFromUrl: GCS URL', t => {
    const name = fileUtils.extractFilenameFromUrl(null, 'gs://bucket/folder/abc123_report.pdf');
    t.is(name, 'abc123_report.pdf');
});

// ─── isYoutubeUrl ───────────────────────────────────────────────────────────

test('isYoutubeUrl: youtube.com', t => {
    t.true(fileUtils.isYoutubeUrl('https://www.youtube.com/watch?v=abc123'));
    t.true(fileUtils.isYoutubeUrl('https://youtube.com/watch?v=abc123'));
});

test('isYoutubeUrl: youtu.be', t => {
    t.true(fileUtils.isYoutubeUrl('https://youtu.be/abc123'));
});

test('isYoutubeUrl: non-youtube', t => {
    t.false(fileUtils.isYoutubeUrl('https://example.com/video'));
    t.false(fileUtils.isYoutubeUrl(null));
    t.false(fileUtils.isYoutubeUrl(''));
});

// ─── Utility functions ──────────────────────────────────────────────────────

test('generateUniqueFilename: generates with extension', t => {
    const name = fileUtils.generateUniqueFilename('.png');
    t.truthy(name);
    t.true(name.endsWith('.png'));
});

test('deleteTempPath: handles nonexistent path gracefully', t => {
    t.notThrows(() => fileUtils.deleteTempPath('/tmp/nonexistent-file-12345'));
});
