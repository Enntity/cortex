#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Migration Script: userId → assocEntityIds
 * 
 * Migrates continuity memory documents from the old schema (userId: string)
 * to the new schema (assocEntityIds: string[]).
 * 
 * For each document with a userId field:
 *   - Sets assocEntityIds: [userId]
 *   - Removes the userId field
 * 
 * Usage:
 *   node scripts/migrate-userId-to-assocEntityIds.js           # Dry run (preview)
 *   node scripts/migrate-userId-to-assocEntityIds.js --execute # Actually migrate
 * 
 * Requirements:
 *   - MONGO_URI environment variable must be set
 */

import { MongoClient } from 'mongodb';
import logger from '../lib/logger.js';

const EXECUTE = process.argv.includes('--execute');
const COLLECTION_NAME = 'continuity_memories';

async function migrate() {
    console.log('═'.repeat(60));
    console.log('Migration: userId → assocEntityIds');
    console.log('═'.repeat(60));
    
    if (!EXECUTE) {
        console.log('\n⚠️  DRY RUN MODE - No changes will be made');
        console.log('   Run with --execute to apply changes\n');
    } else {
        console.log('\n🔧 EXECUTE MODE - Changes will be applied\n');
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
        
        // Find all documents that have userId but not assocEntityIds
        const docsToMigrate = await collection.find({
            userId: { $exists: true },
            assocEntityIds: { $exists: false }
        }).toArray();
        
        console.log(`📊 Found ${docsToMigrate.length} documents to migrate\n`);
        
        if (docsToMigrate.length === 0) {
            console.log('✅ No documents need migration. All done!\n');
            await client.close();
            return;
        }
        
        // Show sample of what will be migrated
        console.log('📋 Sample documents to migrate:');
        const sample = docsToMigrate.slice(0, 5);
        for (const doc of sample) {
            console.log(`   - id: ${doc.id}, entityId: ${doc.entityId}, userId: ${doc.userId}, type: ${doc.type}`);
        }
        if (docsToMigrate.length > 5) {
            console.log(`   ... and ${docsToMigrate.length - 5} more\n`);
        } else {
            console.log('');
        }
        
        if (!EXECUTE) {
            console.log('🔍 DRY RUN: Would migrate these documents by:');
            console.log('   1. Setting assocEntityIds: [userId]');
            console.log('   2. Unsetting userId field\n');
            console.log('Run with --execute to apply changes.');
            await client.close();
            return;
        }
        
        // Execute migration
        console.log('🚀 Executing migration...\n');
        
        let migrated = 0;
        let errors = 0;
        
        for (const doc of docsToMigrate) {
            try {
                await collection.updateOne(
                    { _id: doc._id },
                    {
                        $set: { assocEntityIds: [doc.userId] },
                        $unset: { userId: '' }
                    }
                );
                migrated++;
                
                if (migrated % 100 === 0) {
                    console.log(`   Migrated ${migrated}/${docsToMigrate.length}...`);
                }
            } catch (error) {
                errors++;
                console.error(`   ❌ Error migrating doc ${doc.id}: ${error.message}`);
            }
        }
        
        console.log(`\n✅ Migration complete!`);
        console.log(`   - Migrated: ${migrated}`);
        console.log(`   - Errors: ${errors}`);
        
        // Verify migration
        console.log('\n🔍 Verifying migration...');
        const remaining = await collection.countDocuments({
            userId: { $exists: true },
            assocEntityIds: { $exists: false }
        });
        
        if (remaining === 0) {
            console.log('✅ Verification passed: No documents with old schema remain.\n');
        } else {
            console.log(`⚠️  Warning: ${remaining} documents still have old schema.\n`);
        }
        
        await client.close();
        
    } catch (error) {
        console.error(`\n❌ Migration failed: ${error.message}\n`);
        logger.error(`Migration failed: ${error.message}`, error);
        if (client) {
            await client.close();
        }
        process.exit(1);
    }
}

migrate();
