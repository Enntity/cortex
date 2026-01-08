#!/usr/bin/env node
/**
 * MongoDB Atlas Continuity Memory Index Setup
 * 
 * Creates the required collection and indexes for the continuity memory system.
 * Requires:
 *   MONGO_URI - MongoDB Atlas connection string
 * 
 * This script will:
 *   1. Create the continuity_memories collection if it doesn't exist
 *   2. Create compound indexes for efficient filtering
 *   3. Create a text index for full-text search
 *   4. Output instructions for creating the Atlas Vector Search index (must be done in Atlas UI)
 * 
 * Usage:
 *   node scripts/setup-mongo-memory-index.js [--dry-run]
 * 
 * Note: Atlas Vector Search indexes cannot be created via the driver - they must be
 * created in the Atlas UI or via the Atlas Admin API. This script will output the
 * index definition for you to copy.
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

// Configuration
const COLLECTION_NAME = 'continuity_memories';
const VECTOR_INDEX_NAME = 'continuity_vector_index';

// Parse arguments
const DRY_RUN = process.argv.includes('--dry-run');

// Vector search index definition (for Atlas UI)
const VECTOR_INDEX_DEFINITION = {
    name: VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    definition: {
        fields: [
            {
                type: 'vector',
                path: 'contentVector',
                numDimensions: 1536, // OpenAI text-embedding-3-small
                similarity: 'cosine'
            },
            // Filter fields for pre-filtering in vector search
            {
                type: 'filter',
                path: 'entityId'
            },
            {
                type: 'filter',
                path: 'userId'
            },
            {
                type: 'filter',
                path: 'type'
            },
            {
                type: 'filter',
                path: 'importance'
            },
            {
                type: 'filter',
                path: 'tags'
            }
        ]
    }
};

// Standard indexes to create
const INDEXES = [
    // Primary lookup index
    {
        name: 'idx_id',
        key: { id: 1 },
        options: { unique: true }
    },
    // Entity + User compound index (most common filter)
    {
        name: 'idx_entity_user',
        key: { entityId: 1, userId: 1 }
    },
    // Entity + User + Type (for getByType, getPromotionCandidates, etc.)
    {
        name: 'idx_entity_user_type',
        key: { entityId: 1, userId: 1, type: 1 }
    },
    // Entity + User + Importance (for getTopByImportance)
    {
        name: 'idx_entity_user_importance',
        key: { entityId: 1, userId: 1, importance: -1, timestamp: -1 }
    },
    // Entity + User + Tags (for unprocessed memories)
    {
        name: 'idx_entity_user_tags',
        key: { entityId: 1, userId: 1, tags: 1 }
    },
    // Timestamp index for sorting/filtering
    {
        name: 'idx_timestamp',
        key: { timestamp: -1 }
    },
    // Text index for full-text search
    {
        name: 'idx_text_search',
        key: { content: 'text', tags: 'text' },
        options: {
            weights: { content: 10, tags: 5 },
            name: 'idx_text_search'
        }
    }
];

async function setupIndexes() {
    const mongoUri = process.env.MONGO_URI;
    
    if (!mongoUri) {
        console.error('❌ MONGO_URI environment variable not set!');
        console.error('');
        console.error('Set the environment variable:');
        console.error('  export MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/dbname"');
        process.exit(1);
    }
    
    console.log('🧠 MongoDB Continuity Memory Index Setup');
    console.log('========================================');
    console.log(`Collection: ${COLLECTION_NAME}`);
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log('');
    
    let client;
    
    try {
        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB Atlas...');
        client = new MongoClient(mongoUri);
        await client.connect();
        
        // Get database from URI (db() without args uses the URI's database path)
        let db = client.db();
        if (!db.databaseName) {
            db = client.db('cortex');
        }
        const dbName = db.databaseName;
        console.log(`✓ Connected to database: ${dbName}`);
        console.log('');
        
        // Check if collection exists
        const collections = await db.listCollections({ name: COLLECTION_NAME }).toArray();
        const collectionExists = collections.length > 0;
        
        if (collectionExists) {
            console.log(`📋 Collection '${COLLECTION_NAME}' already exists`);
        } else {
            console.log(`📋 Creating collection '${COLLECTION_NAME}'...`);
            if (!DRY_RUN) {
                await db.createCollection(COLLECTION_NAME);
                console.log('✓ Collection created');
            } else {
                console.log('  [DRY RUN] Would create collection');
            }
        }
        console.log('');
        
        // Get existing indexes
        const collection = db.collection(COLLECTION_NAME);
        const existingIndexes = await collection.indexes();
        const existingIndexNames = new Set(existingIndexes.map(i => i.name));
        
        console.log('📇 Creating indexes...');
        console.log('');
        
        for (const indexDef of INDEXES) {
            const indexExists = existingIndexNames.has(indexDef.name) || 
                                existingIndexNames.has(indexDef.options?.name);
            
            if (indexExists) {
                console.log(`  ⏭️  ${indexDef.name} - already exists`);
            } else {
                console.log(`  ➕ ${indexDef.name} - creating...`);
                if (!DRY_RUN) {
                    try {
                        await collection.createIndex(indexDef.key, {
                            name: indexDef.name,
                            ...indexDef.options
                        });
                        console.log(`     ✓ Created`);
                    } catch (error) {
                        console.log(`     ⚠️  Failed: ${error.message}`);
                    }
                } else {
                    console.log('     [DRY RUN] Would create');
                }
            }
        }
        
        console.log('');
        console.log('========================================');
        console.log('⚠️  IMPORTANT: Atlas Vector Search Index');
        console.log('========================================');
        console.log('');
        console.log('Atlas Vector Search indexes cannot be created via the MongoDB driver.');
        console.log('You must create this index in the Atlas UI or via the Atlas Admin API.');
        console.log('');
        console.log('Steps:');
        console.log('1. Go to Atlas UI → Your Cluster → Search → Create Index');
        console.log('2. Select "JSON Editor" and paste the following:');
        console.log('');
        console.log('─'.repeat(60));
        console.log(JSON.stringify(VECTOR_INDEX_DEFINITION, null, 2));
        console.log('─'.repeat(60));
        console.log('');
        console.log('Or use the Atlas Admin API:');
        console.log('https://www.mongodb.com/docs/atlas/atlas-vector-search/create-index/');
        console.log('');
        console.log('========================================');
        console.log('');
        
        // Verify setup
        console.log('📊 Index Summary:');
        const finalIndexes = await collection.indexes();
        for (const index of finalIndexes) {
            console.log(`  • ${index.name}: ${JSON.stringify(index.key)}`);
        }
        console.log('');
        
        if (DRY_RUN) {
            console.log('This was a DRY RUN - no changes were made.');
            console.log('Run without --dry-run to apply changes.');
        } else {
            console.log('✅ Standard indexes created successfully!');
            console.log('');
            console.log('Next steps:');
            console.log('1. Create the Vector Search index in Atlas UI (see above)');
            console.log('2. Update your environment to use MongoMemoryIndex');
        }
        console.log('');
        
    } catch (error) {
        console.error('');
        console.error('❌ Setup failed!');
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

// Run
setupIndexes();

