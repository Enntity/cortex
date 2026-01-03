#!/usr/bin/env node
/**
 * Export Continuity Memories to JSON
 * 
 * Exports all continuity memories for a given entity/user to a JSON file.
 * By default, excludes vector data for readability. Use --include-vectors
 * for full backup including all index fields.
 * 
 * Usage:
 *   node scripts/export-continuity-memories.js
 * 
 * Or with custom parameters:
 *   node scripts/export-continuity-memories.js --entityId Luna --userId 057650da-eeec-4bf8-99a1-cb71e801bc07 --output memories.json
 *   node scripts/export-continuity-memories.js --include-vectors --output full-backup.json
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import serverFactory from '../index.js';
import { getContinuityMemoryService } from '../lib/continuity/index.js';
import logger from '../lib/logger.js';

const DEFAULT_ENTITY_ID = 'Luna';
const DEFAULT_USER_ID = '057650da-eeec-4bf8-99a1-cb71e801bc07';
const DEFAULT_OUTPUT_FILE = 'continuity-memories-export.json';

// Parse command line arguments
function parseArgs() {
    const args = {
        entityId: DEFAULT_ENTITY_ID,
        userId: DEFAULT_USER_ID,
        outputFile: DEFAULT_OUTPUT_FILE,
        includeVectors: false
    };
    
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--entityId' && i + 1 < process.argv.length) {
            args.entityId = process.argv[++i];
        } else if (arg === '--userId' && i + 1 < process.argv.length) {
            args.userId = process.argv[++i];
        } else if (arg === '--output' && i + 1 < process.argv.length) {
            args.outputFile = process.argv[++i];
        } else if (arg === '--include-vectors') {
            args.includeVectors = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/export-continuity-memories.js [options]

Options:
  --entityId <id>        Entity identifier (default: ${DEFAULT_ENTITY_ID})
  --userId <id>          User/context identifier (default: ${DEFAULT_USER_ID})
  --output <file>        Output JSON file path (default: ${DEFAULT_OUTPUT_FILE})
  --include-vectors      Include vector data and all index fields (for full backup)
  --help, -h             Show this help message

Examples:
  # Standard export (vectors excluded for readability)
  node scripts/export-continuity-memories.js --entityId Luna --userId 057650da-eeec-4bf8-99a1-cb71e801bc07 --output luna-memories.json
  
  # Full backup (includes all fields including vectors)
  node scripts/export-continuity-memories.js --include-vectors --output full-backup.json
            `);
            process.exit(0);
        }
    }
    
    return args;
}

/**
 * Prepare memory for export, ensuring it's in a format that can be re-imported
 * @param {Object} memory - Memory object from Azure
 * @param {boolean} includeVectors - If true, keep all fields including vectors
 */
function prepareMemoryForExport(memory, includeVectors = false) {
    const prepared = { ...memory };
    
    // Remove computed/transient fields that shouldn't be re-imported
    delete prepared._vectorScore;
    delete prepared._recallScore;
    delete prepared['@search.score'];
    delete prepared['@odata.context'];
    
    // Remove vector fields unless full backup is requested
    if (!includeVectors) {
        delete prepared.contentVector;
    }
    
    // Ensure all required fields are present with defaults
    // This makes the export format directly importable
    if (!prepared.id) {
        // ID is required - if missing, we can't re-import
        logger.warn(`Memory missing ID, cannot be re-imported: ${prepared.content?.substring(0, 50)}`);
    }
    
    // Ensure entityId and userId are present (required for import)
    if (!prepared.entityId || !prepared.userId) {
        logger.warn(`Memory missing entityId or userId: ${prepared.id || 'unknown'}`);
    }
    
    // Keep emotionalState and relationalContext as objects (they'll be converted back to JSON strings on import)
    // This is the format after deserialization - import script will handle conversion
    
    return prepared;
}

