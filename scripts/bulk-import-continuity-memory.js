#!/usr/bin/env node
/**
 * Bulk Import Continuity Memories
 * 
 * Imports memories from an export file (created by export-continuity-memories.js)
 * back into the continuity memory index. Handles format conversion and bulk upserts.
 * 
 * Usage:
 *   node scripts/bulk-import-continuity-memory.js --input export.json
 * 
 * Or with custom parameters:
 *   node scripts/bulk-import-continuity-memory.js --input backup.json --entityId <entity> --userId <userId> --dry-run
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import serverFactory from '../index.js';
import { getContinuityMemoryService, ContinuityMemoryType } from '../lib/continuity/index.js';
import logger from '../lib/logger.js';

// Parse command line arguments
function parseArgs() {
    const args = {
        inputFile: null,
        entityId: null,  // Override from export if provided
        userId: null,   // Override from export if provided
        dryRun: false,
        skipDedup: false  // Skip deduplication for faster bulk import
    };
    
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--input' && i + 1 < process.argv.length) {
            args.inputFile = process.argv[++i];
        } else if (arg === '--entityId' && i + 1 < process.argv.length) {
            args.entityId = process.argv[++i];
        } else if (arg === '--userId' && i + 1 < process.argv.length) {
            args.userId = process.argv[++i];
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--skip-dedup') {
            args.skipDedup = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/bulk-import-continuity-memory.js [options]

Options:
  --input <file>      Path to export JSON file (required)
  --entityId <id>     Override entity ID from export (optional)
  --userId <id>       Override user ID from export (optional)
  --skip-dedup        Skip deduplication for faster bulk import (use with caution)
  --dry-run           Parse and validate without actually importing
  --help, -h          Show this help message

Example:
  node scripts/bulk-import-continuity-memory.js --input backup.json
  node scripts/bulk-import-continuity-memory.js --input backup.json --entityId Luna --userId abc123 --dry-run
            `);
            process.exit(0);
        }
    }
    
    return args;
}

/**
 * Convert memory from export format to import format
 * Handles conversion of emotionalState/relationalContext from objects to JSON strings
 */
function prepareMemoryForImport(memory, entityId, userId) {
    // Handle both old (userId) and new (assocEntityIds) formats in import data
    const resolvedUserId = userId || memory.userId || (memory.assocEntityIds && memory.assocEntityIds[0]);
    
    const prepared = {
        id: memory.id,
        entityId: entityId || memory.entityId,
        userId: resolvedUserId,
        type: memory.type || ContinuityMemoryType.ANCHOR,
        content: memory.content || '',
        contentVector: memory.contentVector || [], // Will be regenerated if empty
        relatedMemoryIds: memory.relatedMemoryIds || [],
        parentMemoryId: memory.parentMemoryId || null,
        tags: memory.tags || [],
        timestamp: memory.timestamp || new Date().toISOString(),
        lastAccessed: memory.lastAccessed || memory.timestamp || new Date().toISOString(),
        recallCount: memory.recallCount || 0,
        importance: memory.importance ?? 5,
        confidence: memory.confidence ?? 0.8,
        decayRate: memory.decayRate ?? 0.1,
        synthesizedFrom: memory.synthesizedFrom || [],
        synthesisType: memory.synthesisType || null
    };
    
    // Convert emotionalState from object to JSON string for storage
    if (memory.emotionalState) {
        if (typeof memory.emotionalState === 'object') {
            prepared.emotionalState = JSON.stringify(memory.emotionalState);
        } else if (typeof memory.emotionalState === 'string') {
            prepared.emotionalState = memory.emotionalState; // Already a string
        } else {
            prepared.emotionalState = null;
        }
    } else {
        prepared.emotionalState = null;
    }
    
    // Convert relationalContext from object to JSON string for storage
    if (memory.relationalContext) {
        if (typeof memory.relationalContext === 'object') {
            prepared.relationalContext = JSON.stringify(memory.relationalContext);
        } else if (typeof memory.relationalContext === 'string') {
            prepared.relationalContext = memory.relationalContext; // Already a string
        } else {
            prepared.relationalContext = null;
        }
    } else {
        prepared.relationalContext = null;
    }
    
    return prepared;
}

/**
 * Validate memory has required fields
 */
function validateMemory(memory) {
    const errors = [];
    
    if (!memory.id) {
        errors.push('Missing id');
    }
    if (!memory.entityId) {
        errors.push('Missing entityId');
    }
    if (!memory.userId && !memory.assocEntityIds) {
        errors.push('Missing userId or assocEntityIds');
    }
    if (!memory.content || memory.content.trim() === '') {
        errors.push('Missing or empty content');
    }
    if (!memory.type) {
        errors.push('Missing type');
    }
    
    return errors;
}

