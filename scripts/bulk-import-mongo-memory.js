#!/usr/bin/env node
/**
 * Bulk Import Continuity Memories to MongoDB
 * 
 * Imports memories from an export file (created by export-continuity-memories.js
 * or export-mongo-memories.js) into MongoDB Atlas.
 * 
 * Usage:
 *   node scripts/bulk-import-mongo-memory.js --input export.json
 * 
 * Or with custom parameters:
 *   node scripts/bulk-import-mongo-memory.js --input backup.json --entityId <entity> --userId <userId> --dry-run
 * 
 * Requires:
 *   MONGO_URI - MongoDB Atlas connection string
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { MongoClient } from 'mongodb';
import { ContinuityMemoryType } from '../lib/continuity/index.js';

// Configuration
const COLLECTION_NAME = 'continuity_memories';
const BATCH_SIZE = 100; // MongoDB bulk write batch size

// Parse command line arguments
function parseArgs() {
    const args = {
        inputFile: null,
        entityId: null,
        userId: null,
        dryRun: false,
        skipExisting: false  // Skip memories that already exist (by ID)
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
        } else if (arg === '--skip-existing') {
            args.skipExisting = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/bulk-import-mongo-memory.js [options]

Options:
  --input <file>      Path to export JSON file (required)
  --entityId <id>     Override entity ID from export (optional)
  --userId <id>       Override user ID from export (optional)
  --skip-existing     Skip memories that already exist (by ID)
  --dry-run           Parse and validate without actually importing
  --help, -h          Show this help message

Example:
  node scripts/bulk-import-mongo-memory.js --input backup.json
  node scripts/bulk-import-mongo-memory.js --input backup.json --entityId Luna --userId abc123 --dry-run
            `);
            process.exit(0);
        }
    }
    
    return args;
}

/**
 * Convert memory from export format to MongoDB format
 * Handles conversion from Azure format if needed
 */
