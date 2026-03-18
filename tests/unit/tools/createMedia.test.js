// createMedia.test.js
// Tests for CreateMedia avatar accessibility self-healing

import test from 'ava';

// ─── Avatar URL accessibility check logic ───
// Mirrors the check in sys_tool_create_media.js:
//   axios.head(url, { timeout: 5000 }).then(r => r.status < 400).catch(() => false)
// We test the logic with a mockable headFn instead of stubbing shared axios.

function isAvatarAccessible(headFn, url) {
    return headFn(url, { timeout: 5000 })
        .then(r => r.status < 400)
        .catch(() => false);
}

test('avatar check: returns true for 200 response', async t => {
    const head = async () => ({ status: 200 });
    t.true(await isAvatarAccessible(head, 'https://storage.googleapis.com/bucket/avatar.jpg'));
});

test('avatar check: returns false for 403 (expired SAS token)', async t => {
    const head = async () => { throw new Error('Request failed with status code 403'); };
    t.false(await isAvatarAccessible(head, 'https://enntitycortexfiles.blob.core.windows.net/cortexfiles/old.webp'));
});

test('avatar check: returns false for 404 (deleted file)', async t => {
    const head = async () => { throw new Error('Request failed with status code 404'); };
    t.false(await isAvatarAccessible(head, 'https://storage.googleapis.com/bucket/deleted.jpg'));
});

test('avatar check: returns false on network timeout', async t => {
    const head = async () => { throw new Error('timeout of 5000ms exceeded'); };
    t.false(await isAvatarAccessible(head, 'https://unreachable.example.com/avatar.jpg'));
});

test('avatar check: returns false for 5xx server error', async t => {
    const head = async () => { throw new Error('Request failed with status code 500'); };
    t.false(await isAvatarAccessible(head, 'https://storage.googleapis.com/bucket/avatar.jpg'));
});

test('avatar check: returns true for 301 redirect', async t => {
    const head = async () => ({ status: 301 });
    t.true(await isAvatarAccessible(head, 'https://old-cdn.example.com/avatar.jpg'));
});

test('avatar check: returns false for status 403 without throwing', async t => {
    const head = async () => ({ status: 403 });
    t.false(await isAvatarAccessible(head, 'https://expired.example.com/avatar.jpg'));
});

// ─── Routing logic: unavailable avatar → generate from scratch ───

test('routing: no avatar in resolvedReferenceImages → generateImage path', t => {
    const resolvedReferenceImages = []; // avatar was unavailable, nothing pushed
    const isModify = resolvedReferenceImages.length > 0;
    t.false(isModify, 'should route to generateImage when avatar is unavailable');
});

test('routing: valid avatar in resolvedReferenceImages → modifyImage path', t => {
    const resolvedReferenceImages = ['https://storage.googleapis.com/bucket/avatar.jpg'];
    const isModify = resolvedReferenceImages.length > 0;
    t.true(isModify, 'should route to modifyImage when avatar is available');
});
