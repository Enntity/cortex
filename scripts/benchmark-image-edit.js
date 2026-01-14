#!/usr/bin/env node
/**
 * Image Edit Benchmark Script
 * 
 * Compares flux-2-dev vs qwen-image-edit-2511 for editing images with a reference.
 * 
 * Usage: 
 *   REPLICATE_API_TOKEN=your_token node scripts/benchmark-image-edit.js
 */

import axios from 'axios';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Will be set after generating the reference image
let REFERENCE_IMAGE = null;

// Prompt for generating the reference image
const GENERATE_PROMPT = "A friendly robot character, portrait style, simple clean background, digital art";

// Test prompt for editing
const EDIT_PROMPT = "Same robot character but now waving hello with a big smile, same style";

const MODELS = {
    'flux-2-dev': {
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
        imageParam: 'image', // flux uses 'image' for reference
        supportsImageInput: true
    },
    'qwen-image-edit-2511': {
        url: 'https://api.replicate.com/v1/models/qwen/qwen-image-edit-2511/predictions',
        imageParam: 'image',
        supportsImageInput: true
    }
};

// Configurations to test
const CONFIGURATIONS = {
    'flux-2-dev': [
        { name: 'default-with-ref', params: { } },
        { name: 'go-fast-with-ref', params: { go_fast: true } },
        { name: 'small-512-go-fast-ref', params: { width: 512, height: 512, go_fast: true } },
        { name: 'small-512-go-fast-steps15-ref', params: { width: 512, height: 512, go_fast: true, num_inference_steps: 15 } },
        { name: 'small-512-go-fast-steps20-ref', params: { width: 512, height: 512, go_fast: true, num_inference_steps: 20 } },
    ],
    'qwen-image-edit-2511': [
        { name: 'default-with-ref', params: { } },
        { name: 'go-fast', params: { go_fast: true } },
        { name: 'go-fast-steps20', params: { go_fast: true, num_inference_steps: 20 } },
        { name: 'go-fast-steps30', params: { go_fast: true, num_inference_steps: 30 } },
        { name: 'aspect-1x1', params: { aspect_ratio: '1:1' } },
        { name: 'aspect-1x1-go-fast', params: { aspect_ratio: '1:1', go_fast: true } },
        { name: 'aspect-1x1-go-fast-steps20', params: { aspect_ratio: '1:1', go_fast: true, num_inference_steps: 20 } },
    ]
};

// Common base params
const BASE_PARAMS = {
    output_format: 'webp',
    output_quality: 80,
};

async function generateReferenceImage(apiKey) {
    console.log('\nGenerating reference image first...');
    const startTime = Date.now();
    
    const response = await axios.post(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
        {
            input: {
                prompt: GENERATE_PROMPT,
                width: 512,
                height: 512,
                output_format: 'webp',
                output_quality: 80
            }
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const predictionId = response.data.id;
    const pollUrl = response.data.urls?.get || `https://api.replicate.com/v1/predictions/${predictionId}`;

    // Poll for completion
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const pollResponse = await axios.get(pollUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (pollResponse.data.status === 'succeeded') {
            const output = pollResponse.data.output;
            const imageUrl = Array.isArray(output) ? output[0] : output;
            console.log(`✓ Reference image generated in ${Date.now() - startTime}ms`);
            console.log(`  URL: ${imageUrl}`);
            return imageUrl;
        } else if (pollResponse.data.status === 'failed') {
            throw new Error(`Failed to generate reference: ${pollResponse.data.error}`);
        }
    }
    
    throw new Error('Timeout generating reference image');
}

function getReplicateApiKey() {
    if (process.env.REPLICATE_API_TOKEN) {
        return process.env.REPLICATE_API_TOKEN;
    }
    
    const configPath = process.env.CORTEX_CONFIG_FILE;
    if (configPath) {
        try {
            const configContent = readFileSync(configPath, 'utf-8');
            const configData = JSON.parse(configContent);
            if (configData.replicateApiKey) {
                return configData.replicateApiKey;
            }
        } catch (e) { }
    }
    
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
        } catch (e) { }
    }
    
    throw new Error('REPLICATE_API_TOKEN not found');
}