async function bulkImport() {
    const args = parseArgs();
    
    if (!args.inputFile) {
        console.error('Error: --input file is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('Bulk Import Continuity Memories');
    console.log('='.repeat(60));
    console.log(`Input File: ${args.inputFile}`);
    console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
    console.log(`Deduplication: ${args.skipDedup ? 'DISABLED (faster but may create duplicates)' : 'ENABLED'}`);
    console.log('='.repeat(60));
    console.log('');
    
    let server;
    
    try {
        // Read and parse the input file
        console.log('Reading input file...');
        const inputPath = path.resolve(args.inputFile);
        const fileContent = await fs.readFile(inputPath, 'utf8');
        const exportData = JSON.parse(fileContent);
        
        // Validate export format
        if (!exportData.memories || !Array.isArray(exportData.memories)) {
            throw new Error('Invalid export format: missing or invalid memories array');
        }
        
        const metadata = exportData.metadata || {};
        const memories = exportData.memories;
        
        console.log(`✓ Loaded export file`);
        console.log(`  Format: ${metadata.format || 'unknown'}`);
        console.log(`  Exported: ${metadata.exportedAt || 'unknown'}`);
        console.log(`  Total memories: ${memories.length}`);
        console.log(`  Original entityId: ${metadata.entityId || 'N/A'}`);
        console.log(`  Original userId: ${metadata.userId || 'N/A'}`);
        console.log('');
        
        // Determine entity/user IDs (use override if provided, otherwise from export)
        const entityId = args.entityId || metadata.entityId;
        const userId = args.userId || metadata.userId;
        
        if (!entityId || !userId) {
            throw new Error('entityId and userId are required. Provide via --entityId/--userId or ensure export file contains them in metadata.');
        }
        
        console.log(`Using entityId: ${entityId}, userId: ${userId}`);
        console.log('');
        
        // Initialize Cortex server
        if (!args.dryRun) {
            process.env.CORTEX_ENABLE_REST = 'true';
            const { server: srv, startServer } = await serverFactory();
            if (startServer) {
                await startServer();
            }
            server = srv;
            
            logger.info('Cortex server initialized');
        }
        
        const service = args.dryRun ? null : getContinuityMemoryService();
        
        if (!args.dryRun && !service.isAvailable()) {
            console.error('✗ Continuity memory service is not available. Check Redis and MongoDB configuration.');
            process.exit(1);
        }
        
        // Validate and prepare memories
        console.log('Validating and preparing memories...');
        const validMemories = [];
        const invalidMemories = [];
        
        for (const memory of memories) {
            const errors = validateMemory(memory);
            if (errors.length > 0) {
                invalidMemories.push({ memory, errors });
                continue;
            }
            
            const prepared = prepareMemoryForImport(memory, entityId, userId);
            validMemories.push(prepared);
        }
        
        console.log(`✓ Validated: ${validMemories.length} valid, ${invalidMemories.length} invalid`);
        
        if (invalidMemories.length > 0) {
            console.log('\nInvalid memories:');
            for (const { memory, errors } of invalidMemories.slice(0, 10)) {
                console.log(`  ID: ${memory.id || 'N/A'}, Errors: ${errors.join(', ')}`);
            }
            if (invalidMemories.length > 10) {
                console.log(`  ... and ${invalidMemories.length - 10} more`);
            }
            console.log('');
        }
        
        if (validMemories.length === 0) {
            console.log('No valid memories to import.');
            process.exit(0);
        }
        
        // Import memories
        console.log(`Importing ${validMemories.length} memories...`);
        const startTime = Date.now();
        
        let imported = 0;
        let merged = 0;
        let failed = 0;
        
        // Process in batches to avoid overwhelming the system
        const BATCH_SIZE = 10;
        for (let i = 0; i < validMemories.length; i += BATCH_SIZE) {
            const batch = validMemories.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(validMemories.length / BATCH_SIZE);
            
            console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} memories)...`);
            
            const batchPromises = batch.map(async (memory) => {
                if (args.dryRun) {
                    console.log(`  [DRY RUN] Would import: ${memory.type} - ${memory.content.substring(0, 60)}...`);
                    return { success: true, merged: false };
                }
                
                try {
                    let result;
                    if (args.skipDedup) {
                        // Direct storage without deduplication
                        const id = await service.addMemory(entityId, userId, memory);
                        result = { id, merged: false };
                    } else {
                        // Storage with deduplication
                        result = await service.addMemoryWithDedup(entityId, userId, memory);
                    }
                    
                    if (result.id) {
                        return { success: true, merged: result.merged || false };
                    } else {
                        return { success: false, merged: false };
                    }
                } catch (error) {
                    logger.error(`Failed to import memory ${memory.id}: ${error.message}`);
                    return { success: false, merged: false, error: error.message };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            
            for (const result of batchResults) {
                if (result.success) {
                    if (result.merged) {
                        merged++;
                    } else {
                        imported++;
                    }
                } else {
                    failed++;
                }
            }
            
            // Small delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < validMemories.length && !args.dryRun) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        // Summary
        console.log('');
        console.log('='.repeat(60));
        console.log('Import Complete');
        console.log('='.repeat(60));
        console.log(`Duration: ${duration}s`);
        console.log(`Total processed: ${validMemories.length}`);
        console.log(`  ✓ Imported: ${imported}`);
        console.log(`  ✓ Merged: ${merged}`);
        console.log(`  ✗ Failed: ${failed}`);
        console.log(`  ✗ Invalid: ${invalidMemories.length}`);
        console.log('');
        
        if (args.dryRun) {
            console.log('This was a DRY RUN - no changes were made.');
            console.log('Run without --dry-run to actually import memories.');
        } else {
            console.log('All valid memories have been imported!');
        }
        console.log('');
        
    } catch (error) {
        console.error('');
        console.error('='.repeat(60));
        console.error('Import Failed');
        console.error('='.repeat(60));
        console.error(`Error: ${error.message}`);
        if (error.stack) {
            console.error('');
            console.error('Stack trace:');
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        // Cleanup
        if (server && typeof server.close === 'function') {
            await server.close();
        }
        process.exit(0);
    }
}

// Run the script
bulkImport();

