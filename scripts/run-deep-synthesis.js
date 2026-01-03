#!/usr/bin/env node
/**
 * Run Deep Synthesis for Continuity Memory
 * 
 * Executes the deep synthesis job (consolidation, pattern recognition) for a specific entity/user.
 * This is the "sleep" job that processes memories in the background.
 * 
 * Usage:
 *   node scripts/run-deep-synthesis.js
 * 
 * Or with custom parameters:
 *   node scripts/run-deep-synthesis.js --entityId Luna --userId 057650da-eeec-4bf8-99a1-cb71e801bc07 --maxMemories 100 --daysToLookBack 14
 */

import 'dotenv/config';
import serverFactory from '../index.js';
import { callPathway } from '../lib/pathwayTools.js';
import logger from '../lib/logger.js';

const DEFAULT_ENTITY_ID = 'Luna';
const DEFAULT_USER_ID = '057650da-eeec-4bf8-99a1-cb71e801bc07';
const DEFAULT_MAX_MEMORIES = 300;  // Increased for larger memory corpuses
const DEFAULT_DAYS_TO_LOOK_BACK = 90;  // Increased to cover more history

// Parse command line arguments
function parseArgs() {
    const args = {
        entityId: DEFAULT_ENTITY_ID,
        userId: DEFAULT_USER_ID,
        maxMemories: DEFAULT_MAX_MEMORIES,
        daysToLookBack: DEFAULT_DAYS_TO_LOOK_BACK
    };
    
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--entityId' && i + 1 < process.argv.length) {
            args.entityId = process.argv[++i];
        } else if (arg === '--userId' && i + 1 < process.argv.length) {
            args.userId = process.argv[++i];
        } else if (arg === '--maxMemories' && i + 1 < process.argv.length) {
            args.maxMemories = parseInt(process.argv[++i], 10);
        } else if (arg === '--daysToLookBack' && i + 1 < process.argv.length) {
            const value = process.argv[++i];
            args.daysToLookBack = value === 'all' || value === '0' ? null : parseInt(value, 10);
        } else if (arg === '--all') {
            // Analyze all memories (no date limit, max out memory limit)
            args.daysToLookBack = null;
            args.maxMemories = 1000;  // Large enough to cover most corpuses
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/run-deep-synthesis.js [options]

Options:
  --entityId <id>        Entity identifier (default: ${DEFAULT_ENTITY_ID})
  --userId <id>          User/context identifier (default: ${DEFAULT_USER_ID})
  --maxMemories <n>      Maximum memories to analyze (default: ${DEFAULT_MAX_MEMORIES})
  --daysToLookBack <n>   How far back to look for memories (default: ${DEFAULT_DAYS_TO_LOOK_BACK})
                          Use "all" or 0 to analyze all memories regardless of date
  --all                  Analyze all memories (sets daysToLookBack=null, maxMemories=1000)
  --help, -h             Show this help message

Examples:
  # Default: last 90 days, up to 300 memories
  node scripts/run-deep-synthesis.js --entityId Luna --userId 057650da-eeec-4bf8-99a1-cb71e801bc07
  
  # Analyze all memories (recommended for initial deduplication)
  node scripts/run-deep-synthesis.js --all
  
  # Custom: last 30 days, up to 500 memories
  node scripts/run-deep-synthesis.js --maxMemories 500 --daysToLookBack 30
            `);
            process.exit(0);
        }
    }
    
    return args;
}

async function runDeepSynthesis() {
    const args = parseArgs();
    
    console.log('='.repeat(60));
    console.log('Deep Synthesis Job');
    console.log('='.repeat(60));
    console.log(`Entity ID: ${args.entityId}`);
    console.log(`User ID: ${args.userId}`);
    console.log(`Max Memories: ${args.maxMemories}`);
    console.log(`Days to Look Back: ${args.daysToLookBack === null ? 'ALL (no date limit)' : args.daysToLookBack}`);
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
        
        // Call the deep synthesis pathway
        console.log('Starting deep synthesis...');
        const startTime = Date.now();
        
        const result = await callPathway('sys_continuity_deep_synthesis', {
            entityId: args.entityId,
            userId: args.userId,
            maxMemories: args.maxMemories,
            daysToLookBack: args.daysToLookBack
        });
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        // Parse the JSON result
        let parsedResult;
        try {
            parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
        } catch {
            parsedResult = { raw: result };
        }
        
        console.log('');
        console.log('='.repeat(60));
        console.log('Deep Synthesis Complete');
        console.log('='.repeat(60));
        console.log(`Duration: ${duration}s`);
        console.log('');
        console.log('Results:');
        console.log(JSON.stringify(parsedResult, null, 2));
        console.log('');
        
        if (parsedResult.success) {
            console.log(`✓ Consolidated: ${parsedResult.consolidated || 0} memories`);
            console.log(`✓ Patterns found: ${parsedResult.patterns || 0}`);
            console.log(`✓ Links created: ${parsedResult.links || 0}`);
            console.log('');
            console.log('Deep synthesis completed successfully!');
        } else {
            console.error(`✗ Deep synthesis failed: ${parsedResult.error || 'Unknown error'}`);
            process.exit(1);
        }
        
    } catch (error) {
        console.error('');
        console.error('='.repeat(60));
        console.error('Deep Synthesis Failed');
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
runDeepSynthesis();

