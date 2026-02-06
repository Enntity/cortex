// workspaceSSH.test.js
// Integration tests for WorkspaceSSH — provisions a real container and tests commands

import test from 'ava';
import crypto from 'node:crypto';
import serverFactory from '../../../../index.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { destroyWorkspace } from '../../../../pathways/system/entity/tools/shared/workspace_client.js';

const TEST_ENTITY_ID = `test-workspace-${crypto.randomUUID()}`;
const TEST_CONTEXT_ID = `test-ctx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
let testServer;
let entityStore;

test.before(async () => {
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    testServer = server;

    // Create a minimal test entity in MongoDB so workspace provisioning can find it
    entityStore = getEntityStore();
    await entityStore.upsertEntity({
        id: TEST_ENTITY_ID,
        name: 'WorkspaceSSH Test Entity',
        tools: ['workspacessh'],
    });
});

test.after.always('cleanup', async () => {
    // Destroy the workspace container + volume
    try {
        const entityConfig = await entityStore.getEntity(TEST_ENTITY_ID);
        if (entityConfig) {
            await destroyWorkspace(TEST_ENTITY_ID, entityConfig, { destroyVolume: true });
        }
    } catch {
        // Best effort cleanup
    }

    // Clean up file collection data from Redis
    try {
        const { getRedisClient } = await import('../../../../lib/fileUtils.js');
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${TEST_CONTEXT_ID}`);
        }
    } catch {
        // Best effort cleanup
    }

    // Remove the test entity from MongoDB
    try {
        if (entityStore && entityStore.isConfigured()) {
            const collection = await entityStore._getCollection();
            await collection.deleteOne({ id: TEST_ENTITY_ID });
        }
    } catch {
        // Best effort cleanup
    }

    if (testServer) {
        await testServer.stop();
    }
});

// --- Shell commands ---

test.serial('shell: runs pwd', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'pwd',
        userMessage: 'Check working directory',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.regex(parsed.stdout.trim(), /^\/workspace/);
});

test.serial('shell: runs echo and captures stdout', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'echo "hello from workspace"',
        userMessage: 'Echo test',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.stdout.trim(), 'hello from workspace');
});

test.serial('shell: writes and reads a file', async t => {
    // Write
    const writeResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'echo "test content 123" > /workspace/test-file.txt',
        userMessage: 'Write test file',
    });
    t.is(JSON.parse(writeResult).success, true);

    // Read back
    const readResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'cat /workspace/test-file.txt',
        userMessage: 'Read test file',
    });
    const parsed = JSON.parse(readResult);
    t.is(parsed.success, true);
    t.is(parsed.stdout.trim(), 'test content 123');
});

test.serial('shell: handles pipelines', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'echo -e "cherry\\napple\\nbanana" | sort',
        userMessage: 'Sort test',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.stdout.trim(), 'apple\nbanana\ncherry');
});

test.serial('shell: captures stderr for bad command', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'ls /nonexistent-dir-xyz',
        userMessage: 'List missing dir',
    });

    const parsed = JSON.parse(result);
    // Command itself runs (success from workspace perspective) but ls fails
    t.truthy(parsed.stderr || parsed.error);
});

test.serial('shell: runs multi-command with semicolons', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'mkdir -p /workspace/subdir; echo "nested" > /workspace/subdir/file.txt; cat /workspace/subdir/file.txt',
        userMessage: 'Multi-command test',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true);
    t.is(parsed.stdout.trim(), 'nested');
});

// --- files push with relative paths ---

test.serial('files push: works with relative path', async t => {
    // Create a file in a subdirectory
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'mkdir -p /workspace/artifacts && echo "relative path test" > /workspace/artifacts/test.txt',
        userMessage: 'Create test file',
    });

    // Push using a relative path
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push artifacts/test.txt',
        userMessage: 'Push with relative path',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true, `Expected success but got: ${parsed.error || 'no error'}`);
    t.truthy(parsed.url, 'Should return a URL');
    t.is(parsed.filename, 'test.txt');
});

