#!/usr/bin/env node
/**
 * Flux Model Benchmark Script
 * 
 * Tests different configurations for flux-11-pro, flux-2-dev, flux-2-pro, and flux-2-klein-4b
 * to find the fastest settings empirically.
 * 
 * Usage: 
 *   REPLICATE_API_TOKEN=your_token node scripts/benchmark-flux-models.js
 *   or set REPLICATE_API_TOKEN in your environment
 */

import axios from 'axios';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test configurations
const MODELS = [
    {
        name: 'flux-11-pro',
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
        supportedParams: ['width', 'height', 'steps', 'output_format', 'output_quality', 'safety_tolerance']
    },
    {
        name: 'flux-2-dev',
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
        supportedParams: ['width', 'height', 'num_inference_steps', 'guidance_scale', 'output_format', 'output_quality', 'go_fast']
    },
    {
        name: 'flux-2-pro',
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-pro/predictions',
        supportedParams: ['width', 'height', 'steps', 'guidance', 'output_format', 'output_quality', 'safety_tolerance']
    },
    {
        name: 'flux-2-klein-4b',
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-klein-4b/predictions',
        supportedParams: [
            'output_megapixels',
            'aspect_ratio',
            'output_format',
            'output_quality',
            'go_fast',
            'disable_safety_checker',
            'seed',
            'images'
        ]
    }
];

// Test prompt - simple for consistency
const TEST_PROMPT = "A friendly robot waving hello, simple illustration style, clean background";

// Configurations to test
const CONFIGURATIONS = {
    'flux-11-pro': [
        { name: 'default', params: {} },
        { name: 'steps-1', params: { steps: 1 } },
        { name: 'steps-2', params: { steps: 2 } },
        { name: 'steps-4', params: { steps: 4 } },
        { name: 'small-512', params: { width: 512, height: 512 } },
        { name: 'small-512-steps-2', params: { width: 512, height: 512, steps: 2 } },
        { name: 'small-256', params: { width: 256, height: 256 } },
        { name: 'small-256-steps-2', params: { width: 256, height: 256, steps: 2 } },
    ],
    'flux-2-dev': [
        { name: 'default', params: {} },
        { name: 'go-fast', params: { go_fast: true } },
        { name: 'steps-10', params: { num_inference_steps: 10 } },
        { name: 'steps-15', params: { num_inference_steps: 15 } },
        { name: 'steps-20', params: { num_inference_steps: 20 } },
        { name: 'steps-25', params: { num_inference_steps: 25 } },
        { name: 'go-fast-steps-10', params: { go_fast: true, num_inference_steps: 10 } },
        { name: 'go-fast-steps-15', params: { go_fast: true, num_inference_steps: 15 } },
        { name: 'small-512', params: { width: 512, height: 512 } },
        { name: 'small-512-go-fast', params: { width: 512, height: 512, go_fast: true } },
        { name: 'small-512-go-fast-steps-15', params: { width: 512, height: 512, go_fast: true, num_inference_steps: 15 } },
    ],
    'flux-2-pro': [
        { name: 'default', params: {} },
        { name: 'steps-1', params: { steps: 1 } },
        { name: 'steps-2', params: { steps: 2 } },
        { name: 'steps-4', params: { steps: 4 } },
        { name: 'guidance-2', params: { guidance: 2 } },
        { name: 'guidance-2-steps-2', params: { guidance: 2, steps: 2 } },
        { name: 'small-512', params: { width: 512, height: 512 } },
        { name: 'small-512-steps-2', params: { width: 512, height: 512, steps: 2 } },
    ],
    'flux-2-klein-4b': [
        { name: 'default', params: {} },
        { name: 'go-fast', params: { go_fast: true } },
        { name: 'mp-0.25', params: { output_megapixels: '0.25' } },
        { name: 'mp-0.5', params: { output_megapixels: '0.5' } },
        { name: 'mp-1', params: { output_megapixels: '1' } },
        { name: 'mp-2', params: { output_megapixels: '2' } },
        { name: 'mp-4', params: { output_megapixels: '4' } },
        { name: 'go-fast-mp-0.25', params: { go_fast: true, output_megapixels: '0.25' } },
        { name: 'go-fast-mp-0.5', params: { go_fast: true, output_megapixels: '0.5' } },
    ]
};

// Common base params for all tests
const BASE_PARAMS = {
    output_format: 'webp',
    output_quality: 80,
};

const BASE_PARAMS_BY_MODEL = {
    'flux-11-pro': {
        safety_tolerance: 6,
    },
    'flux-2-pro': {
        safety_tolerance: 6,
    },
    'flux-2-klein-4b': {
        output_megapixels: '1',
    },
};

function getReplicateApiKey() {
    // Try environment variable first
    if (process.env.REPLICATE_API_TOKEN) {
        return process.env.REPLICATE_API_TOKEN;
    }
    
    // Try to read from cortex config file
    const configPath = process.env.CORTEX_CONFIG_FILE;
    if (configPath) {
        try {
            const configContent = readFileSync(configPath, 'utf-8');
            const configData = JSON.parse(configContent);
            if (configData.replicateApiKey) {
                return configData.replicateApiKey;
            }
        } catch (e) {
            // Ignore config file errors
        }
    }
    
    // Try common config locations
    const possiblePaths = [
        resolve(__dirname, '../config/default.json'),
        resolve(__dirname, '../config/production.json'),
        resolve(__dirname, '../config/development.json'),
    ];
    
    for (const path of possiblePaths) {
        try {
            const configContent = readFileSync(path, 'utf-8');
            const configData = JSON.parse(configContent);
            if (configData.replicateApiKey) {
                return configData.replicateApiKey;
            }
        } catch (e) {
            // Ignore missing files
        }
    }
    
    throw new Error('REPLICATE_API_TOKEN not found. Set it via:\n  export REPLICATE_API_TOKEN=your_token\n  or in CORTEX_CONFIG_FILE');
}

