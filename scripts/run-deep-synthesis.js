#!/usr/bin/env node
/**
 * Deep Synthesis for Continuity Memory
 * 
 * Client script that calls the sys_continuity_deep_synthesis pathway
 * and subscribes to progress updates via GraphQL subscriptions.
 * 
 * Models human sleep consolidation in two phases:
 * 
 * PHASE 1: CONSOLIDATION
 *   Walks through unprocessed memories one at a time.
 *   For each, finds similar/linked memories and decides:
 *   - ABSORB (delete redundant)
 *   - MERGE (combine into richer memory)
 *   - LINK (create graph connection)
 *   - KEEP (distinct, no action)
 * 
 * PHASE 2: DISCOVERY  
 *   Processes memories in batches to find:
 *   - Patterns across memories → nominations for CORE_EXTENSION
 *   - Contradictions to flag
 *   - Serendipitous connections
 *   
 *   CORE_EXTENSION promotion is DETERMINISTIC (not LLM-decided):
 *   - Requires 3+ nominations from different synthesis runs
 *   - First nomination must be 24+ hours old
 *   - Must not be semantically duplicate of existing CORE_EXTENSION
 * 
 * Usage:
 *   node scripts/run-deep-synthesis.js                    # Both phases (default)
 *   node scripts/run-deep-synthesis.js --phase1-only      # Consolidation only
 *   node scripts/run-deep-synthesis.js --phase2-only      # Discovery only
 *   node scripts/run-deep-synthesis.js --cortex-url http://localhost:4000
 */

import 'dotenv/config';
import { createClient } from 'graphql-ws';
import ws from 'ws';

// Defaults from environment variables
const DEFAULTS = {
    entityId: process.env.CONTINUITY_DEFAULT_ENTITY_ID || null,  // Required - set via CONTINUITY_DEFAULT_ENTITY_ID env var
    userId: process.env.CONTINUITY_DEFAULT_USER_ID || null,      // Required - set via CONTINUITY_DEFAULT_USER_ID env var
    phase1Max: 100,    // Consolidation: per-memory, so keep reasonable
    phase2Max: 100,    // Discovery: 2 batches of 50
    daysToLookBack: 90,
    cortexUrl: process.env.CONTINUITY_CORTEX_API_URL || 'http://localhost:4000'
};

function parseArgs() {
    const args = {
        entityId: DEFAULTS.entityId,
        userId: DEFAULTS.userId,
        phase1Max: null,
        phase2Max: null,
        daysToLookBack: DEFAULTS.daysToLookBack,
        runPhase1: true,
        runPhase2: true,
        cortexUrl: DEFAULTS.cortexUrl
    };
    
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        
        switch (arg) {
            case '--phase1-only':
            case '--consolidate-only':
                args.runPhase2 = false;
                break;
            case '--phase2-only':
            case '--discover-only':
                args.runPhase1 = false;
                break;
            case '--entityId':
                args.entityId = process.argv[++i];
                break;
            case '--userId':
                args.userId = process.argv[++i];
                break;
            case '--phase1-max':
                args.phase1Max = parseInt(process.argv[++i], 10);
                break;
            case '--phase2-max':
                args.phase2Max = parseInt(process.argv[++i], 10);
                break;
            case '--max':
                // Shorthand: Phase 1 gets exact value, Phase 2 gets at least 50 (one batch)
                const max = parseInt(process.argv[++i], 10);
                args.phase1Max = max;
                args.phase2Max = Math.max(max, 50); // Discovery needs at least one batch
                break;
            case '--days':
            case '--daysToLookBack':
                const val = process.argv[++i];
                args.daysToLookBack = (val === 'all' || val === '0') ? null : parseInt(val, 10);
                break;
            case '--all':
                args.daysToLookBack = null;
                args.phase1Max = 500;
                args.phase2Max = 300;
                break;
            case '--cortex-url':
                args.cortexUrl = process.argv[++i];
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }
    
    // Apply defaults
    args.phase1Max = args.phase1Max ?? DEFAULTS.phase1Max;
    args.phase2Max = args.phase2Max ?? DEFAULTS.phase2Max;
    
    return args;
}

