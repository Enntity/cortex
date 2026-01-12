#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Migration Script: entityId "Luna" → UUID
 * 
 * Updates all continuity memory documents where entityId is "Luna"
 * to use the new UUID: 7e8ed8ec-b786-4fdf-b91e-a1e810bc44bd
 * 
 * Usage:
 *   node scripts/migrate-entityId-luna-to-uuid.js           # Dry run (preview)
 *   node scripts/migrate-entityId-luna-to-uuid.js --execute # Actually migrate
 * 
 * Requirements:
 *   - MONGO_URI environment variable must be set
 */

import { MongoClient } from 'mongodb';

const EXECUTE = process.argv.includes('--execute');
const COLLECTION_NAME = 'continuity_memories';

// Migration mapping
const OLD_ENTITY_ID = 'Luna';
const NEW_ENTITY_ID = '7e8ed8ec-b786-4fdf-b91e-a1e810bc44bd';

async function migrate() {
    console.log('═'.repeat(60));
    console.log('Migration: entityId "Luna" → UUID');
    console.log('═'.repeat(60));
    console.log(`\nOld entityId: ${OLD_ENTITY_ID}`);
    console.log(`New entityId: ${NEW_ENTITY_ID}\n`);
    
    if (!EXECUTE) {
        console.log('⚠️  DRY RUN MODE - No changes will be made');
        console.log('   Run with --execute to apply changes\n');
    } else {
        console.log('🔧 EXECUTE MODE - Changes will be applied\n');
    }
    
    const connectionString = process.env.MONGO_URI;
    if (!connectionString) {
        console.error('❌ Error: MONGO_URI environment variable is required');
        process.exit(1);
    }
    
    let client;
    
    try {
        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        client = new MongoClient(connectionString);
        await client.connect();
        
        const db = client.db();
        const collection = db.collection(COLLECTION_NAME);
        
        console.log(`📂 Using database: ${db.databaseName}`);
        console.log(`📂 Using collection: ${COLLECTION_NAME}\n`);
        
        // Count documents to migrate
        const count = await collection.countDocuments({ entityId: OLD_ENTITY_ID });
        
        console.log(`📊 Found ${count} documents with entityId="${OLD_ENTITY_ID}"\n`);
        
        if (count === 0) {
            console.log('✅ No documents need migration. All done!\n');
            await client.close();
            return;
        }
        
        // Show sample of what will be migrated
        console.log('📋 Sample documents to migrate:');
        const sample = await collection.find({ entityId: OLD_ENTITY_ID }).limit(5).toArray();
        for (const doc of sample) {
            console.log(`   - id: ${doc.id}, type: ${doc.type}, content: "${(doc.content || '').substring(0, 50)}..."`);
        }
        if (count > 5) {
            console.log(`   ... and ${count - 5} more\n`);
        } else {
            console.log('');
        }
        
        if (!EXECUTE) {
            console.log('🔍 DRY RUN: Would update entityId from:');
            console.log(`   "${OLD_ENTITY_ID}" → "${NEW_ENTITY_ID}"\n`);
            console.log('Run with --execute to apply changes.');
            await client.close();
            return;
        }
        
        // Execute migration using bulk update
        console.log('🚀 Executing migration...\n');
        
        const result = await collection.updateMany(
            { entityId: OLD_ENTITY_ID },
            { $set: { entityId: NEW_ENTITY_ID } }
        );
        
        console.log(`✅ Migration complete!`);
        console.log(`   - Matched: ${result.matchedCount}`);
        console.log(`   - Modified: ${result.modifiedCount}`);
        
        // Verify migration
        console.log('\n🔍 Verifying migration...');
        const remaining = await collection.countDocuments({ entityId: OLD_ENTITY_ID });
        const newCount = await collection.countDocuments({ entityId: NEW_ENTITY_ID });
        
        if (remaining === 0) {
            console.log(`✅ Verification passed: No documents with entityId="${OLD_ENTITY_ID}" remain.`);
            console.log(`   Documents with new entityId: ${newCount}\n`);
        } else {
            console.log(`⚠️  Warning: ${remaining} documents still have old entityId.\n`);
        }
        
        await client.close();
        
    } catch (error) {
        console.error(`\n❌ Migration failed: ${error.message}\n`);
        if (client) {
            await client.close();
        }
        process.exit(1);
    }
}

migrate();