async function runPrediction(model, params, apiKey) {
    const startTime = Date.now();
    
    // Start prediction
    const response = await axios.post(model.url, {
        input: {
            prompt: TEST_PROMPT,
            ...BASE_PARAMS,
            ...(BASE_PARAMS_BY_MODEL[model.name] || {}),
            ...params
        }
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    const predictionId = response.data.id;
    const pollUrl = response.data.urls?.get || `https://api.replicate.com/v1/predictions/${predictionId}`;

    // Poll for completion
    const maxAttempts = 120; // 2 minutes max
    const pollInterval = 1000; // 1 second

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        const pollResponse = await axios.get(pollUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        const status = pollResponse.data.status;
        
        if (status === 'succeeded') {
            const endTime = Date.now();
            return {
                success: true,
                duration: endTime - startTime,
                metrics: pollResponse.data.metrics,
                output: pollResponse.data.output
            };
        } else if (status === 'failed' || status === 'canceled') {
            return {
                success: false,
                error: pollResponse.data.error || status,
                duration: Date.now() - startTime
            };
        }
    }

    return {
        success: false,
        error: 'timeout',
        duration: Date.now() - startTime
    };
}

async function benchmarkModel(model, apiKey) {
    const configs = CONFIGURATIONS[model.name] || [];
    const results = [];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Benchmarking: ${model.name}`);
    console.log(`${'='.repeat(60)}`);

    for (const config of configs) {
        process.stdout.write(`  Testing "${config.name}"... `);
        
        try {
            const result = await runPrediction(model, config.params, apiKey);
            
            if (result.success) {
                const predictTime = result.metrics?.predict_time 
                    ? `${(result.metrics.predict_time * 1000).toFixed(0)}ms predict` 
                    : '';
                console.log(`✓ ${result.duration}ms total ${predictTime}`);
                results.push({
                    config: config.name,
                    params: config.params,
                    duration: result.duration,
                    predictTime: result.metrics?.predict_time,
                    success: true
                });
            } else {
                console.log(`✗ Failed: ${result.error}`);
                results.push({
                    config: config.name,
                    params: config.params,
                    error: result.error,
                    success: false
                });
            }
        } catch (error) {
            console.log(`✗ Error: ${error.message}`);
            results.push({
                config: config.name,
                params: config.params,
                error: error.message,
                success: false
            });
        }

        // Small delay between tests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
}

function printSummary(allResults) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY - Fastest Configurations');
    console.log(`${'='.repeat(60)}`);

    for (const [modelName, results] of Object.entries(allResults)) {
        const successfulResults = results.filter(r => r.success);
        
        if (successfulResults.length === 0) {
            console.log(`\n${modelName}: No successful tests`);
            continue;
        }

        // Sort by total duration
        successfulResults.sort((a, b) => a.duration - b.duration);
        
        console.log(`\n${modelName}:`);
        console.log(`  Fastest by total time:`);
        successfulResults.slice(0, 3).forEach((r, i) => {
            const predictStr = r.predictTime ? ` (predict: ${(r.predictTime * 1000).toFixed(0)}ms)` : '';
            console.log(`    ${i + 1}. ${r.config}: ${r.duration}ms${predictStr}`);
            console.log(`       params: ${JSON.stringify(r.params)}`);
        });

        // Also sort by predict time if available
        const withPredictTime = successfulResults.filter(r => r.predictTime);
        if (withPredictTime.length > 0) {
            withPredictTime.sort((a, b) => a.predictTime - b.predictTime);
            console.log(`  Fastest by predict time:`);
            withPredictTime.slice(0, 3).forEach((r, i) => {
                console.log(`    ${i + 1}. ${r.config}: ${(r.predictTime * 1000).toFixed(0)}ms predict (${r.duration}ms total)`);
            });
        }
    }
}

async function main() {
    console.log('Flux Model Benchmark');
    console.log('====================');
    console.log(`Test prompt: "${TEST_PROMPT}"`);
    console.log(`Base params: ${JSON.stringify(BASE_PARAMS)}`);
    
    let apiKey;
    try {
        apiKey = getReplicateApiKey();
        console.log('✓ Replicate API key found');
    } catch (error) {
        console.error(`✗ ${error.message}`);
        process.exit(1);
    }

    const allResults = {};

    // Parse command line args for specific model
    const args = process.argv.slice(2);
    const specificModel = args[0];

    const modelsToTest = specificModel 
        ? MODELS.filter(m => m.name.includes(specificModel))
        : MODELS;

    if (modelsToTest.length === 0) {
        console.error(`No models found matching: ${specificModel}`);
        console.log('Available models:', MODELS.map(m => m.name).join(', '));
        process.exit(1);
    }

    console.log(`\nModels to test: ${modelsToTest.map(m => m.name).join(', ')}`);
    console.log(`Total configurations: ${modelsToTest.reduce((sum, m) => sum + (CONFIGURATIONS[m.name]?.length || 0), 0)}`);

    for (const model of modelsToTest) {
        allResults[model.name] = await benchmarkModel(model, apiKey);
    }

    printSummary(allResults);

    // Output raw results as JSON for further analysis
    console.log(`\n${'='.repeat(60)}`);
    console.log('Raw results (JSON):');
    console.log(JSON.stringify(allResults, null, 2));
}

main().catch(error => {
    console.error('Benchmark failed:', error.message);
    process.exit(1);
});
