#!/usr/bin/env node
/**
 * Bootload Continuity Memory from 3.1.0 Format
 * 
 * Reads a JSON file containing the old 3.1.0 memory format and migrates
 * all memories to the continuity memory system with deduplication.
 * 
 * Memory format: priority|timestamp|content
 * 
 * Mapping:
 * - memorySelf -> IDENTITY
 * - memoryUser -> ANCHOR
 * - memoryDirectives -> CORE (priority 1) or ANCHOR (priority > 1)
 * - memoryTopics -> ARTIFACT
 * 
 * Priority 1 memories are interpreted as CORE type.
 * 
 * Usage:
 *   node scripts/bootload-continuity-memory.js --input memories.json --entityId Luna --userId 057650da-eeec-4bf8-99a1-cb71e801bc07
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import serverFactory from '../index.js';
import { getContinuityMemoryService, ContinuityMemoryType } from '../lib/continuity/index.js';
import logger from '../lib/logger.js';

const DEFAULT_ENTITY_ID = 'Luna';
const DEFAULT_USER_ID = '057650da-eeec-4bf8-99a1-cb71e801bc07';

// Parse command line arguments
function parseArgs() {
    const args = {
        inputFile: null,
        entityId: DEFAULT_ENTITY_ID,
        userId: DEFAULT_USER_ID,
        dryRun: false
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
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/bootload-continuity-memory.js [options]

Options:
  --input <file>      Path to JSON file containing 3.1.0 memory format (required)
  --entityId <id>     Entity identifier (default: ${DEFAULT_ENTITY_ID})
  --userId <id>       User/context identifier (default: ${DEFAULT_USER_ID})
  --dry-run           Parse and validate without actually storing memories
  --help, -h           Show this help message

Example:
  node scripts/bootload-continuity-memory.js --input old-memories.json --entityId Luna --userId 057650da-eeec-4bf8-99a1-cb71e801bc07
            `);
            process.exit(0);
        }
    }
    
    return args;
}

/**
 * Parse a memory section string into individual memory entries
 * Format: priority|timestamp|content
 */
function parseMemorySection(sectionContent) {
    if (!sectionContent || typeof sectionContent !== 'string') {
        return [];
    }
    
    const lines = sectionContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    const memories = [];
    
    for (const line of lines) {
        const parts = line.split('|');
        
        if (parts.length < 3) {
            logger.warn(`Skipping invalid memory line (expected format: priority|timestamp|content): ${line.substring(0, 100)}`);
            continue;
        }
        
        const priority = parseInt(parts[0], 10);
        const timestamp = parts[1];
        const content = parts.slice(2).join('|').trim();
        
        if (isNaN(priority) || !timestamp || !content) {
            logger.warn(`Skipping invalid memory line (missing priority/timestamp/content): ${line.substring(0, 100)}`);
            continue;
        }
        
        memories.push({
            priority,
            timestamp,
            content
        });
    }
    
    return memories;
}

/**
 * Map old memory section to continuity memory type
 */
function mapSectionToType(sectionName, priority) {
    switch (sectionName) {
        case 'memorySelf':
            return ContinuityMemoryType.IDENTITY;
        case 'memoryUser':
            return ContinuityMemoryType.ANCHOR;
        case 'memoryDirectives':
            // Priority 1 directives are CORE, others are ANCHOR
            return priority === 1 ? ContinuityMemoryType.CORE : ContinuityMemoryType.ANCHOR;
        case 'memoryTopics':
            return ContinuityMemoryType.ARTIFACT;
        default:
            return ContinuityMemoryType.ANCHOR; // Default fallback
    }
}

/**
 * Convert priority (1-3) to importance (1-10)
 * Priority 1 = highest importance (9-10)
 * Priority 2 = medium importance (6-7)
 * Priority 3 = lower importance (4-5)
 */
function priorityToImportance(priority) {
    switch (priority) {
        case 1:
            return 9; // High importance for CORE/priority 1
        case 2:
            return 6; // Medium importance
        case 3:
            return 4; // Lower importance
        default:
            return Math.min(10, Math.max(1, priority)); // Clamp to 1-10
    }
}

/**
 * Process and store memories from a section
 */
