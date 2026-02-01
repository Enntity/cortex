import test from 'ava';
import { config } from '../../config.js';
import { getToolsForEntity } from '../../pathways/system/entity/tools/shared/sys_entity_tools.js';

// Helper: build a minimal tool definition with optional category
const buildToolDef = (name, category) => ({
    pathwayName: `sys_tool_${name.toLowerCase()}`,
    definition: {
        type: 'function',
        ...(category ? { category } : {}),
        function: {
            name,
            description: `Test tool ${name}`,
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
});

// Seed config.entityTools with a controlled set of tools for testing
test.beforeEach(() => {
    config.set('entityTools', {
        searchtool: buildToolDef('SearchTool'),
        createchart: buildToolDef('CreateChart'),
        endpulse: buildToolDef('EndPulse', 'pulse'),
        pulsetaskstate: buildToolDef('PulseTaskState', 'pulse'),
        createentity: buildToolDef('CreateEntity', 'system'),
    });
});

// ─── Pulse tool filtering ────────────────────────────────────────

test('pulse tools excluded from non-pulse invocations (wildcard entity)', (t) => {
    const result = getToolsForEntity(
        { tools: ['*'] },
        { invocationType: '' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'), 'general tool included');
    t.true(names.includes('createchart'), 'general tool included');
    t.false(names.includes('endpulse'), 'EndPulse excluded from chat');
    t.false(names.includes('pulsetaskstate'), 'PulseTaskState excluded from chat');
});

test('pulse tools excluded from non-pulse invocations (explicit tool list)', (t) => {
    const result = getToolsForEntity(
        { tools: ['SearchTool', 'EndPulse', 'PulseTaskState'] },
        { invocationType: '' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'));
    t.false(names.includes('endpulse'));
    t.false(names.includes('pulsetaskstate'));
});

test('pulse tools included during pulse invocations', (t) => {
    const result = getToolsForEntity(
        { tools: ['SearchTool', 'EndPulse', 'PulseTaskState'] },
        { invocationType: 'pulse' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'));
    t.true(names.includes('endpulse'));
    t.true(names.includes('pulsetaskstate'));
});

test('pulse tools included during pulse with wildcard entity', (t) => {
    const result = getToolsForEntity(
        { tools: ['*'] },
        { invocationType: 'pulse' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('endpulse'));
    t.true(names.includes('pulsetaskstate'));
});

// ─── System tool filtering ───────────────────────────────────────

test('system tools excluded from wildcard expansion', (t) => {
    const result = getToolsForEntity(
        { tools: ['*'] },
        { invocationType: '' }
    );
    const names = Object.keys(result.entityTools);
    t.false(names.includes('createentity'), 'CreateEntity excluded from wildcard');
});

test('system tools included when explicitly listed', (t) => {
    const result = getToolsForEntity(
        { tools: ['SearchTool', 'CreateEntity'] },
        { invocationType: '' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'));
    t.true(names.includes('createentity'), 'CreateEntity included when explicit');
});

test('system tools included during pulse when explicitly listed', (t) => {
    const result = getToolsForEntity(
        { tools: ['CreateEntity'] },
        { invocationType: 'pulse' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('createentity'));
});

// ─── OpenAI format matches entityTools ───────────────────────────

test('entityToolsOpenAiFormat matches filtered entityTools', (t) => {
    const result = getToolsForEntity(
        { tools: ['*'] },
        { invocationType: '' }
    );
    const toolNames = Object.keys(result.entityTools);
    const openAiNames = result.entityToolsOpenAiFormat.map(t => t.function.name.toLowerCase());
    t.deepEqual(openAiNames.sort(), toolNames.sort());
});

test('entityToolsOpenAiFormat for pulse includes pulse tools', (t) => {
    const result = getToolsForEntity(
        { tools: ['*'] },
        { invocationType: 'pulse' }
    );
    const openAiNames = result.entityToolsOpenAiFormat.map(t => t.function.name);
    t.true(openAiNames.includes('EndPulse'));
    t.true(openAiNames.includes('PulseTaskState'));
});

// ─── No options = backward compatible (no filtering) ─────────────

test('no options parameter defaults to no category filtering (backward compat)', (t) => {
    const result = getToolsForEntity({ tools: ['*'] });
    const names = Object.keys(result.entityTools);
    // Without options, all tools returned (backward compatible)
    t.true(names.includes('searchtool'));
    t.true(names.includes('createchart'));
    t.true(names.includes('endpulse'));
    t.true(names.includes('pulsetaskstate'));
    t.true(names.includes('createentity'));
});

// ─── Pulse auto-injection ────────────────────────────────────────

test('pulse tools auto-injected during pulse even when not in entity tool list', (t) => {
    const result = getToolsForEntity(
        { tools: ['SearchTool', 'CreateChart'] },
        { invocationType: 'pulse' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'));
    t.true(names.includes('createchart'));
    t.true(names.includes('endpulse'), 'EndPulse auto-injected during pulse');
    t.true(names.includes('pulsetaskstate'), 'PulseTaskState auto-injected during pulse');
});

test('pulse tools not auto-injected during non-pulse even if in entity tool list', (t) => {
    const result = getToolsForEntity(
        { tools: ['SearchTool', 'EndPulse'] },
        { invocationType: '' }
    );
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'));
    t.false(names.includes('endpulse'), 'EndPulse excluded from chat');
});

// ─── Edge cases ──────────────────────────────────────────────────

test('empty entity tools array returns no tools', (t) => {
    const result = getToolsForEntity(
        { tools: [] },
        { invocationType: '' }
    );
    t.is(Object.keys(result.entityTools).length, 0);
    t.is(result.entityToolsOpenAiFormat.length, 0);
});

test('null entityConfig returns all general tools (no pulse/system)', (t) => {
    const result = getToolsForEntity(null, { invocationType: '' });
    const names = Object.keys(result.entityTools);
    t.true(names.includes('searchtool'));
    t.false(names.includes('endpulse'));
    t.false(names.includes('createentity'));
});
