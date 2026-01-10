#!/usr/bin/env node
/**
 * Export Continuity Memories from MongoDB
 * 
 * Exports memories from MongoDB Atlas to a JSON file for backup or migration.
 * 
 * Usage:
 *   node scripts/export-mongo-memories.js --entityId Luna --userId abc123 --output backup.json
 * 
 * Requires:
 *   MONGO_URI - MongoDB Atlas connection string
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { MongoClient } from 'mongodb';

// Configuration
const COLLECTION_NAME = 'continuity_memories';

// Parse command line arguments
function parseArgs() {
    const args = {
        all: false,             // Export all memories
        entityId: null,
        userId: null,
        outputFile: null,
        excludeVectors: false,  // Exclude contentVector to reduce file size
        pretty: false,          // Pretty print JSON
        types: null             // Filter by memory types
    };
    
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--all') {
            args.all = true;
        } else if (arg === '--entityId' && i + 1 < process.argv.length) {
            args.entityId = process.argv[++i];
        } else if (arg === '--userId' && i + 1 < process.argv.length) {
            args.userId = process.argv[++i];
        } else if (arg === '--output' && i + 1 < process.argv.length) {
            args.outputFile = process.argv[++i];
        } else if (arg === '--exclude-vectors') {
            args.excludeVectors = true;
        } else if (arg === '--pretty') {
            args.pretty = true;
        } else if (arg === '--types' && i + 1 < process.argv.length) {
            args.types = process.argv[++i].split(',').map(t => t.trim());
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/export-mongo-memories.js [options]

Options:
  --all                  Export all memories (ignores --entityId and --userId)
  --entityId <id>        Entity ID to export (required unless --all)
  --userId <id>          User ID to export (required unless --all)
  --output <file>        Output JSON file path (required)
  --types <types>        Comma-separated list of memory types to export
  --exclude-vectors      Exclude contentVector field (smaller file size)
  --pretty               Pretty print JSON output
  --help, -h             Show this help message

Examples:
  # Export specific entity/user
  node scripts/export-mongo-memories.js --entityId Luna --userId abc123 --output backup.json
  
  # Export all memories
  node scripts/export-mongo-memories.js --all --output all-memories.json
  
  # Export with options
  node scripts/export-mongo-memories.js --all --output backup.json --exclude-vectors --pretty
  node scripts/export-mongo-memories.js --entityId Luna --userId abc123 --types CORE,ANCHOR --output core-backup.json
            `);
            process.exit(0);
        }
    }
    
    return args;
}

async function exportMemories() {
    const args = parseArgs();
    
    // Validate required arguments
    if (!args.all) {
        if (!args.entityId) {
            console.error('Error: --entityId is required (or use --all to export all memories)');
            console.error('Use --help for usage information');
            process.exit(1);
        }
        
        if (!args.userId) {
            console.error('Error: --userId is required (or use --all to export all memories)');
            console.error('Use --help for usage information');
            process.exit(1);
        }
    }
    
    if (!args.outputFile) {
        console.error('Error: --output file is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('Error: MONGO_URI environment variable not set');
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('Export Continuity Memories from MongoDB');
    console.log('='.repeat(60));
    if (args.all) {
        console.log('Export Mode: ALL memories');
    } else {
        console.log(`Entity ID: ${args.entityId}`);
        console.log(`User ID: ${args.userId}`);
    }
    console.log(`Output: ${args.outputFile}`);
    console.log(`Include Vectors: ${args.excludeVectors ? 'NO' : 'YES'}`);
    if (args.types) {
        console.log(`Types Filter: ${args.types.join(', ')}`);
    }
    console.log('='.repeat(60));
    console.log('');
    
    let client;
    
    try {
        // Connect to MongoDB
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
        
        // Build query
        const query = {};
        
        if (!args.all) {
            query.entityId = args.entityId;
            query.userId = args.userId;
        }
        
        if (args.types && args.types.length > 0) {
            query.type = { $in: args.types };
        }
        
        // Build projection
        const projection = args.excludeVectors ? { contentVector: 0, _id: 0 } : { _id: 0 };
        
        // Fetch memories
        console.log('📤 Fetching memories...');
        const startTime = Date.now();
        
        const memories = await collection
            .find(query, { projection })
            .toArray();
        
        const fetchDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✓ Fetched ${memories.length} memories in ${fetchDuration}s`);
        console.log('');
        
        if (memories.length === 0) {
            if (args.all) {
                console.log('⚠️  No memories found in the database.');
            } else {
                console.log('⚠️  No memories found for the specified entity/user.');
            }
            console.log('');
            process.exit(0);
        }
        
        // Calculate statistics
        const stats = {
            total: memories.length,
            byType: {},
            withVectors: 0,
            withEmotionalState: 0,
            withRelationalContext: 0,
            withRelatedMemories: 0
        };
        
        for (const m of memories) {
            stats.byType[m.type] = (stats.byType[m.type] || 0) + 1;
            if (m.contentVector && m.contentVector.length > 0) stats.withVectors++;
            if (m.emotionalState) stats.withEmotionalState++;
            if (m.relationalContext) stats.withRelationalContext++;
            if (m.relatedMemoryIds && m.relatedMemoryIds.length > 0) stats.withRelatedMemories++;
        }
        
        // Calculate unique entity/user counts for --all mode
        let uniqueEntities = null;
        let uniqueUsers = null;
        if (args.all) {
            const entitySet = new Set();
            const userSet = new Set();
            for (const m of memories) {
                if (m.entityId) entitySet.add(m.entityId);
                if (m.userId) userSet.add(m.userId);
            }
            uniqueEntities = entitySet.size;
            uniqueUsers = userSet.size;
        }
        
        // Build export object
        const exportData = {
            metadata: {
                format: 'continuity-memory-export-v1',
                source: 'mongodb',
                exportedAt: new Date().toISOString(),
                exportMode: args.all ? 'all' : 'filtered',
                entityId: args.all ? null : args.entityId,
                userId: args.all ? null : args.userId,
                uniqueEntities: uniqueEntities,
                uniqueUsers: uniqueUsers,
                totalMemories: memories.length,
                includesVectors: !args.excludeVectors,
                typesFilter: args.types || null,
                statistics: stats
            },
            memories
        };
        
        // Write to file
        console.log('💾 Writing to file...');
        const outputPath = path.resolve(args.outputFile);
        const jsonContent = args.pretty 
            ? JSON.stringify(exportData, null, 2)
            : JSON.stringify(exportData);
        
        await fs.writeFile(outputPath, jsonContent, 'utf8');
        
        const fileSizeBytes = Buffer.byteLength(jsonContent, 'utf8');
        const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
        
        console.log(`✓ Written to ${outputPath}`);
        console.log(`  File size: ${fileSizeMB} MB`);
        console.log('');
        
        // Summary
        console.log('='.repeat(60));
        console.log('Export Complete');
        console.log('='.repeat(60));
        console.log(`Total memories: ${memories.length}`);
        if (args.all && uniqueEntities !== null) {
            console.log(`Unique entities: ${uniqueEntities}`);
            console.log(`Unique users: ${uniqueUsers}`);
        }
        console.log('');
        console.log('By type:');
        for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${type}: ${count}`);
        }
        console.log('');
        console.log('Statistics:');
        console.log(`  With vectors: ${stats.withVectors}`);
        console.log(`  With emotional state: ${stats.withEmotionalState}`);
        console.log(`  With relational context: ${stats.withRelationalContext}`);
        console.log(`  With related memories: ${stats.withRelatedMemories}`);
        console.log('');
        
    } catch (error) {
        console.error('');
        console.error('='.repeat(60));
        console.error('Export Failed');
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
exportMemories();