async function processSection(service, entityId, userId, sectionName, sectionContent, dryRun) {
    const memories = parseMemorySection(sectionContent);
    
    if (memories.length === 0) {
        logger.info(`  No memories found in ${sectionName}`);
        return { stored: 0, merged: 0, skipped: 0 };
    }
    
    logger.info(`  Processing ${memories.length} memories from ${sectionName}...`);
    
    let stored = 0;
    let merged = 0;
    let skipped = 0;
    
    for (const memory of memories) {
        const type = mapSectionToType(sectionName, memory.priority);
        const importance = priorityToImportance(memory.priority);
        
        const continuityMemory = {
            type,
            content: memory.content,
            importance,
            tags: ['bootloaded', 'migration-3.1.0', sectionName],
            timestamp: memory.timestamp,
            confidence: 0.9, // High confidence for explicitly stored memories
            synthesisType: 'MIGRATION' // Mark as migrated
        };
        
        if (dryRun) {
            logger.info(`    [DRY RUN] Would store: ${type} (importance: ${importance}) - ${memory.content.substring(0, 60)}...`);
            stored++;
        } else {
            try {
                const result = await service.addMemoryWithDedup(entityId, userId, continuityMemory);
                
                if (result.id) {
                    if (result.merged) {
                        merged++;
                        logger.debug(`    Merged with ${result.mergedCount} existing memories: ${memory.content.substring(0, 60)}...`);
                    } else {
                        stored++;
                        logger.debug(`    Stored: ${memory.content.substring(0, 60)}...`);
                    }
                } else {
                    skipped++;
                    logger.warn(`    Failed to store: ${memory.content.substring(0, 60)}...`);
                }
            } catch (error) {
                skipped++;
                logger.error(`    Error storing memory: ${error.message}`);
            }
        }
    }
    
    return { stored, merged, skipped };
}

async function bootloadMemories() {
    const args = parseArgs();
    
    if (!args.inputFile) {
        console.error('Error: --input file is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('Continuity Memory Bootloader');
    console.log('='.repeat(60));
    console.log(`Input File: ${args.inputFile}`);
    console.log(`Entity ID: ${args.entityId}`);
    console.log(`User ID: ${args.userId}`);
    console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
    console.log('='.repeat(60));
    console.log('');
    
    let server;
    
    try {
        // Read and parse the input file
        console.log('Reading input file...');
        const inputPath = path.resolve(args.inputFile);
        const fileContent = await fs.readFile(inputPath, 'utf8');
        const memoryData = JSON.parse(fileContent);
        
        console.log(`✓ Loaded memory file`);
        console.log(`  Sections found: ${Object.keys(memoryData).filter(k => k.startsWith('memory')).join(', ')}`);
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
            console.error('✗ Continuity memory service is not available. Check Redis and Azure configuration.');
            process.exit(1);
        }
        
        // Process each section
        const sections = ['memorySelf', 'memoryUser', 'memoryDirectives', 'memoryTopics'];
        const stats = {
            total: { stored: 0, merged: 0, skipped: 0 },
            bySection: {}
        };
        
        for (const sectionName of sections) {
            if (!(sectionName in memoryData)) {
                logger.info(`Skipping ${sectionName} (not found in input)`);
                continue;
            }
            
            const sectionContent = memoryData[sectionName];
            if (!sectionContent || sectionContent.trim() === '') {
                logger.info(`Skipping ${sectionName} (empty)`);
                continue;
            }
            
            console.log(`Processing ${sectionName}...`);
            const result = await processSection(
                service,
                args.entityId,
                args.userId,
                sectionName,
                sectionContent,
                args.dryRun
            );
            
            stats.bySection[sectionName] = result;
            stats.total.stored += result.stored;
            stats.total.merged += result.merged;
            stats.total.skipped += result.skipped;
            
            console.log(`  ✓ ${sectionName}: ${result.stored} stored, ${result.merged} merged, ${result.skipped} skipped`);
            console.log('');
        }
        
        // Summary
        console.log('='.repeat(60));
        console.log('Bootload Complete');
        console.log('='.repeat(60));
        console.log(`Total memories processed:`);
        console.log(`  Stored: ${stats.total.stored}`);
        console.log(`  Merged: ${stats.total.merged}`);
        console.log(`  Skipped: ${stats.total.skipped}`);
        console.log('');
        
        if (args.dryRun) {
            console.log('This was a DRY RUN - no changes were made.');
            console.log('Run without --dry-run to actually store memories.');
        } else {
            console.log('All memories have been bootloaded into continuity memory!');
        }
        console.log('');
        
    } catch (error) {
        console.error('');
        console.error('='.repeat(60));
        console.error('Bootload Failed');
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
bootloadMemories();

