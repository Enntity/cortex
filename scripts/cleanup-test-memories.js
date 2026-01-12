#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Cleanup Test Memories from Continuity Memory Index
 * 
 * Interactively removes memories by entityId, asking for confirmation for each.
 * This cleans up test data left behind by integration tests.
 * 
 * Usage:
 *   node scripts/cleanup-test-memories.js              # Preview mode (default, no deletions)
 *   node scripts/cleanup-test-memories.js --execute  # Actually perform deletions
 */

import { getContinuityMemoryService } from '../lib/continuity/index.js';
import logger from '../lib/logger.js';
import serverFactory from '../index.js';
import readline from 'readline';

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE; // Dry run is default unless --execute is specified

/**
 * Prompt user for input
 */
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(query, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

async function cleanupTestMemories() {
    console.log('🧹 Continuity Memory Test Cleanup\n');
    
    if (DRY_RUN) {
        console.log('⚠️  PREVIEW MODE - No deletions will be performed');
        console.log('   Add --execute flag to actually delete memories\n');
    }
    
    // Initialize server to load config
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    
    const service = getContinuityMemoryService();
    
    if (!service.coldMemory.isConfigured()) {
        console.error('❌ MongoDB is not configured. Cannot clean up memories.');
        process.exit(1);
    }
    
    console.log('📊 Scanning index for all memories...\n');
    
    try {
        // Search for all memories
        const testMemories = await service.coldMemory.searchAllWithFilter({}, { limit: 10000 });
        
        if (testMemories.length === 0) {
            console.log('✅ No memories found. Index is clean!\n');
            await server.stop();
            process.exit(0);
        }
        
        // Group by entityId for reporting
        const byEntity = {};
        for (const memory of testMemories) {
            const entityId = memory.entityId || 'unknown';
            if (!byEntity[entityId]) {
                byEntity[entityId] = [];
            }
            byEntity[entityId].push(memory);
        }
        
        console.log(`📋 Found ${testMemories.length} memories across ${Object.keys(byEntity).length} entity(ies):\n`);
        
        // Get sorted list of entityIds for consistent ordering
        const entityIds = Object.keys(byEntity).sort();
        
        for (const entityId of entityIds) {
            const memories = byEntity[entityId];
            console.log(`   ${entityId}: ${memories.length} memories`);
        }
        
        console.log('');
        
        if (DRY_RUN) {
            console.log('🔍 PREVIEW MODE: Would prompt for deletion of the above memories.');
            console.log('   Run with --execute to actually delete them.\n');
            await server.stop();
            process.exit(0);
        }
        
        // Process each entityId interactively
        const entityIdsToDelete = [];
        const entityIdsToKeep = [];
        
        for (const entityId of entityIds) {
            const memories = byEntity[entityId];
            const answer = await askQuestion(
                `🗑️  Delete ${memories.length} memories for entity "${entityId}"? [K]eep/[D]elete (default: Keep): `
            );
            
            const normalizedAnswer = answer.trim().toLowerCase();
            if (normalizedAnswer === 'd' || normalizedAnswer === 'delete') {
                entityIdsToDelete.push(entityId);
                console.log(`   ✓ Marked for deletion\n`);
            } else {
                entityIdsToKeep.push(entityId);
                console.log(`   ✓ Keeping\n`);
            }
        }
        
        if (entityIdsToDelete.length === 0) {
            console.log('✅ No memories marked for deletion. Exiting.\n');
            await server.stop();
            process.exit(0);
        }
        
        // Delete memories for selected entityIds
        console.log(`🗑️  Deleting memories for ${entityIdsToDelete.length} entity(ies)...\n`);
        
        const memoryIdsToDelete = [];
        for (const entityId of entityIdsToDelete) {
            const memories = byEntity[entityId];
            memoryIdsToDelete.push(...memories.map(m => m.id));
        }
        
        const batchSize = 100;
        let deleted = 0;
        
        for (let i = 0; i < memoryIdsToDelete.length; i += batchSize) {
            const batch = memoryIdsToDelete.slice(i, i + batchSize);
            await service.coldMemory.deleteMemories(batch);
            deleted += batch.length;
            console.log(`   Deleted ${deleted}/${memoryIdsToDelete.length} memories...`);
        }
        
        console.log(`\n✅ Successfully deleted ${deleted} memories from ${entityIdsToDelete.length} entity(ies)!`);
        if (entityIdsToKeep.length > 0) {
            console.log(`   Kept memories from ${entityIdsToKeep.length} entity(ies).\n`);
        } else {
            console.log('');
        }
        
        // Verify cleanup
        console.log('🔍 Verifying cleanup...\n');
        const remainingTest = await service.coldMemory.searchAllWithFilter({}, { limit: 10000 });
        
        // Filter to only count memories from entities we intended to delete
        const remainingFromDeletedEntities = remainingTest.filter(m => 
            entityIdsToDelete.includes(m.entityId)
        );
        
        if (remainingFromDeletedEntities.length === 0) {
            console.log('✅ Verification passed: All selected memories removed!');
            if (remainingTest.length > 0) {
                console.log(`   (${remainingTest.length} memories remain from kept entities)\n`);
            } else {
                console.log('');
            }
        } else {
            console.log(`⚠️  Warning: ${remainingFromDeletedEntities.length} memories still remain from deleted entities.`);
            console.log('   This may be due to indexing delay.\n');
        }
        
        await server.stop();
        process.exit(0);
        
    } catch (error) {
        console.error(`\n❌ Cleanup failed: ${error.message}\n`);
        logger.error(`Cleanup failed: ${error.message}`, error);
        await server.stop();
        process.exit(1);
    }
}

cleanupTestMemories();

