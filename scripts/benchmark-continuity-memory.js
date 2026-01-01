#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Performance Benchmark for Continuity Memory Architecture
 * 
 * Measures performance of key operations:
 * - Memory upserts
 * - Semantic searches
 * - Context window building
 * - Expression state updates
 * 
 * Usage:
 *   node scripts/benchmark-continuity-memory.js [--samples=N] [--skip-cleanup]
 * 
 * Options:
 *   --samples=N    Number of samples to run per operation (default: 10)
 *   --skip-cleanup Skip cleanup (useful for inspecting test data)
 */

import { config, buildPathways, buildModels } from '../config.js';
import { buildModelEndpoints } from '../lib/requestExecutor.js';
import { 
    getContinuityMemoryService,
    ContinuityMemoryType
} from '../lib/continuity/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const samplesArg = args.find(a => a.startsWith('--samples='));
const SAMPLES = samplesArg ? parseInt(samplesArg.split('=')[1], 10) : 10;
const SKIP_CLEANUP = args.includes('--skip-cleanup');

// Test identifiers
const TEST_ENTITY_ID = 'benchmark-entity';
const TEST_USER_ID = `benchmark-user-${Date.now()}`;

// Benchmark results
const results = {
    upsert: [],
    search: [],
    contextWindow: [],
    expressionState: [],
    memoryIds: []
};