function printHelp() {
    console.log(`
Deep Synthesis for Continuity Memory

Client script that calls the sys_continuity_deep_synthesis pathway
and subscribes to progress updates via GraphQL subscriptions.

Models human sleep consolidation to process and integrate memories.

PHASES:
  Phase 1 (Consolidation): Walks through unprocessed memories one at a time,
                           finding related memories and deciding how to integrate.
                           
  Phase 2 (Discovery):     Batch analysis for patterns, contradictions, and
                           serendipitous connections. Nominates patterns for
                           CORE_EXTENSION (promotion requires 3+ votes over 24h).

  Default runs both phases. Use flags to run individually.

OPTIONS:
  --phase1-only           Run consolidation only (skip discovery)
  --phase2-only           Run discovery only (skip consolidation)
  
  --phase1-max <n>        Max memories for consolidation (default: ${DEFAULTS.phase1Max})
  --phase2-max <n>        Max memories for discovery (default: ${DEFAULTS.phase2Max})
  --max <n>               Set Phase 1 limit; Phase 2 gets at least 50 (one batch)
  
  --days <n>              How far back to look (default: ${DEFAULTS.daysToLookBack})
                          Use "all" or 0 for no limit
  --all                   Process all memories (no date limit, higher caps)
  
  --entityId <id>         Entity identifier (required, or set CONTINUITY_DEFAULT_ENTITY_ID env var)
  --userId <id>           User/context identifier (required, or set CONTINUITY_DEFAULT_USER_ID env var)
  
  --cortex-url <url>      Cortex server URL (default: ${DEFAULTS.cortexUrl})
                          Can also set via CONTINUITY_CORTEX_API_URL environment variable
  
  --help, -h              Show this help

EXAMPLES:
  # Full sleep cycle (both phases)
  node scripts/run-deep-synthesis.js
  
  # Quick test run
  node scripts/run-deep-synthesis.js --max 5
  
  # Just consolidation
  node scripts/run-deep-synthesis.js --phase1-only
  
  # Process everything
  node scripts/run-deep-synthesis.js --all
  
  # Custom Cortex server
  node scripts/run-deep-synthesis.js --cortex-url http://localhost:5000
`);
}

// ============================================================
// CLIENT FUNCTIONS
// ============================================================

/**
 * Get fetch function (native or node-fetch)
 */
function getFetch() {
    if (globalThis.fetch) {
        return globalThis.fetch;
    }
    throw new Error('fetch is not available. Please use Node.js 18+ or install node-fetch package.');
}

/**
 * Make GraphQL query to start async pathway
 */