function prepareMemoryForImport(memory, entityId, userId) {
    const now = new Date().toISOString();
    
    // Parse emotionalState if it's a JSON string (Azure format)
    let emotionalState = memory.emotionalState;
    if (typeof emotionalState === 'string' && emotionalState) {
        try {
            emotionalState = JSON.parse(emotionalState);
        } catch {
            emotionalState = null;
        }
    }
    
    // Parse relationalContext if it's a JSON string (Azure format)
    let relationalContext = memory.relationalContext;
    if (typeof relationalContext === 'string' && relationalContext) {
        try {
            relationalContext = JSON.parse(relationalContext);
        } catch {
            relationalContext = null;
        }
    }
    
    return {
        id: memory.id,
        entityId: entityId || memory.entityId,
        userId: userId || memory.userId,
        type: memory.type || ContinuityMemoryType.ANCHOR,
        content: memory.content || '',
        contentVector: memory.contentVector || [],
        relatedMemoryIds: memory.relatedMemoryIds || [],
        parentMemoryId: memory.parentMemoryId || null,
        tags: memory.tags || [],
        timestamp: memory.timestamp || now,
        lastAccessed: memory.lastAccessed || memory.timestamp || now,
        recallCount: memory.recallCount || 0,
        importance: memory.importance ?? 5,
        confidence: memory.confidence ?? 0.8,
        decayRate: memory.decayRate ?? 0.1,
        emotionalState: emotionalState || null,
        relationalContext: relationalContext || null,
        synthesizedFrom: memory.synthesizedFrom || [],
        synthesisType: memory.synthesisType || null
    };
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
    if (!memory.userId) {
        errors.push('Missing userId');
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
    
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('Error: MONGO_URI environment variable not set');
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('Bulk Import Continuity Memories to MongoDB');
    console.log('='.repeat(60));
    console.log(`Input File: ${args.inputFile}`);
    console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
    console.log(`Skip Existing: ${args.skipExisting ? 'YES' : 'NO (will upsert)'}`);
    console.log('='.repeat(60));
    console.log('');
    
    let client;
    
    try {
        // Read and parse the input file
        console.log('📂 Reading input file...');
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
        
        // Determine entity/user IDs
        const entityId = args.entityId || metadata.entityId;
        const userId = args.userId || metadata.userId;
        
        if (!entityId || !userId) {
            throw new Error('entityId and userId are required. Provide via --entityId/--userId or ensure export file contains them in metadata.');
        }
        
        console.log(`Using entityId: ${entityId}, userId: ${userId}`);
        console.log('');
        
        // Connect to MongoDB
        if (!args.dryRun) {
            console.log('📡 Connecting to MongoDB...');
            client = new MongoClient(mongoUri);
            await client.connect();
            // Get database from URI (db() without args uses the URI's database path)
            let db = client.db();
            if (!db.databaseName) {
                db = client.db('cortex');
            }
            const collection = db.collection(COLLECTION_NAME);
            console.log(`✓ Connected to ${db.databaseName}.${COLLECTION_NAME}`);
            console.log('');
        }
        
        // Validate and prepare memories
        console.log('🔍 Validating and preparing memories...');
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
            console.log('\n⚠️  Invalid memories:');
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
        console.log(`📥 Importing ${validMemories.length} memories...`);
        const startTime = Date.now();
        
        let imported = 0;
        let skipped = 0;
        let failed = 0;
        
        if (args.dryRun) {
            // Dry run - just log what would happen
            for (const memory of validMemories.slice(0, 5)) {
                console.log(`  [DRY RUN] Would import: ${memory.type} - ${memory.content.substring(0, 60)}...`);
            }
            if (validMemories.length > 5) {
                console.log(`  [DRY RUN] ... and ${validMemories.length - 5} more`);
            }
            imported = validMemories.length;
        } else {
            // Get database from URI (db() without args uses the URI's database path)
            let db = client.db();
            if (!db.databaseName) {
                db = client.db('cortex');
            }
            const collection = db.collection(COLLECTION_NAME);
            
            // Process in batches
            for (let i = 0; i < validMemories.length; i += BATCH_SIZE) {
                const batch = validMemories.slice(i, i + BATCH_SIZE);
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                const totalBatches = Math.ceil(validMemories.length / BATCH_SIZE);
                
                process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} memories)... `);
                
                try {
                    if (args.skipExisting) {
                        // Check which IDs already exist
                        const existingIds = await collection
                            .find({ id: { $in: batch.map(m => m.id) } }, { projection: { id: 1 } })
                            .toArray();
                        const existingIdSet = new Set(existingIds.map(m => m.id));
                        
                        const toInsert = batch.filter(m => !existingIdSet.has(m.id));
                        skipped += batch.length - toInsert.length;
                        
                        if (toInsert.length > 0) {
                            await collection.insertMany(toInsert, { ordered: false });
                            imported += toInsert.length;
                        }
                    } else {
                        // Upsert all
                        const operations = batch.map(memory => ({
                            updateOne: {
                                filter: { id: memory.id },
                                update: { $set: memory },
                                upsert: true
                            }
                        }));
                        
                        const result = await collection.bulkWrite(operations, { ordered: false });
                        imported += result.upsertedCount + result.modifiedCount;
                    }
                    
                    console.log('✓');
                } catch (error) {
                    console.log(`⚠️  ${error.message}`);
                    failed += batch.length;
                }
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
        console.log(`  ⏭️  Skipped: ${skipped}`);
        console.log(`  ✗ Failed: ${failed}`);
        console.log(`  ✗ Invalid: ${invalidMemories.length}`);
        console.log('');
        
        if (args.dryRun) {
            console.log('This was a DRY RUN - no changes were made.');
            console.log('Run without --dry-run to actually import memories.');
        } else {
            console.log('All valid memories have been imported!');
            
            // Show memory type breakdown
            const typeCounts = {};
            for (const m of validMemories) {
                typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
            }
            console.log('');
            console.log('Memory types imported:');
            for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
                console.log(`  ${type}: ${count}`);
            }
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
        if (client) {
            await client.close();
        }
        process.exit(1);
    }
    
    // Clean up and exit
    if (client) {
        await client.close();
    }
    process.exit(0);
}

// Run the script
bulkImport();