function formatTime(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function formatStats(times) {
    if (times.length === 0) return 'N/A';
    
    const sorted = [...times].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    
    return {
        min: formatTime(min),
        max: formatTime(max),
        avg: formatTime(avg),
        median: formatTime(median),
        p95: formatTime(p95),
        p99: formatTime(p99),
        opsPerSec: (1000 / avg).toFixed(2)
    };
}

async function benchmarkUpsert(service, sampleCount) {
    console.log(`\n📝 Benchmarking Memory Upsert (${sampleCount} samples)...`);
    
    const memoryIds = [];
    
    for (let i = 0; i < sampleCount; i++) {
        const content = `Benchmark memory ${i + 1}: This is a test memory for performance measurement with some content to make it realistic.`;
        
        const start = performance.now();
        const id = await service.addMemory(TEST_ENTITY_ID, TEST_USER_ID, {
            type: ContinuityMemoryType.ANCHOR,
            content,
            importance: 5 + (i % 5),
            tags: ['benchmark', `sample-${i}`]
        });
        const end = performance.now();
        
        if (id) {
            memoryIds.push(id);
            results.upsert.push(end - start);
        }
        
        if ((i + 1) % 10 === 0) {
            process.stdout.write(`  Completed ${i + 1}/${sampleCount}...\r`);
        }
    }
    
    console.log(`  Completed ${sampleCount}/${sampleCount}      `);
    results.memoryIds = memoryIds;
    return memoryIds;
}

async function benchmarkSearch(service, sampleCount) {
    console.log(`\n🔍 Benchmarking Semantic Search (${sampleCount} samples)...`);
    
    // Wait a bit for Azure indexing (if needed)
    if (sampleCount > 0) {
        console.log('  Waiting 2s for Azure indexing...');
        await new Promise(r => setTimeout(r, 2000));
    }
    
    const queries = [
        'benchmark test performance',
        'memory content measurement',
        'test data realistic',
        'performance evaluation',
        'sample content benchmark'
    ];
    
    for (let i = 0; i < sampleCount; i++) {
        const query = queries[i % queries.length];
        
        const start = performance.now();
        await service.searchMemory({
            entityId: TEST_ENTITY_ID,
            userId: TEST_USER_ID,
            query,
            options: { limit: 10 }
        });
        const end = performance.now();
        
        results.search.push(end - start);
        
        if ((i + 1) % 10 === 0) {
            process.stdout.write(`  Completed ${i + 1}/${sampleCount}...\r`);
        }
    }
    
    console.log(`  Completed ${sampleCount}/${sampleCount}      `);
}

async function benchmarkContextWindow(service, sampleCount) {
    console.log(`\n🔨 Benchmarking Context Window Building (${sampleCount} samples)...`);
    
    const queries = [
        'help with debugging',
        'what do you remember',
        'context for conversation',
        'build narrative context',
        'assemble memory context'
    ];
    
    for (let i = 0; i < sampleCount; i++) {
        const query = queries[i % queries.length];
        
        const start = performance.now();
        await service.getContextWindow({
            entityId: TEST_ENTITY_ID,
            userId: TEST_USER_ID,
            query,
            options: {
                episodicLimit: 10,
                memoryLimit: 5,
                expandGraph: false
            }
        });
        const end = performance.now();
        
        results.contextWindow.push(end - start);
        
        if ((i + 1) % 10 === 0) {
            process.stdout.write(`  Completed ${i + 1}/${sampleCount}...\r`);
        }
    }
    
    console.log(`  Completed ${sampleCount}/${sampleCount}      `);
}

async function benchmarkExpressionState(service, sampleCount) {
    console.log(`\n💭 Benchmarking Expression State Updates (${sampleCount} samples)...`);
    
    const personalities = ['helpful-technical', 'warm-supportive', 'analytical', 'creative', 'practical'];
    
    for (let i = 0; i < sampleCount; i++) {
        const personality = personalities[i % personalities.length];
        
        const start = performance.now();
        await service.updateExpressionState(TEST_ENTITY_ID, TEST_USER_ID, {
            basePersonality: personality,
            emotionalResonance: { valence: 'curiosity', intensity: 0.7 + (i % 3) * 0.1 },
            situationalAdjustments: ['test-mode', `iteration-${i}`]
        });
        const end = performance.now();
        
        results.expressionState.push(end - start);
        
        if ((i + 1) % 10 === 0) {
            process.stdout.write(`  Completed ${i + 1}/${sampleCount}...\r`);
        }
    }
    
    console.log(`  Completed ${sampleCount}/${sampleCount}      `);
}

async function cleanup(service) {
    if (SKIP_CLEANUP) {
        console.log('\n🧹 Skipping cleanup (--skip-cleanup flag set)');
        return;
    }
    
    console.log('\n🧹 Cleaning up benchmark data...');
    
    try {
        // Delete memories
        let deleted = 0;
        for (const id of results.memoryIds) {
            await service.deleteMemory(id);
            deleted++;
        }
        console.log(`  Deleted ${deleted} test memories from Azure`);
        
        // Clear Redis data
        await service.hotMemory.clearEpisodicStream(TEST_ENTITY_ID, TEST_USER_ID);
        await service.hotMemory.invalidateActiveContext(TEST_ENTITY_ID, TEST_USER_ID);
        console.log('  Cleared Redis test data');
    } catch (error) {
        console.error(`  Cleanup error: ${error.message}`);
    }
}

function printResults() {
    console.log('\n' + '='.repeat(70));
    console.log('📊 Benchmark Results');
    console.log('='.repeat(70));
    
    console.log('\n📝 Memory Upsert:');
    const upsertStats = formatStats(results.upsert);
    console.log(`  Samples: ${results.upsert.length}`);
    console.log(`  Min: ${upsertStats.min} | Max: ${upsertStats.max} | Avg: ${upsertStats.avg}`);
    console.log(`  Median: ${upsertStats.median} | P95: ${upsertStats.p95} | P99: ${upsertStats.p99}`);
    console.log(`  Throughput: ${upsertStats.opsPerSec} ops/sec`);
    
    console.log('\n🔍 Semantic Search:');
    const searchStats = formatStats(results.search);
    console.log(`  Samples: ${results.search.length}`);
    console.log(`  Min: ${searchStats.min} | Max: ${searchStats.max} | Avg: ${searchStats.avg}`);
    console.log(`  Median: ${searchStats.median} | P95: ${searchStats.p95} | P99: ${searchStats.p99}`);
    console.log(`  Throughput: ${searchStats.opsPerSec} ops/sec`);
    
    console.log('\n🔨 Context Window Building:');
    const contextStats = formatStats(results.contextWindow);
    console.log(`  Samples: ${results.contextWindow.length}`);
    console.log(`  Min: ${contextStats.min} | Max: ${contextStats.max} | Avg: ${contextStats.avg}`);
    console.log(`  Median: ${contextStats.median} | P95: ${contextStats.p95} | P99: ${contextStats.p99}`);
    console.log(`  Throughput: ${contextStats.opsPerSec} ops/sec`);
    
    console.log('\n💭 Expression State Updates:');
    const exprStats = formatStats(results.expressionState);
    console.log(`  Samples: ${results.expressionState.length}`);
    console.log(`  Min: ${exprStats.min} | Max: ${exprStats.max} | Avg: ${exprStats.avg}`);
    console.log(`  Median: ${exprStats.median} | P95: ${exprStats.p95} | P99: ${exprStats.p99}`);
    console.log(`  Throughput: ${exprStats.opsPerSec} ops/sec`);
    
    console.log('\n' + '='.repeat(70));
}

async function runBenchmark() {
    console.log('⚡ Continuity Memory Performance Benchmark');
    console.log('='.repeat(70));
    console.log(`Entity: ${TEST_ENTITY_ID}`);
    console.log(`User: ${TEST_USER_ID}`);
    console.log(`Samples per operation: ${SAMPLES}`);
    console.log(`Skip cleanup: ${SKIP_CLEANUP}`);
    
    let service;
    
    try {
        // Initialize pathways and models
        console.log('\n⚡ Initializing pathways and models...');
        await buildPathways(config);
        buildModels(config);
        buildModelEndpoints(config);
        
        // Initialize service
        console.log('⚡ Initializing ContinuityMemoryService...');
        service = getContinuityMemoryService();
        
        // Wait for Redis to be ready
        await service.hotMemory.waitForReady(5000);
        
        // Initialize session
        await service.initSession(TEST_ENTITY_ID, TEST_USER_ID, true);
        
        console.log('✅ Service ready');
    } catch (error) {
        console.error(`\n❌ Failed to initialize: ${error.message}`);
        process.exit(1);
    }
    
    const overallStart = performance.now();
    
    // Run benchmarks
    await benchmarkUpsert(service, SAMPLES);
    await benchmarkSearch(service, SAMPLES);
    await benchmarkContextWindow(service, SAMPLES);
    await benchmarkExpressionState(service, SAMPLES);
    
    const overallEnd = performance.now();
    
    // Print results
    printResults();
    
    console.log(`\n⏱️  Total benchmark time: ${formatTime(overallEnd - overallStart)}`);
    console.log(`   Operations: ${SAMPLES * 4} total`);
    console.log(`   Avg time per operation: ${formatTime((overallEnd - overallStart) / (SAMPLES * 4))}`);
    
    // Cleanup
    await cleanup(service);
    
    // Close Redis connection to allow process to exit
    service.close();
    
    console.log('\n✅ Benchmark complete!\n');
    
    // Explicitly exit to ensure process terminates
    process.exit(0);
}

// Run
runBenchmark().catch(error => {
    console.error('\n💥 Unexpected error:', error.message);
    if (process.env.DEBUG) {
        console.error(error.stack);
    }
    process.exit(1);
});