async function runPrediction(modelName, modelConfig, params, apiKey) {
    const startTime = Date.now();
    
    const input = {
        prompt: EDIT_PROMPT,
        ...BASE_PARAMS,
        ...params,
    };
    
    // Add reference image with the correct param name for each model
    // qwen expects an array, flux expects a string
    if (modelName.includes('qwen')) {
        input[modelConfig.imageParam] = [REFERENCE_IMAGE];
    } else {
        input[modelConfig.imageParam] = REFERENCE_IMAGE;
    }
    
    // Start prediction
    const response = await axios.post(modelConfig.url, { input }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    const predictionId = response.data.id;
    const pollUrl = response.data.urls?.get || `https://api.replicate.com/v1/predictions/${predictionId}`;

    // Poll for completion
    const maxAttempts = 180; // 3 minutes max
    const pollInterval = 1000;

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

    return { success: false, error: 'timeout', duration: Date.now() - startTime };
}

async function benchmarkModel(modelName, apiKey) {
    const modelConfig = MODELS[modelName];
    const configs = CONFIGURATIONS[modelName] || [];
    const results = [];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Benchmarking: ${modelName} (with reference image)`);
    console.log(`${'='.repeat(60)}`);

    for (const config of configs) {
        process.stdout.write(`  Testing "${config.name}"... `);
        
        try {
            const result = await runPrediction(modelName, modelConfig, config.params, apiKey);
            
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
            console.log(`✗ Error: ${error.response?.data?.detail || error.message}`);
            results.push({
                config: config.name,
                params: config.params,
                error: error.message,
                success: false
            });
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
}

function printSummary(allResults) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY - Fastest Configurations (with reference image)');
    console.log(`${'='.repeat(60)}`);

    for (const [modelName, results] of Object.entries(allResults)) {
        const successfulResults = results.filter(r => r.success);
        
        if (successfulResults.length === 0) {
            console.log(`\n${modelName}: No successful tests`);
            continue;
        }

        successfulResults.sort((a, b) => a.duration - b.duration);
        
        console.log(`\n${modelName}:`);
        console.log(`  Fastest by total time:`);
        successfulResults.slice(0, 3).forEach((r, i) => {
            const predictStr = r.predictTime ? ` (predict: ${(r.predictTime * 1000).toFixed(0)}ms)` : '';
            console.log(`    ${i + 1}. ${r.config}: ${r.duration}ms${predictStr}`);
            console.log(`       params: ${JSON.stringify(r.params)}`);
        });

        const withPredictTime = successfulResults.filter(r => r.predictTime);
        if (withPredictTime.length > 0) {
            withPredictTime.sort((a, b) => a.predictTime - b.predictTime);
            console.log(`  Fastest by predict time:`);
            withPredictTime.slice(0, 3).forEach((r, i) => {
                console.log(`    ${i + 1}. ${r.config}: ${(r.predictTime * 1000).toFixed(0)}ms predict (${r.duration}ms total)`);
            });
        }
    }

    // Cross-model comparison
    console.log(`\n${'='.repeat(60)}`);
    console.log('CROSS-MODEL COMPARISON');
    console.log(`${'='.repeat(60)}`);
    
    const allSuccessful = [];
    for (const [modelName, results] of Object.entries(allResults)) {
        for (const r of results.filter(r => r.success)) {
            allSuccessful.push({ model: modelName, ...r });
        }
    }
    
    if (allSuccessful.length > 0) {
        allSuccessful.sort((a, b) => a.duration - b.duration);
        console.log('\nOverall fastest (by total time):');
        allSuccessful.slice(0, 5).forEach((r, i) => {
            const predictStr = r.predictTime ? ` (predict: ${(r.predictTime * 1000).toFixed(0)}ms)` : '';
            console.log(`  ${i + 1}. ${r.model} / ${r.config}: ${r.duration}ms${predictStr}`);
        });
    }
}

async function main() {
    console.log('Image Edit Benchmark (with reference image)');
    console.log('===========================================');
    console.log(`Edit prompt: "${EDIT_PROMPT}"`);
    
    let apiKey;
    try {
        apiKey = getReplicateApiKey();
        console.log('✓ Replicate API key found');
    } catch (error) {
        console.error(`✗ ${error.message}`);
        process.exit(1);
    }

    // Generate reference image first
    try {
        REFERENCE_IMAGE = await generateReferenceImage(apiKey);
    } catch (error) {
        console.error(`✗ Failed to generate reference image: ${error.message}`);
        process.exit(1);
    }

    const allResults = {};
    
    const args = process.argv.slice(2);
    const specificModel = args[0];
    
    const modelsToTest = specificModel
        ? Object.keys(MODELS).filter(m => m.includes(specificModel))
        : Object.keys(MODELS);

    console.log(`\nModels to test: ${modelsToTest.join(', ')}`);

    for (const modelName of modelsToTest) {
        allResults[modelName] = await benchmarkModel(modelName, apiKey);
    }

    printSummary(allResults);

    console.log(`\n${'='.repeat(60)}`);
    console.log('Raw results (JSON):');
    console.log(JSON.stringify(allResults, null, 2));
}

main().catch(error => {
    console.error('Benchmark failed:', error.message);
    process.exit(1);
});