async function exportMemories() {
    const args = parseArgs();
    
    console.log('='.repeat(60));
    console.log('Export Continuity Memories');
    console.log('='.repeat(60));
    console.log(`Entity ID: ${args.entityId}`);
    console.log(`User ID: ${args.userId}`);
    console.log(`Output File: ${args.outputFile}`);
    console.log(`Mode: ${args.includeVectors ? 'FULL BACKUP (includes vectors)' : 'STANDARD (vectors excluded)'}`);
    console.log('='.repeat(60));
    console.log('');
    
    let server;
    
    try {
        // Initialize Cortex server
        process.env.CORTEX_ENABLE_REST = 'true';
        const { server: srv, startServer } = await serverFactory();
        if (startServer) {
            await startServer();
        }
        server = srv;
        
        logger.info('Cortex server initialized');
        
        const service = getContinuityMemoryService();
        
        if (!service.isAvailable()) {
            console.error('✗ Continuity memory service is not available. Check Redis and Azure configuration.');
            process.exit(1);
        }
        
        console.log('Fetching all memories (with pagination)...');
        const startTime = Date.now();
        
        // Azure AI Search has a hard limit of 1000 results per query
        // We need to paginate to get all memories
        const allMemories = [];
        const PAGE_SIZE = 1000; // Azure's maximum
        let skip = 0;
        let hasMore = true;
        let pageCount = 0;
        
        while (hasMore) {
            pageCount++;
            console.log(`  Fetching page ${pageCount} (skip: ${skip}, limit: ${PAGE_SIZE})...`);
            
            const pageMemories = await service.coldMemory.searchFullText(
                args.entityId,
                args.userId,
                '*',
                { limit: PAGE_SIZE, skip }
            );
            
            if (pageMemories.length === 0) {
                hasMore = false;
            } else {
                allMemories.push(...pageMemories);
                skip += PAGE_SIZE;
                
                // If we got fewer than PAGE_SIZE, we've reached the end
                if (pageMemories.length < PAGE_SIZE) {
                    hasMore = false;
                }
                
                console.log(`    Found ${pageMemories.length} memories (total: ${allMemories.length})`);
            }
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        console.log(`✓ Found ${allMemories.length} total memories in ${pageCount} page(s) (${duration}s)`);
        console.log('');
        
        if (allMemories.length === 0) {
            console.log('No memories found to export.');
            process.exit(0);
        }
        
        // Prepare memories for export (ensures import-compatible format)
        if (args.includeVectors) {
            console.log('Preparing full backup (including all fields and vectors)...');
        } else {
            console.log('Preparing export (removing vector data for readability)...');
        }
        const preparedMemories = allMemories.map(m => prepareMemoryForExport(m, args.includeVectors));
        
        // Prepare export data
        const exportData = {
            metadata: {
                exportedAt: new Date().toISOString(),
                entityId: args.entityId,
                userId: args.userId,
                totalMemories: preparedMemories.length,
                exportVersion: '1.0',
                includeVectors: args.includeVectors,
                backupType: args.includeVectors ? 'full' : 'standard',
                importable: true, // Flag indicating this format can be re-imported
                format: 'continuity-memory-v1' // Format identifier for import script
            },
            memories: preparedMemories
        };
        
        // Write to file
        console.log(`Writing to ${args.outputFile}...`);
        const outputPath = path.resolve(args.outputFile);
        await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf8');
        
        const fileSize = (await fs.stat(outputPath)).size;
        const fileSizeKB = (fileSize / 1024).toFixed(2);
        
        console.log('');
        console.log('='.repeat(60));
        console.log('Export Complete');
        console.log('='.repeat(60));
        console.log(`✓ Exported ${preparedMemories.length} memories`);
        console.log(`✓ File: ${outputPath}`);
        console.log(`✓ Size: ${fileSizeKB} KB`);
        console.log(`✓ Type: ${args.includeVectors ? 'Full backup (includes vectors)' : 'Standard export (vectors excluded)'}`);
        console.log(`✓ Format: Import-ready (use bulk-import-continuity-memory.js to reload)`);
        console.log('');
        
        // Show breakdown by type
        const typeCounts = {};
        for (const memory of preparedMemories) {
            const type = memory.type || 'UNKNOWN';
            typeCounts[type] = (typeCounts[type] || 0) + 1;
        }
        
        console.log('Memory breakdown by type:');
        for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${type}: ${count}`);
        }
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
exportMemories();

