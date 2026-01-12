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
 *   node scripts/bootload-continuity-memory.js --input memories.json --entityId <entity> --userId <userId>
 *   # Or set CONTINUITY_DEFAULT_ENTITY_ID and CONTINUITY_DEFAULT_USER_ID environment variables
 */

import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import serverFactory from '../index.js';
import { getContinuityMemoryService, ContinuityMemoryType } from '../lib/continuity/index.js';
import { callPathway } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';

const DEFAULT_ENTITY_ID = process.env.CONTINUITY_DEFAULT_ENTITY_ID || null;  // Required - set via CONTINUITY_DEFAULT_ENTITY_ID env var
const DEFAULT_USER_ID = process.env.CONTINUITY_DEFAULT_USER_ID || null;      // Required - set via CONTINUITY_DEFAULT_USER_ID env var
const DEFAULT_BATCH_SIZE = parseInt(process.env.CONTINUITY_BOOTLOAD_BATCH_SIZE || '10'); // Batch size for processing

// Parse command line arguments
function parseArgs() {
    const args = {
        inputFile: null,
        entityId: DEFAULT_ENTITY_ID,
        userId: DEFAULT_USER_ID,
        dryRun: false,
        batchSize: DEFAULT_BATCH_SIZE
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
        } else if ((arg === '--batch-size' || arg === '--batch') && i + 1 < process.argv.length) {
            args.batchSize = parseInt(process.argv[++i], 10);
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/bootload-continuity-memory.js [options]

Options:
  --input <file>      Path to JSON file containing 3.1.0 memory format (required)
  --entityId <id>     Entity identifier (default: from CONTINUITY_DEFAULT_ENTITY_ID env var)
  --userId <id>       User/context identifier (default: from CONTINUITY_DEFAULT_USER_ID env var)
  --dry-run           Parse and validate without actually storing memories
  --help, -h           Show this help message

Examples:
  # Using command line arguments
  node scripts/bootload-continuity-memory.js --input old-memories.json --entityId <entity> --userId <userId>
  
  # Using environment variables
  export CONTINUITY_DEFAULT_ENTITY_ID=<entity>
  export CONTINUITY_DEFAULT_USER_ID=<userId>
  node scripts/bootload-continuity-memory.js --input old-memories.json
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
 * In-memory deduplication store
 * Accumulates all memories, deduplicates in-memory, then batch syncs to MongoDB at the end
 */
class InMemoryDeduplicator {
    constructor(similarityThreshold = 0.85) {
        this.memories = new Map();  // id -> memory with embedding
        this.similarityThreshold = similarityThreshold;
    }
    
    /**
     * Add a memory with in-memory deduplication
     * Returns whether it was merged or added as new
     */
    add(memory) {
        const embedding = memory.contentVector;
        
        // Find similar existing memory
        for (const [id, existing] of this.memories) {
            const similarity = this._cosineSimilarity(embedding, existing.contentVector);
            if (similarity > this.similarityThreshold) {
                // Merge into existing
                existing.content = existing.content.length > memory.content.length 
                    ? existing.content : memory.content;
                existing.importance = Math.max(existing.importance, memory.importance);
                existing.tags = [...new Set([...existing.tags, ...memory.tags])];
                return { merged: true, mergedInto: id };
            }
        }
        
        // No duplicate - add as new
        const id = crypto.randomUUID();
        this.memories.set(id, { ...memory, id });
        return { merged: false, id };
    }
    
    /**
     * Check against existing database memories and REMOVE duplicates from our set
     * Returns count of duplicates found (skipped)
     */
    removeExistingDuplicates(existingMemories) {
        const toRemove = new Set();  // IDs from our in-memory set to skip
        
        for (const existing of existingMemories) {
            if (!existing.contentVector?.length) continue;
            
            // Check if any of our new memories are similar to this existing memory
            for (const [id, memory] of this.memories) {
                if (toRemove.has(id)) continue;  // Already marked for removal
                
                const similarity = this._cosineSimilarity(memory.contentVector, existing.contentVector);
                if (similarity > this.similarityThreshold) {
                    // This memory already exists - skip it
                    toRemove.add(id);
                    break;
                }
            }
        }
        
        // Remove duplicates from our set
        for (const id of toRemove) {
            this.memories.delete(id);
        }
        
        return toRemove.size;
    }
    
    getAll() {
        return Array.from(this.memories.values());
    }
    
    size() {
        return this.memories.size;
    }
    
    _cosineSimilarity(vec1, vec2) {
        if (!vec1?.length || !vec2?.length) return 0;
        let dot = 0, norm1 = 0, norm2 = 0;
        for (let i = 0; i < vec1.length; i++) {
            dot += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }
        return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }
}

/**
 * Process all memories in-memory, then batch sync to MongoDB at the end
 * MUCH faster than per-record database operations
 */
async function processAllSections(service, entityId, userId, memoryData, sections, dryRun, batchSize) {
    console.log('\n📥 Phase 1: Loading and parsing all memories...');
    
    // Collect all raw memories from all sections
    const allRawMemories = [];
    for (const sectionName of sections) {
        if (!(sectionName in memoryData)) continue;
        const sectionContent = memoryData[sectionName];
        if (!sectionContent || sectionContent.trim() === '') continue;
        
        const memories = parseMemorySection(sectionContent);
        for (const memory of memories) {
            allRawMemories.push({ ...memory, sectionName });
        }
    }
    
    if (allRawMemories.length === 0) {
        console.log('  No memories found in any section.');
        return { stored: 0, merged: 0, skipped: 0, deleted: 0 };
    }
    
    console.log(`  Found ${allRawMemories.length} total memories across all sections.`);
    
    // Phase 2: Generate all embeddings (with batching for progress)
    console.log('\n🧠 Phase 2: Generating embeddings...');
    const memoriesWithEmbeddings = [];
    const embeddingBatchSize = batchSize;
    
    for (let i = 0; i < allRawMemories.length; i += embeddingBatchSize) {
        const batch = allRawMemories.slice(i, i + embeddingBatchSize);
        const batchNum = Math.floor(i / embeddingBatchSize) + 1;
        const totalBatches = Math.ceil(allRawMemories.length / embeddingBatchSize);
        
        process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} memories)...`);
        
        if (dryRun) {
            for (const memory of batch) {
                memoriesWithEmbeddings.push({
                    ...memory,
                    contentVector: []
                });
            }
        } else {
            const embeddings = await Promise.all(
                batch.map(async (memory) => {
                    try {
                        return await generateEmbedding(memory.content);
                    } catch (error) {
                        logger.warn(`Embedding failed: ${error.message}`);
                        return [];
                    }
                })
            );
            
            for (let j = 0; j < batch.length; j++) {
                memoriesWithEmbeddings.push({
                    ...batch[j],
                    contentVector: embeddings[j]
                });
            }
        }
        
        console.log(' ✓');
    }
    
    // Phase 3: In-memory deduplication
    console.log('\n🔄 Phase 3: In-memory deduplication...');
    const deduplicator = new InMemoryDeduplicator(0.85);
    let mergedCount = 0;
    
    for (const rawMemory of memoriesWithEmbeddings) {
        const memory = {
            type: mapSectionToType(rawMemory.sectionName, rawMemory.priority),
            content: rawMemory.content,
            contentVector: rawMemory.contentVector,
            importance: priorityToImportance(rawMemory.priority),
            tags: ['bootloaded', 'migration-3.1.0', rawMemory.sectionName],
            timestamp: rawMemory.timestamp,
            confidence: 0.9,
            synthesisType: 'MIGRATION'
        };
        
        const result = deduplicator.add(memory);
        if (result.merged) mergedCount++;
    }
    
    console.log(`  ${allRawMemories.length} → ${deduplicator.size()} unique memories (${mergedCount} merged within input)`);
    
    if (dryRun) {
        console.log('\n📋 DRY RUN - no changes made to database');
        return { 
            inputCount: allRawMemories.length,
            mergedWithinInput: mergedCount,
            uniqueFromInput: deduplicator.size(),
            newMemories: deduplicator.size(),  // Would be uploaded
            duplicatesSkipped: 0,  // Can't check database in dry run
            failed: 0
        };
    }
    
    // Phase 4: Check against existing database memories
    console.log('\n🔍 Phase 4: Checking against existing database memories...');
    let existingMemories = [];
    let duplicatesSkipped = 0;
    try {
        existingMemories = await service.getAllMemories(entityId, userId, { limit: 10000 });
        console.log(`  Found ${existingMemories.length} existing memories in database.`);
        
        // Remove duplicates from our set (don't upload them)
        duplicatesSkipped = deduplicator.removeExistingDuplicates(existingMemories);
        if (duplicatesSkipped > 0) {
            console.log(`  ${duplicatesSkipped} skipped (already exist in database).`);
        }
    } catch (error) {
        console.log(`  Could not fetch existing memories: ${error.message}`);
    }
    
    // Phase 5: Upload new memories to database
    const finalMemories = deduplicator.getAll();
    
    if (finalMemories.length === 0) {
        console.log('\n💾 Phase 5: Nothing to upload - all memories already exist.');
        return { 
            inputCount: allRawMemories.length,
            mergedWithinInput: mergedCount,
            uniqueFromInput: deduplicator.size() + duplicatesSkipped,
            newMemories: 0,
            duplicatesSkipped,
            failed: 0
        };
    }
    
    console.log(`\n💾 Phase 5: Uploading ${finalMemories.length} new memories to database...`);
    const upsertBatchSize = 50;
    let upserted = 0;
    
    for (let i = 0; i < finalMemories.length; i += upsertBatchSize) {
        const batch = finalMemories.slice(i, i + upsertBatchSize);
        try {
            await service.upsertMemories(entityId, userId, batch);
            upserted += batch.length;
            process.stdout.write(`\r  Uploaded ${upserted}/${finalMemories.length}...`);
        } catch (error) {
            logger.warn(`Batch upsert failed: ${error.message}`);
            for (const memory of batch) {
                try {
                    await service.addMemory(entityId, userId, memory);
                    upserted++;
                } catch (e) {
                    logger.warn(`Individual upsert failed: ${e.message}`);
                }
            }
        }
    }
    console.log(`\r  Uploaded ${upserted}/${finalMemories.length} ✓`);
    
    return { 
        inputCount: allRawMemories.length,
        mergedWithinInput: mergedCount,
        uniqueFromInput: finalMemories.length + duplicatesSkipped,
        newMemories: upserted,
        duplicatesSkipped,
        failed: finalMemories.length - upserted
    };
}

async function generateEmbedding(content) {
    // Generate embedding via embeddings pathway
    const result = await callPathway('embeddings', { text: content });
    const embeddings = JSON.parse(result);
    return embeddings[0] || [];
}

async function bootloadMemories() {
    const args = parseArgs();
    
    if (!args.inputFile) {
        console.error('Error: --input file is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    // Validate required parameters
    if (!args.entityId) {
        console.error('\n✗ Error: entityId is required');
        console.error('  Set via --entityId flag or CONTINUITY_DEFAULT_ENTITY_ID environment variable\n');
        process.exit(1);
    }
    
    if (!args.userId) {
        console.error('\n✗ Error: userId is required');
        console.error('  Set via --userId flag or CONTINUITY_DEFAULT_USER_ID environment variable\n');
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('Continuity Memory Bootloader');
    console.log('='.repeat(60));
    console.log(`Input File: ${args.inputFile}`);
    console.log(`Entity ID: ${args.entityId}`);
    console.log(`User ID: ${args.userId}`);
    console.log(`Batch Size: ${args.batchSize}`);
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
            console.error('✗ Continuity memory service is not available. Check Redis and MongoDB configuration.');
            process.exit(1);
        }
        
        // Process all sections with in-memory deduplication, then batch sync to database
        const sections = ['memorySelf', 'memoryUser', 'memoryDirectives', 'memoryTopics'];
        
        const stats = await processAllSections(
            service,
            args.entityId,
            args.userId,
            memoryData,
            sections,
            args.dryRun,
            args.batchSize
        );
        
        // Summary
        console.log('');
        console.log('='.repeat(60));
        console.log('Bootload Complete');
        console.log('='.repeat(60));
        console.log(`\nInput: ${stats.inputCount} memories from file`);
        
        if (stats.mergedWithinInput > 0) {
            console.log(`  └─ ${stats.mergedWithinInput} merged (duplicates within input)`);
        }
        console.log(`  └─ ${stats.uniqueFromInput} unique`);
        
        console.log(`\nResult:`);
        if (stats.newMemories > 0) {
            console.log(`  ${stats.newMemories} new memories added`);
        }
        if (stats.duplicatesSkipped > 0) {
            console.log(`  ${stats.duplicatesSkipped} skipped (already exist)`);
        }
        if (stats.failed > 0) {
            console.log(`  ${stats.failed} failed`);
        }
        console.log('');
        
        if (args.dryRun) {
            console.log('This was a DRY RUN - no changes were made.');
            console.log('Run without --dry-run to actually store memories.');
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