test.serial('files push: works with absolute path', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/artifacts/test.txt "test-absolute"',
        userMessage: 'Push with absolute path',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true, `Expected success but got: ${parsed.error || 'no error'}`);
    t.is(parsed.filename, 'test-absolute');
});

test.serial('files push: glob expands and pushes multiple files', async t => {
    // Create several files
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'mkdir -p /workspace/gallery && echo a > /workspace/gallery/img1.jpg && echo b > /workspace/gallery/img2.jpg && echo c > /workspace/gallery/doc.txt',
        userMessage: 'Create gallery files',
    });

    // Push using glob — should match img1.jpg and img2.jpg but not doc.txt
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/gallery/*.jpg',
        userMessage: 'Push with glob',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true, `Expected success but got: ${JSON.stringify(parsed)}`);
    t.is(parsed.pushed, 2);
    t.is(parsed.failed, 0);
    t.is(parsed.files.length, 2);

    const names = parsed.files.map(f => f.filename).sort();
    t.deepEqual(names, ['img1.jpg', 'img2.jpg']);
});

test.serial('files push: glob with relative path', async t => {
    // gallery files still exist from previous test
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push gallery/*.jpg',
        userMessage: 'Push with relative glob',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, true, `Expected success but got: ${JSON.stringify(parsed)}`);
    t.is(parsed.pushed, 2);
});

test.serial('files push: glob no matches returns error', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/nonexistent/*.xyz',
        userMessage: 'Push with no-match glob',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, false);
    t.regex(parsed.error, /No files matched/);
});

// --- files pull to directory ---

test.serial('files pull: resolves directory destination (EISDIR fix)', async t => {
    // Create a file and push it so it's in the collection
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'echo "eisdir test content" > /workspace/eisdir-test.txt',
        userMessage: 'Create file for EISDIR test',
    });

    const pushResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/eisdir-test.txt',
        userMessage: 'Push file for EISDIR test',
    });
    const pushParsed = JSON.parse(pushResult);
    t.is(pushParsed.success, true, 'Push should succeed');

    // Create a target directory
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'mkdir -p /workspace/dest-dir',
        userMessage: 'Create target directory',
    });

    // Pull to a directory path — should append filename instead of EISDIR
    const pullResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        agentContext: [{ contextId: TEST_CONTEXT_ID }],
        command: 'files pull eisdir-test.txt /workspace/dest-dir',
        userMessage: 'Pull to directory',
    });
    const pullParsed = JSON.parse(pullResult);
    t.is(pullParsed.success, true, `Pull should succeed but got: ${pullParsed.error || 'no error'}`);
    t.is(pullParsed.workspacePath, '/workspace/dest-dir/eisdir-test.txt');

    // Verify the file actually landed there
    const verifyResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'cat /workspace/dest-dir/eisdir-test.txt',
        userMessage: 'Verify pulled file',
    });
    const verifyParsed = JSON.parse(verifyResult);
    t.is(verifyParsed.success, true);
    t.is(verifyParsed.stdout.trim(), 'eisdir test content');
});

// --- files pull with glob ---

test.serial('files pull glob: pulls matching files from collection', async t => {
    // Create and push 3 files: 2 .jpg, 1 .txt
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'mkdir -p /workspace/glob-src && echo "img1" > /workspace/glob-src/photo1.jpg && echo "img2" > /workspace/glob-src/photo2.jpg && echo "notes" > /workspace/glob-src/notes.txt',
        userMessage: 'Create files for glob pull test',
    });

    // Push all three files to the collection
    const push1 = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/glob-src/photo1.jpg',
        userMessage: 'Push photo1',
    });
    t.is(JSON.parse(push1).success, true, 'push photo1 should succeed');

    const push2 = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/glob-src/photo2.jpg',
        userMessage: 'Push photo2',
    });
    t.is(JSON.parse(push2).success, true, 'push photo2 should succeed');

    const push3 = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        command: 'files push /workspace/glob-src/notes.txt',
        userMessage: 'Push notes',
    });
    t.is(JSON.parse(push3).success, true, 'push notes.txt should succeed');

    // Glob pull *.jpg to a new directory
    const pullResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        agentContext: [{ contextId: TEST_CONTEXT_ID }],
        command: 'files pull *.jpg /workspace/pulled/',
        userMessage: 'Glob pull jpgs',
    });

    const parsed = JSON.parse(pullResult);
    t.is(parsed.success, true, `Glob pull should succeed but got: ${parsed.error || JSON.stringify(parsed)}`);
    t.is(parsed.pulled, 2, 'Should pull exactly 2 jpg files');
    t.is(parsed.failed, 0, 'No failures expected');

    // Verify files actually exist
    const verify = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'ls /workspace/pulled/*.jpg | wc -l',
        userMessage: 'Count pulled files',
    });
    const verifyParsed = JSON.parse(verify);
    t.is(verifyParsed.stdout.trim(), '2', 'Should have 2 jpg files in pulled dir');
});

test.serial('files pull glob: no matches returns error', async t => {
    const result = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        contextId: TEST_CONTEXT_ID,
        agentContext: [{ contextId: TEST_CONTEXT_ID }],
        command: 'files pull *.xyz',
        userMessage: 'Glob pull no matches',
    });

    const parsed = JSON.parse(result);
    t.is(parsed.success, false);
    t.regex(parsed.error, /No files matched pattern/);
});

// --- Background execution ---

test.serial('bg + poll: runs background command and retrieves result', async t => {
    // Start a background job
    const bgResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'bg echo "background done"',
        userMessage: 'Start background echo',
    });

    const bgParsed = JSON.parse(bgResult);
    t.is(bgParsed.success, true);
    t.truthy(bgParsed.processId, 'Should return a processId');

    // Wait a moment for the command to complete
    await new Promise(r => setTimeout(r, 1000));

    // Poll for the result
    const pollResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: `poll ${bgParsed.processId}`,
        userMessage: 'Poll background result',
    });

    const pollParsed = JSON.parse(pollResult);
    t.is(pollParsed.success, true);
    t.regex(pollParsed.stdout || '', /background done/);
});

// --- Reset ---

test.serial('reset: clears workspace contents', async t => {
    // Create a file first
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'echo "to be deleted" > /workspace/reset-test.txt',
        userMessage: 'Create file for reset test',
    });

    // Verify it exists
    const before = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'ls /workspace/reset-test.txt',
        userMessage: 'Verify file exists',
    });
    t.is(JSON.parse(before).success, true);

    // Reset workspace
    const resetResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'reset',
        userMessage: 'Reset workspace',
    });
    t.is(JSON.parse(resetResult).success, true);

    // Verify file is gone
    const after = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'ls /workspace/reset-test.txt 2>&1; echo "exit:$?"',
        userMessage: 'Verify file deleted after reset',
    });
    const afterParsed = JSON.parse(after);
    // ls should fail (file not found) — exit code non-zero
    t.regex(afterParsed.stdout || afterParsed.stderr || '', /No such file|exit:[12]/);
});

test.serial('reset --preserve: keeps specified files', async t => {
    // Create two files
    await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'echo "keep me" > /workspace/.env && echo "delete me" > /workspace/temp.txt',
        userMessage: 'Create files for preserve test',
    });

    // Reset with --preserve
    const resetResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'reset --preserve .env',
        userMessage: 'Reset workspace preserving .env',
    });
    t.is(JSON.parse(resetResult).success, true);

    // .env should still exist
    const envResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'cat /workspace/.env',
        userMessage: 'Check preserved file',
    });
    t.is(JSON.parse(envResult).success, true);
    t.is(JSON.parse(envResult).stdout.trim(), 'keep me');

    // temp.txt should be gone
    const tempResult = await callPathway('sys_tool_workspace_ssh', {
        entityId: TEST_ENTITY_ID,
        command: 'test -f /workspace/temp.txt && echo "exists" || echo "gone"',
        userMessage: 'Check deleted file',
    });
    t.is(JSON.parse(tempResult).stdout.trim(), 'gone');
});
