#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Setup script for Continuity Memory Azure AI Search Index
 * 
 * This script creates the Azure AI Search index required for the
 * Continuity Memory Architecture (Luna v4.0).
 * 
 * Usage:
 *   node scripts/setup-continuity-memory-index.js [options]
 * 
 * Options:
 *   --dry-run       Preview what will happen without making changes
 *   --force         Delete and recreate if index exists (DESTRUCTIVE - requires confirmation)
 *   --yes           Skip confirmation prompts (use with caution in production!)
 *   --dimensions=N  Override vector dimensions (default: 1536)
 * 
 * Environment variables required:
 *   AZURE_COGNITIVE_API_URL - Azure AI Search endpoint
 *   AZURE_COGNITIVE_API_KEY - Admin API key for index creation
 * 
 */
import * as readline from 'readline';

// Use stable API version that matches existing code
const API_VERSION = '2023-11-01';
const INDEX_NAME = 'index-continuity-memory';

// Vector dimensions for embeddings
// Using oai-text-embedding-3-large at 1536 dimensions (best quality, same size as ada-002)
// - oai-text-embedding-3-large: 3072 native, but can output 1536 with 'dimensions' param
// - oai-text-embedding-3-small: 1536 dimensions
// - text-embedding-ada-002: 1536 dimensions (legacy)

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const SKIP_CONFIRM = args.includes('--yes');
const dimensionsArg = args.find(a => a.startsWith('--dimensions='));
const VECTOR_DIMENSIONS = dimensionsArg ? parseInt(dimensionsArg.split('=')[1], 10) : 1536;

/**
 * Index schema for Continuity Memory
 * 
 * IMPORTANT: Field names must match what AzureMemoryIndex.js expects!
 */
