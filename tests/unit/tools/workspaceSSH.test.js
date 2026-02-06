// workspaceSSH.test.js
// Tests for WorkspaceSSH tokenizer, command routing, and tool migrations

import test from 'ava';
import { tokenize, toAbsWorkspacePath } from '../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js';
import { migrateToolList, needsMigration, TOOL_MIGRATIONS } from '../../../pathways/system/entity/tools/shared/tool_migrations.js';

// ─── Tokenizer tests ───

test('tokenize: simple words', t => {
    t.deepEqual(tokenize('pwd'), ['pwd']);
    t.deepEqual(tokenize('ls -la'), ['ls', '-la']);
    t.deepEqual(tokenize('files push /workspace/file.txt'), ['files', 'push', '/workspace/file.txt']);
});

test('tokenize: double-quoted strings', t => {
    t.deepEqual(tokenize('echo "hello world"'), ['echo', 'hello world']);
    t.deepEqual(tokenize('files push "/workspace/my file.txt" "my report"'), ['files', 'push', '/workspace/my file.txt', 'my report']);
});

test('tokenize: single-quoted strings', t => {
    t.deepEqual(tokenize("echo 'hello world'"), ['echo', 'hello world']);
    t.deepEqual(tokenize("grep 'some pattern' file.txt"), ['grep', 'some pattern', 'file.txt']);
});

test('tokenize: mixed quotes', t => {
    t.deepEqual(tokenize(`echo "hello" 'world'`), ['echo', 'hello', 'world']);
});

test('tokenize: empty string', t => {
    t.deepEqual(tokenize(''), []);
});

test('tokenize: extra whitespace', t => {
    t.deepEqual(tokenize('  files   push   /path  '), ['files', 'push', '/path']);
});

test('tokenize: tabs', t => {
    t.deepEqual(tokenize("files\tpush\t/path"), ['files', 'push', '/path']);
});

test('tokenize: adjacent quotes produce single token', t => {
    // edge case: no space between quoted and unquoted
    t.deepEqual(tokenize('"hello"world'), ['helloworld']);
});

test('tokenize: unclosed quote takes rest as token', t => {
    // unclosed quote — remainder is included in the token
    t.deepEqual(tokenize('"hello world'), ['hello world']);
});

// ─── Path normalization tests ───

test('toAbsWorkspacePath: absolute path unchanged', t => {
    t.is(toAbsWorkspacePath('/workspace/file.txt'), '/workspace/file.txt');
    t.is(toAbsWorkspacePath('/tmp/backup.tar.gz'), '/tmp/backup.tar.gz');
});

test('toAbsWorkspacePath: relative path gets /workspace/ prefix', t => {
    t.is(toAbsWorkspacePath('file.txt'), '/workspace/file.txt');
    t.is(toAbsWorkspacePath('subdir/file.txt'), '/workspace/subdir/file.txt');
    t.is(toAbsWorkspacePath('curiosity_cabinet/artifacts/photo.jpg'), '/workspace/curiosity_cabinet/artifacts/photo.jpg');
});

// ─── Command routing tests (via dynamic import to access routeCommand indirectly) ───
// We test routing indirectly through the exported executePathway

test('routing: plain shell commands pass through', async t => {
    // Import the module
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    // Mock minimal resolver and args — the handler will fail on workspaceRequest
    // but we can verify it tries to call the right handler by checking the error shape
    const resolver = { tool: null };
    const args = { command: 'pwd', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    // Should have attempted a shell command (will fail because no workspace exists)
    t.is(parsed.success, false);
    // The error should come from workspaceRequest, not from routing
    t.truthy(parsed.error);
    t.is(JSON.parse(resolver.tool).toolUsed, 'WorkspaceSSH');
});

test('routing: files push requires workspacePath', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'files push', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /Usage.*files push/i);
});

test('routing: files pull requires fileRef', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'files pull', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /Usage.*files pull/i);
});

test('routing: files restore requires fileRef', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'files restore', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /Usage.*files restore/i);
});

test('routing: scp user@host:/path falls through to shell', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'scp user@host:/remote/path /local/path', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    // Should have attempted shell execution (fails because no workspace)
    t.is(parsed.success, false);
    // The error should be from workspaceRequest, not from files handler
    t.truthy(parsed.error);
    t.notRegex(parsed.error, /Usage/);
});