async function callDeepSynthesis(graphqlUrl, args) {
    const fetch = getFetch();
    const query = `
        query DeepSynthesis(
            $entityId: String!
            $userId: String!
            $phase1Max: Int
            $phase2Max: Int
            $daysToLookBack: Int
            $runPhase1: Boolean
            $runPhase2: Boolean
            $async: Boolean!
        ) {
            sys_continuity_deep_synthesis(
                entityId: $entityId
                userId: $userId
                phase1Max: $phase1Max
                phase2Max: $phase2Max
                daysToLookBack: $daysToLookBack
                runPhase1: $runPhase1
                runPhase2: $runPhase2
                async: $async
            ) {
                result
            }
        }
    `;
    
    const variables = {
        entityId: args.entityId,
        userId: args.userId,
        phase1Max: args.phase1Max,
        phase2Max: args.phase2Max,
        daysToLookBack: args.daysToLookBack,
        runPhase1: args.runPhase1,
        runPhase2: args.runPhase2,
        async: true
    };
    
    const response = await fetch(`${graphqlUrl}/graphql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables })
    });
    
    if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    
    if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }
    
    return result.data.sys_continuity_deep_synthesis.result;
}

/**
 * Subscribe to progress updates
 */
function subscribeToProgress(wsUrl, requestId) {
    return new Promise((resolve, reject) => {
        const client = createClient({
            url: wsUrl,
            webSocketImpl: ws
        });
        
        let finalResult = null;
        let lastProgress = 0;
        
        const unsubscribe = client.subscribe(
            {
                query: `
                    subscription OnProgress($requestId: String!) {
                        requestProgress(requestIds: [$requestId]) {
                            requestId
                            progress
                            data
                            info
                            error
                        }
                    }
                `,
                variables: { requestId }
            },
            {
                next: (event) => {
                    const progress = event.data?.requestProgress;
                    if (!progress) return;
                    
                    // Parse info for phase updates
                    let info = null;
                    if (progress.info) {
                        try {
                            info = JSON.parse(progress.info);
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                    
                    // Display progress
                    const currentProgress = progress.progress || 0;
                    if (currentProgress > lastProgress) {
                        const percent = Math.round(currentProgress * 100);
                        if (info?.phase) {
                            if (info.phase === 'phase1') {
                                console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                                console.log('PHASE 1: CONSOLIDATION');
                                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                            } else if (info.phase === 'phase2') {
                                console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                                console.log('PHASE 2: DISCOVERY');
                                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                            }
                            
                            if (info.message) {
                                console.log(`  ${info.message}`);
                            }
                            
                            if (info.stats) {
                                displayStats(info.stats, info.phase);
                            }
                        } else {
                            process.stdout.write(`\r  Progress: ${percent}%`);
                        }
                        lastProgress = currentProgress;
                    }
                    
                    // Parse final result
                    if (progress.progress === 1) {
                        if (progress.data) {
                            try {
                                finalResult = JSON.parse(progress.data);
                            } catch (e) {
                                // Ignore parse errors
                            }
                        }
                        
                        if (progress.error) {
                            reject(new Error(progress.error));
                        } else {
                            unsubscribe();
                            client.dispose();
                            resolve(finalResult);
                        }
                    }
                },
                error: (error) => {
                    client.dispose();
                    reject(error);
                },
                complete: () => {
                    client.dispose();
                    if (!finalResult) {
                        resolve(null);
                    }
                }
            }
        );
    });
}

/**
 * Display stats for a phase
 */
function displayStats(stats, phase) {
    if (phase === 'phase1') {
        console.log(`  Processed: ${stats.processed || 0}`);
        console.log(`  Absorbed:  ${stats.absorbed || 0} (deleted redundant)`);
        console.log(`  Merged:    ${stats.merged || 0} (combined)`);
        console.log(`  Linked:    ${stats.linked || 0} (new connections)`);
        console.log(`  Kept:      ${stats.kept || 0} (distinct)`);
        if (stats.errors > 0) {
            console.log(`  Errors:    ${stats.errors}`);
        }
    } else if (phase === 'phase2') {
        console.log(`  Consolidated: ${stats.consolidated || 0} (merged similar)`);
        console.log(`  Patterns:     ${stats.patterns || 0} (new insights)`);
        console.log(`  Nominations:  ${stats.nominations || 0} (identity candidates)`);
        console.log(`  Links:        ${stats.links || 0} (new connections)`);
        
        if (stats.promotions) {
            const p = stats.promotions;
            console.log('');
            console.log('  Promotion Processing:');
            console.log(`    Candidates:  ${p.candidates || 0}`);
            console.log(`    Promoted:    ${p.promoted || 0} → CORE_EXTENSION`);
            console.log(`    Rejected:    ${p.rejected || 0} (duplicate/similar)`);
            console.log(`    Deferred:    ${p.deferred || 0} (need more votes/time)`);
        }
    }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const args = parseArgs();
    
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
    
    // Header
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    DEEP SYNTHESIS                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Cortex:  ${args.cortexUrl}`);
    console.log(`Entity:  ${args.entityId}`);
    console.log(`User:    ${args.userId}`);
    console.log(`Lookback: ${args.daysToLookBack === null ? 'ALL' : args.daysToLookBack + ' days'}`);
    console.log(`Phases:  ${args.runPhase1 ? '1 (Consolidation)' : ''}${args.runPhase1 && args.runPhase2 ? ' + ' : ''}${args.runPhase2 ? '2 (Discovery)' : ''}`);
    console.log('');
    
    try {
        // Convert HTTP URL to WebSocket URL
        const wsUrl = args.cortexUrl.replace(/^http/, 'ws') + '/graphql';
        const graphqlUrl = args.cortexUrl;
        
        console.log('Calling sys_continuity_deep_synthesis pathway...');
        const requestId = await callDeepSynthesis(graphqlUrl, args);
        
        if (!requestId) {
            throw new Error('No request ID returned from pathway');
        }
        
        console.log(`Request ID: ${requestId}`);
        console.log('Subscribing to progress updates...\n');
        
        // Subscribe to progress
        const result = await subscribeToProgress(wsUrl, requestId);
        
        // Final summary
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                      COMPLETE                              ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        
        if (result) {
            if (result.success === false) {
                console.error(`\n✗ Deep synthesis failed: ${result.error}`);
                process.exit(1);
            }
            
            // Display final results
            if (result.phase1) {
                console.log('\nPhase 1 Results:');
                displayStats(result.phase1, 'phase1');
            }
            
            if (result.phase2) {
                console.log('\nPhase 2 Results:');
                displayStats(result.phase2, 'phase2');
            }
        }
        
        console.log('\n✓ Deep synthesis complete!\n');
        
    } catch (error) {
        console.error('\n✗ Deep synthesis failed');
        console.error(`  ${error.message}`);
        if (process.env.DEBUG) console.error(error.stack);
        process.exit(1);
    }
}

main();
