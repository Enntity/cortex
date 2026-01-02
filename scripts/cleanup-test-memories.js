#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Cleanup Test Memories from Azure AI Search Index
 * 
 * Removes all memories where entityId is not "Luna"
 * This cleans up test data left behind by integration tests.
 * 
 * Usage:
 *   node scripts/cleanup-test-memories.js
 *   node scripts/cleanup-test-memories.js --dry-run  # Preview what would be deleted
 */

import { getContinuityMemoryService } from '../lib/continuity/index.js';
import logger from '../lib/logger.js';
import serverFactory from '../index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function cleanupTestMemories() {
    console.log('🧹 Continuity Memory Test Cleanup\n');
    
    if (DRY_RUN) {
        console.log('⚠️  DRY RUN MODE - No deletions will be performed\n');
    }
    
    // Initialize server to load config
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    if (startServer) {
        await startServer();
    }
    
    const service = getContinuityMemoryService();
    
    if (!service.coldMemory.isConfigured()) {
        console.error('❌ Azure AI Search is not configured. Cannot clean up memories.');
        process.exit(1);
    }
    
    console.log('📊 Scanning index for test memories...\n');
    
    try {
        // Search for all memories where entityId is not "Luna"
        // Using Azure's OData filter syntax
        const filter = "entityId ne 'Luna'";
        const testMemories = await service.coldMemory.searchAllWithFilter(filter, { limit: 10000 });
        
        if (testMemories.length === 0) {
            console.log('✅ No test memories found. Index is clean!\n');
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
        
        console.log(`📋 Found ${testMemories.length} test memories across ${Object.keys(byEntity).length} entity(ies):\n`);
        
        for (const [entityId, memories] of Object.entries(byEntity)) {
            console.log(`   ${entityId}: ${memories.length} memories`);
        }
        
        console.log('');
        
        if (DRY_RUN) {
            console.log('🔍 DRY RUN: Would delete the above memories.');
            console.log('   Run without --dry-run to actually delete them.\n');
            await server.stop();
            process.exit(0);
        }
        
        // Delete all test memories
        console.log('🗑️  Deleting test memories...\n');
        
        const memoryIds = testMemories.map(m => m.id);
        const batchSize = 100;
        let deleted = 0;
        
        for (let i = 0; i < memoryIds.length; i += batchSize) {
            const batch = memoryIds.slice(i, i + batchSize);
            await service.coldMemory.deleteMemories(batch);
            deleted += batch.length;
            console.log(`   Deleted ${deleted}/${memoryIds.length} memories...`);
        }
        
        console.log(`\n✅ Successfully deleted ${deleted} test memories!\n`);
        
        // Verify cleanup
        console.log('🔍 Verifying cleanup...\n');
        const remainingTest = await service.coldMemory.searchAllWithFilter(filter, { limit: 10000 });
        
        if (remainingTest.length === 0) {
            console.log('✅ Verification passed: All test memories removed!\n');
        } else {
            console.log(`⚠️  Warning: ${remainingTest.length} test memories still remain.`);
            console.log('   This may be due to Azure Search indexing delay.\n');
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