test('routing: scp push still works as backward-compatible alias', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'scp push', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    // Should route to handleFilesPush and return the usage error (not a shell error)
    t.is(parsed.success, false);
    t.regex(parsed.error, /Usage.*files push/i);
});

test('routing: empty command returns error', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: '', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /command is required/);
});

test('routing: null command returns error', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: null, entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /command is required/);
});

test('routing: files pull needs agentContext', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'files pull report.pdf', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /agentContext.*required/i);
});

test('routing: files restore needs agentContext', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    const resolver = { tool: null };
    const args = { command: 'files restore backup-123', entityId: 'test-entity-123' };

    const result = await tool.executePathway({ args, runAllPrompts: () => {}, resolver });
    const parsed = JSON.parse(result);

    t.is(parsed.success, false);
    t.regex(parsed.error, /agentContext.*required/i);
});

// ─── Tool definition structure tests ───

test('tool definition has correct name', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_workspace_ssh.js');
    const tool = mod.default;

    t.is(tool.toolDefinition.function.name, 'WorkspaceSSH');
    t.deepEqual(tool.toolDefinition.function.parameters.required, ['command', 'userMessage']);
});

// ─── Migration tests ───

test('migrations: all 11 workspace tools migrate to workspacessh', t => {
    const workspaceTools = [
        'workspaceshell', 'workspaceread', 'workspacewrite', 'workspaceedit',
        'workspacebrowse', 'workspacestatus', 'workspaceupload', 'workspacedownload',
        'workspacereset', 'workspacebackup', 'workspacerestore',
    ];

    for (const tool of workspaceTools) {
        t.is(TOOL_MIGRATIONS[tool], 'workspacessh', `${tool} should migrate to workspacessh`);
    }
});

test('migrations: all 4 file editing tools migrate to workspacessh', t => {
    const fileTools = ['readtextfile', 'writefile', 'editfilebyline', 'editfilebysearchandreplace'];

    for (const tool of fileTools) {
        t.is(TOOL_MIGRATIONS[tool], 'workspacessh', `${tool} should migrate to workspacessh`);
    }
});

test('migrations: migrateToolList consolidates old tool names', t => {
    const oldTools = ['workspaceshell', 'workspaceread', 'readtextfile', 'writefile'];
    const migrated = migrateToolList(oldTools);

    t.is(migrated.length, 1);
    t.true(migrated.includes('workspacessh'));
});

test('migrations: migrateToolList preserves non-migrated tools', t => {
    const tools = ['workspaceshell', 'filecollection', 'createmedia'];
    const migrated = migrateToolList(tools);

    t.true(migrated.includes('workspacessh'));
    t.true(migrated.includes('filecollection'));
    t.true(migrated.includes('createmedia'));
    t.is(migrated.length, 3);
});

test('migrations: migrateToolList deduplicates', t => {
    const tools = ['workspaceshell', 'workspaceread', 'workspacewrite'];
    const migrated = migrateToolList(tools);

    // All three should map to workspacessh, and there should be only one instance
    t.is(migrated.length, 1);
    t.deepEqual(migrated, ['workspacessh']);
});

test('migrations: needsMigration detects old workspace tools', t => {
    t.true(needsMigration(['WorkspaceShell', 'FileCollection']));
    t.true(needsMigration(['ReadTextFile']));
    t.false(needsMigration(['workspacessh', 'filecollection']));
    t.false(needsMigration(['*']));
});

test('migrations: wildcard tool list is unchanged', t => {
    const tools = ['*'];
    const migrated = migrateToolList(tools);
    t.deepEqual(migrated, ['*']);
});

test('migrations: mixed old and new tools', t => {
    const tools = ['workspaceshell', 'readtextfile', 'workspacessh', 'filecollection'];
    const migrated = migrateToolList(tools);

    t.true(migrated.includes('workspacessh'));
    t.true(migrated.includes('filecollection'));
    // workspacessh should appear only once even though workspaceshell and readtextfile both map to it
    t.is(migrated.filter(t => t === 'workspacessh').length, 1);
});
