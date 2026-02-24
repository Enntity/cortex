#!/usr/bin/env node

/**
 * Deep Synthesis Test Bed
 *
 * Creates a copy of an entity's memories under a test entityId,
 * runs deep synthesis against the copy, and reports what changed.
 * The original memories are never touched.
 *
 * Usage:
 *   node scripts/testbed-deep-synthesis.js setup     # Copy memories to test entity
 *   node scripts/testbed-deep-synthesis.js run        # Run deep synthesis on test entity
 *   node scripts/testbed-deep-synthesis.js diff       # Show what changed vs original
 *   node scripts/testbed-deep-synthesis.js cleanup    # Delete test memories
 *
 * Options:
 *   --entityId <id>       Source entity (default: Jinx)
 *   --userId <id>         Filter to specific user (default: all)
 *   --maxMemories <n>     Max memories for deep synthesis (default: 50)
 *   --daysToLookBack <n>  Days to look back (default: 7, 0=all)
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryIndex } from '../lib/continuity/storage/MongoMemoryIndex.js';
import { cosineSimilarity } from '../lib/continuity/types.js';

// Parse args
const args = process.argv.slice(2);
const command = args[0];
const getArg = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};

const SOURCE_ENTITY = getArg('--entityId') || '26748fd5-3dfd-4ce4-ba84-0db2ee9d326e';
const TEST_ENTITY = `testbed-${SOURCE_ENTITY}`;
const userId = getArg('--userId') || null;
const maxMemories = parseInt(getArg('--maxMemories') || '50', 10);
const daysToLookBack = parseInt(getArg('--daysToLookBack') || '7', 10);

function contentPreview(content, maxLen = 120) {
    if (!content) return '[no content]';
    if (typeof content !== 'string') return '[encrypted]';
    return content.length > maxLen ? content.substring(0, maxLen) + '...' : content;
}

// ==================== SETUP ====================

async function setup() {
    const memoryIndex = new MongoMemoryIndex();
    const collection = await memoryIndex._getCollection();

    // Check if test data already exists
    const existingCount = await collection.countDocuments({ entityId: TEST_ENTITY });
    if (existingCount > 0) {
        console.log(`Test entity already has ${existingCount} memories. Use 'cleanup' first to refresh.`);
        await memoryIndex.close();
        return;
    }

    // Fetch source memories
    const query = { entityId: SOURCE_ENTITY };
    if (userId) query.assocEntityIds = userId;

    console.log(`Copying memories from ${SOURCE_ENTITY}...`);
    const sourceMemories = await collection.find(query).toArray();
    console.log(`Found ${sourceMemories.length} source memories.`);

    if (sourceMemories.length === 0) {
        console.log('No memories to copy.');
        await memoryIndex.close();
        return;
    }

    // Copy with new entityId and new UUIDs, preserving everything else
    // Keep a mapping so we can update synthesizedFrom/relatedMemoryIds references
    const idMap = new Map(); // oldId -> newId

    const copies = sourceMemories.map(m => {
        const newId = uuidv4();
        idMap.set(m.id, newId);
        const copy = { ...m };
        delete copy._id; // Let Mongo assign new _id
        copy.id = newId;
        copy.entityId = TEST_ENTITY;
        return copy;
    });

    // Update internal references (synthesizedFrom, relatedMemoryIds, graphEdges)
    for (const copy of copies) {
        if (copy.synthesizedFrom) {
            copy.synthesizedFrom = copy.synthesizedFrom.map(id => idMap.get(id) || id);
        }
        if (copy.relatedMemoryIds) {
            copy.relatedMemoryIds = copy.relatedMemoryIds.map(id => idMap.get(id) || id);
        }
        if (copy.graphEdges) {
            copy.graphEdges = copy.graphEdges.map(edge => ({
                ...edge,
                targetId: idMap.get(edge.targetId) || edge.targetId
            }));
        }
    }

    // Batch insert
    const BATCH = 500;
    for (let i = 0; i < copies.length; i += BATCH) {
        const batch = copies.slice(i, i + BATCH);
        await collection.insertMany(batch);
        console.log(`  Inserted ${Math.min(i + BATCH, copies.length)} / ${copies.length}`);
    }

    // Save the ID mapping for diff later
    const mappingDoc = {
        id: `__testbed_mapping_${TEST_ENTITY}`,
        entityId: TEST_ENTITY,
        type: '__TESTBED_META',
        content: JSON.stringify(Object.fromEntries(idMap)),
        timestamp: new Date()
    };
    await collection.insertOne(mappingDoc);

    console.log(`\nSetup complete. Test entity: ${TEST_ENTITY}`);
    console.log(`  ${copies.length} memories copied.`);
    console.log(`  Run 'node scripts/testbed-deep-synthesis.js run' to execute deep synthesis.`);

    await memoryIndex.close();
}

// ==================== RUN ====================

async function run() {
    const memoryIndex = new MongoMemoryIndex();
    const collection = await memoryIndex._getCollection();

    // Verify test data exists
    const count = await collection.countDocuments({ entityId: TEST_ENTITY });
    if (count === 0) {
        console.log('No test data found. Run setup first.');
        await memoryIndex.close();
        return;
    }

    console.log(`Test entity has ${count} memories.`);
    console.log(`Running deep synthesis with maxMemories=${maxMemories}, daysToLookBack=${daysToLookBack}...\n`);

    // Boot the server so callPathway works
    console.log('Booting server for pathway access...');
    const serverFactory = (await import('../index.js')).default;
    const { server, startServer } = await serverFactory();
    if (startServer) await startServer();

    // Get the continuity memory service and run deep synthesis
    const { getContinuityMemoryService } = await import('../lib/continuity/index.js');
    const service = getContinuityMemoryService();

    // Snapshot before
    const beforeMemories = await collection.find({ entityId: TEST_ENTITY, type: { $ne: '__TESTBED_META' } }).toArray();
    const beforeCounts = {};
    for (const m of beforeMemories) beforeCounts[m.type] = (beforeCounts[m.type] || 0) + 1;

    console.log('\n--- BEFORE ---');
    console.log(`Total: ${beforeMemories.length}`);
    for (const [type, c] of Object.entries(beforeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(20)} ${c}`);
    }

    // Run deep synthesis using the synthesizer directly
    const testUserId = userId || null;
    console.log(`\nRunning deep synthesis for entity=${TEST_ENTITY}, userId=${testUserId || '(all)'}...`);

    const result = await service.synthesizer.runDeepSynthesis(TEST_ENTITY, testUserId, {
        maxMemories,
        daysToLookBack: daysToLookBack || null
    });

    console.log('\n--- DEEP SYNTHESIS RESULT ---');
    console.log(JSON.stringify(result, null, 2));

    // Snapshot after
    const afterMemories = await collection.find({ entityId: TEST_ENTITY, type: { $ne: '__TESTBED_META' } }).toArray();
    const afterCounts = {};
    for (const m of afterMemories) afterCounts[m.type] = (afterCounts[m.type] || 0) + 1;

    console.log('\n--- AFTER ---');
    console.log(`Total: ${afterMemories.length} (was ${beforeMemories.length}, delta: ${afterMemories.length - beforeMemories.length})`);
    for (const [type, c] of Object.entries(afterCounts).sort((a, b) => b[1] - a[1])) {
        const before = beforeCounts[type] || 0;
        const delta = c - before;
        const deltaStr = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta})`;
        console.log(`  ${type.padEnd(20)} ${c}${deltaStr}`);
    }

    // Show new memories created by synthesis
    const beforeIds = new Set(beforeMemories.map(m => m.id));
    const newMemories = afterMemories.filter(m => !beforeIds.has(m.id));
    const deletedMemories = beforeMemories.filter(m => !afterMemories.some(am => am.id === m.id));

    if (newMemories.length > 0) {
        console.log(`\n--- NEW MEMORIES (${newMemories.length}) ---`);
        for (const m of newMemories) {
            console.log(`  [${m.type}] ${contentPreview(m.content, 150)}`);
            if (m.synthesizedFrom?.length) {
                console.log(`    synthesizedFrom: ${m.synthesizedFrom.length} sources`);
            }
            if (m.tags?.length) {
                console.log(`    tags: ${m.tags.join(', ')}`);
            }
            console.log();
        }
    }

    if (deletedMemories.length > 0) {
        console.log(`\n--- DELETED MEMORIES (${deletedMemories.length}) ---`);
        for (const m of deletedMemories) {
            console.log(`  [${m.type}] ${contentPreview(m.content, 150)}`);
        }
    }

    await memoryIndex.close();
    process.exit(0); // Server keeps running otherwise
}

// ==================== DIFF ====================

async function diff() {
    const memoryIndex = new MongoMemoryIndex();
    const collection = await memoryIndex._getCollection();

    // Load mapping
    const mappingDoc = await collection.findOne({ id: `__testbed_mapping_${TEST_ENTITY}` });
    if (!mappingDoc) {
        console.log('No mapping found. Run setup first.');
        await memoryIndex.close();
        return;
    }

    const idMap = JSON.parse(typeof mappingDoc.content === 'string' ? mappingDoc.content : '{}');
    const reverseMap = Object.fromEntries(Object.entries(idMap).map(([k, v]) => [v, k]));

    // Current state of test memories
    const testMemories = await collection.find({
        entityId: TEST_ENTITY, type: { $ne: '__TESTBED_META' }
    }).toArray();

    // Original memories for comparison
    const origMemories = await collection.find({ entityId: SOURCE_ENTITY }).toArray();
    const origById = new Map(origMemories.map(m => [m.id, m]));

    // Categorize test memories
    const unchanged = []; // Still maps to an original
    const created = [];   // New (no mapping to original)
    const originalIds = new Set(Object.values(idMap));

    for (const m of testMemories) {
        if (originalIds.has(m.id)) {
            unchanged.push(m);
        } else {
            created.push(m);
        }
    }

    // Find deleted (originals that no longer exist in test)
    const testIds = new Set(testMemories.map(m => m.id));
    const deleted = [...originalIds].filter(id => !testIds.has(id));

    console.log(`\n--- DIFF: Test Entity vs Original ---`);
    console.log(`  Original memories:  ${origMemories.length}`);
    console.log(`  Test memories now:  ${testMemories.length}`);
    console.log(`  Unchanged:          ${unchanged.length}`);
    console.log(`  Created by synth:   ${created.length}`);
    console.log(`  Deleted by synth:   ${deleted.length}`);
    console.log(`  Net change:         ${created.length - deleted.length}`);

    if (created.length > 0) {
        console.log(`\n--- CREATED (${created.length}) ---`);
        for (const m of created) {
            console.log(`  [${m.type}] ${contentPreview(m.content, 150)}`);
            if (m.synthesisType) console.log(`    synthesisType: ${m.synthesisType}`);
            if (m.tags?.length) console.log(`    tags: ${m.tags.join(', ')}`);
            console.log();
        }
    }

    if (deleted.length > 0) {
        console.log(`\n--- DELETED (${deleted.length}) ---`);
        for (const id of deleted.slice(0, 20)) {
            const origId = reverseMap[id];
            const orig = origId ? origById.get(origId) : null;
            if (orig) {
                console.log(`  [${orig.type}] ${contentPreview(orig.content, 150)}`);
            } else {
                console.log(`  ${id} (original not found)`);
            }
        }
        if (deleted.length > 20) console.log(`  ... and ${deleted.length - 20} more`);
    }

    await memoryIndex.close();
}

// ==================== CLEANUP ====================

async function cleanup() {
    const memoryIndex = new MongoMemoryIndex();
    const collection = await memoryIndex._getCollection();

    const result = await collection.deleteMany({ entityId: TEST_ENTITY });
    console.log(`Deleted ${result.deletedCount} test memories for ${TEST_ENTITY}.`);

    await memoryIndex.close();
}

// ==================== MAIN ====================

const commands = { setup, run, diff, cleanup };

if (!command || !commands[command]) {
    console.log(`Usage: node scripts/testbed-deep-synthesis.js <command> [options]

Commands:
  setup     Copy source entity memories to test entity
  run       Run deep synthesis on test entity (boots server)
  diff      Compare test entity vs original
  cleanup   Delete all test entity memories

Options:
  --entityId <id>       Source entity (default: Jinx)
  --userId <id>         Filter to specific user
  --maxMemories <n>     Max memories for deep synthesis (default: 50)
  --daysToLookBack <n>  Days to look back (default: 7, 0=all)
`);
    process.exit(1);
}

commands[command]()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