const INDEX_SCHEMA = {
    name: INDEX_NAME,
    fields: [
        // Key field
        { name: 'id', type: 'Edm.String', key: true, filterable: true },
        
        // Partition fields (for multi-tenant support)
        { name: 'entityId', type: 'Edm.String', filterable: true, searchable: false },
        { name: 'userId', type: 'Edm.String', filterable: true, searchable: false },
        
        // Memory type (CORE, ANCHOR, ARTIFACT, IDENTITY, EPISODE, etc.)
        { name: 'type', type: 'Edm.String', filterable: true, facetable: true, searchable: false },
        
        // Main content
        { name: 'content', type: 'Edm.String', searchable: true, analyzer: 'standard.lucene' },
        
        // Vector embedding for semantic search
        {
            name: 'contentVector',
            type: 'Collection(Edm.Single)',
            searchable: true,
            dimensions: VECTOR_DIMENSIONS,
            vectorSearchProfile: 'continuity-vector-profile'
        },
        
        // Graph relationships (stored as JSON array strings - Azure doesn't support nested objects well)
        { name: 'relatedMemoryIds', type: 'Collection(Edm.String)', filterable: false, searchable: false },
        { name: 'parentMemoryId', type: 'Edm.String', filterable: true, searchable: false },
        
        // Tags for filtering
        { name: 'tags', type: 'Collection(Edm.String)', filterable: true, facetable: true },
        
        // Timestamps
        { name: 'timestamp', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
        { name: 'lastAccessed', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
        
        // Decay and importance metrics (Luna's formula)
        { name: 'recallCount', type: 'Edm.Int32', filterable: true, sortable: true },
        { name: 'importance', type: 'Edm.Int32', filterable: true, sortable: true },
        { name: 'confidence', type: 'Edm.Double', filterable: true },
        { name: 'decayRate', type: 'Edm.Double', filterable: false },
        
        // Emotional state - stored as JSON string (Azure AI Search doesn't support complex nested types well)
        // AzureMemoryIndex.js will JSON.stringify/parse these
        { name: 'emotionalState', type: 'Edm.String', searchable: false },
        
        // Relational context - stored as JSON string
        { name: 'relationalContext', type: 'Edm.String', searchable: false },
        
        // Synthesis metadata
        { name: 'synthesizedFrom', type: 'Collection(Edm.String)', filterable: false, searchable: false },
        { name: 'synthesisType', type: 'Edm.String', filterable: true, facetable: true }
    ],
    
    // Vector search configuration
    vectorSearch: {
        algorithms: [
            {
                name: 'continuity-hnsw',
                kind: 'hnsw',
                hnswParameters: {
                    m: 4,
                    efConstruction: 400,
                    efSearch: 500,
                    metric: 'cosine'
                }
            }
        ],
        profiles: [
            {
                name: 'continuity-vector-profile',
                algorithm: 'continuity-hnsw'
            }
        ]
    },
    
    // NOTE: Scoring profiles omitted - Luna's decay formula is applied in code
    // (AzureMemoryIndex._rerankResults) after vector search results are returned.
    // This keeps the index simple and avoids double-boosting.
};

/**
 * Prompt user for confirmation
 */
async function confirm(message) {
    if (SKIP_CONFIRM) {
        console.log(`${message} (auto-confirmed with --yes)`);
        return true;
    }
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        rl.question(`${message} (y/N): `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

async function createIndex() {
    // Get configuration
    let apiUrl, apiKey;
    
    try {
        apiUrl = process.env.AZURE_COGNITIVE_API_URL;
        apiKey = process.env.AZURE_COGNITIVE_API_KEY;
    } catch (e) {
        apiUrl = process.env.AZURE_COGNITIVE_API_URL;
        apiKey = process.env.AZURE_COGNITIVE_API_KEY;
    }
    
    if (!apiUrl || !apiKey) {
        console.error('❌ Missing Azure AI Search configuration!');
        console.error('');
        console.error('Set environment variables:');
        console.error('  export AZURE_COGNITIVE_API_URL="https://your-search.search.windows.net"');
        console.error('  export AZURE_COGNITIVE_API_KEY="your-admin-api-key"');
        console.error('');
        console.error('Or set in config/default.json:');
        console.error('  azureCognitiveApiUrl');
        console.error('  azureCognitiveApiKey');
        process.exit(1);
    }
    
    // Normalize URL
    apiUrl = apiUrl.replace(/\/$/, '');
    
    console.log('🧠 Continuity Memory Index Setup');
    console.log('================================');
    console.log(`Endpoint: ${apiUrl}`);
    console.log(`Index: ${INDEX_NAME}`);
    console.log(`API Version: ${API_VERSION}`);
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log('');
    
    // Validate endpoint format
    if (!apiUrl.includes('.search.windows.net')) {
        console.warn('⚠️  Warning: URL does not look like Azure AI Search endpoint');
        console.warn('   Expected format: https://your-service.search.windows.net');
        console.log('');
    }
    
    // Check if index exists
    console.log('📋 Checking if index exists...');
    
    const checkUrl = `${apiUrl}/indexes/${INDEX_NAME}?api-version=${API_VERSION}`;
    let indexExists = false;
    
    try {
        const checkResponse = await fetch(checkUrl, {
            method: 'GET',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json'
            }
        });
        
        if (checkResponse.ok) {
            indexExists = true;
            const existingIndex = await checkResponse.json();
            console.log(`✅ Index exists with ${existingIndex.fields?.length || 0} fields`);
            
            if (!FORCE) {
                console.log('');
                console.log('Index already exists. Options:');
                console.log('  --force   Delete and recreate (⚠️  DESTRUCTIVE - all data will be lost!)');
                console.log('');
                console.log('No changes made.');
                process.exit(0);
            }
        } else if (checkResponse.status === 404) {
            console.log('Index does not exist (will create)');
        } else {
            const errorText = await checkResponse.text();
            console.error(`❌ Error checking index: ${checkResponse.status}`);
            console.error(errorText);
            process.exit(1);
        }
    } catch (error) {
        if (error.cause?.code === 'ENOTFOUND') {
            console.error('❌ Cannot reach Azure AI Search endpoint!');
            console.error(`   URL: ${apiUrl}`);
            console.error('   Check your network connection and endpoint URL');
            process.exit(1);
        }
        throw error;
    }
    
    // Handle force delete
    if (indexExists && FORCE) {
        console.log('');
        console.log('⚠️  WARNING: --force flag detected!');
        console.log('   This will DELETE the existing index and ALL its data.');
        console.log('   This action CANNOT be undone!');
        console.log('');
        
        if (DRY_RUN) {
            console.log('[DRY RUN] Would delete existing index');
        } else {
            const confirmed = await confirm('Are you sure you want to delete the existing index?');
            
            if (!confirmed) {
                console.log('');
                console.log('Aborted. No changes made.');
                process.exit(0);
            }
            
            console.log('');
            console.log('🗑️  Deleting existing index...');
            
            const deleteResponse = await fetch(checkUrl, {
                method: 'DELETE',
                headers: {
                    'api-key': apiKey
                }
            });
            
            if (!deleteResponse.ok && deleteResponse.status !== 404) {
                const error = await deleteResponse.text();
                console.error(`❌ Failed to delete index: ${error}`);
                process.exit(1);
            }
            
            console.log('✅ Existing index deleted');
        }
    }
    
    // Create index
    console.log('');
    console.log('🔨 Creating index...');
    
    if (DRY_RUN) {
        console.log('[DRY RUN] Would create index with schema:');
        console.log('');
        console.log('Fields:');
        for (const field of INDEX_SCHEMA.fields) {
            const attrs = [];
            if (field.key) attrs.push('KEY');
            if (field.filterable) attrs.push('filterable');
            if (field.searchable) attrs.push('searchable');
            if (field.sortable) attrs.push('sortable');
            if (field.facetable) attrs.push('facetable');
            if (field.dimensions) attrs.push(`vector(${field.dimensions})`);
            console.log(`  ${field.name}: ${field.type} [${attrs.join(', ')}]`);
        }
        console.log('');
        console.log('Vector Search: HNSW algorithm, cosine metric');
        console.log('Decay Scoring: Applied in code (AzureMemoryIndex._rerankResults)');
        console.log('');
        console.log('[DRY RUN] No changes made. Remove --dry-run to create index.');
        process.exit(0);
    }
    
    const createUrl = `${apiUrl}/indexes?api-version=${API_VERSION}`;
    
    const createResponse = await fetch(createUrl, {
        method: 'POST',
        headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(INDEX_SCHEMA)
    });
    
    if (!createResponse.ok) {
        const error = await createResponse.text();
        console.error('❌ Failed to create index!');
        console.error('');
        console.error('Status:', createResponse.status);
        console.error('Response:', error);
        console.error('');
        console.error('Common issues:');
        console.error('  - API key may be read-only (need admin key)');
        console.error('  - Schema may have invalid field types');
        console.error('  - Vector search may not be enabled on your tier');
        process.exit(1);
    }
    
    const result = await createResponse.json();
    
    console.log('✅ Index created successfully!');
    console.log('');
    console.log('Index details:');
    console.log(`  Name: ${result.name}`);
    console.log(`  Fields: ${result.fields.length}`);
    console.log(`  Vector Search: Enabled (${VECTOR_DIMENSIONS} dimensions, HNSW/cosine)`);
    console.log('');
    console.log('🎉 Ready to use Continuity Memory!');
    console.log('');
    console.log('To enable for an entity, set:');
    console.log('  useContinuityMemory: true');
}

// Run
createIndex().catch(error => {
    console.error('❌ Error:', error.message);
    if (error.stack && process.env.DEBUG) {
        console.error(error.stack);
    }
    process.exit(1);
});
