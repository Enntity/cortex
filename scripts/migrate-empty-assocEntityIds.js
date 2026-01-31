#!/usr/bin/env node
import 'dotenv/config';  // Load .env file

/**
 * Migration Script: assocEntityIds [] → [entityId]
 *
 * Migrates continuity memory documents that have empty assocEntityIds arrays
 * to use [entityId] as a sentinel value for entity-level memories.
 *
 * Background: Atlas Vector Search pre-filters require scalar values (boolean,
 * objectId, number, string, date, uuid, or null). Filtering on assocEntityIds: []
 * (empty array) is not supported and causes "filter[1] must be a boolean..."
 * errors. Using entityId as the sentinel value enables proper vector search
 * filtering while preserving the entity-level vs user-scoped distinction.
 *
 * For each document with assocEntityIds: []:
 *   - Sets assocEntityIds: [entityId] (using the document's own entityId)
 *
 * Usage:
 *   node scripts/migrate-empty-assocEntityIds.js           # Dry run (preview)
 *   node scripts/migrate-empty-assocEntityIds.js --execute # Actually migrate
 *
 * Requirements:
 *   - MONGO_URI environment variable must be set
 */

import { MongoClient } from 'mongodb';

const EXECUTE = process.argv.includes('--execute');
const COLLECTION_NAME = 'continuity_memories';

async function migrate() {
    console.log('═'.repeat(60));
    console.log('Migration: assocEntityIds [] → [entityId]');
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
        console.log('📡 Connecting to MongoDB...');
        client = new MongoClient(connectionString);
        await client.connect();

        const db = client.db();
        const collection = db.collection(COLLECTION_NAME);

        console.log(`📂 Using database: ${db.databaseName}`);
        console.log(`📂 Using collection: ${COLLECTION_NAME}\n`);

        // Find all documents with empty assocEntityIds arrays
        const docsToMigrate = await collection.find({
            assocEntityIds: { $eq: [] }
        }).toArray();

        console.log(`📊 Found ${docsToMigrate.length} documents with empty assocEntityIds\n`);

        if (docsToMigrate.length === 0) {
            console.log('✅ No documents need migration. All done!\n');
            await client.close();
            return;
        }

        // Group by entityId for summary
        const byEntity = {};
        for (const doc of docsToMigrate) {
            const eid = doc.entityId || 'unknown';
            byEntity[eid] = (byEntity[eid] || 0) + 1;
        }

        console.log('📋 Documents by entity:');
        for (const [eid, count] of Object.entries(byEntity)) {
            console.log(`   - ${eid}: ${count} documents`);
        }
        console.log('');

        // Show sample
        console.log('📋 Sample documents to migrate:');
        const sample = docsToMigrate.slice(0, 5);
        for (const doc of sample) {
            console.log(`   - id: ${doc.id}, entityId: ${doc.entityId}, type: ${doc.type}, tags: [${(doc.tags || []).join(', ')}]`);
        }
        if (docsToMigrate.length > 5) {
            console.log(`   ... and ${docsToMigrate.length - 5} more\n`);
        } else {
            console.log('');
        }

        if (!EXECUTE) {
            console.log('🔍 DRY RUN: Would set assocEntityIds: [entityId] for each document\n');
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
                if (!doc.entityId) {
                    console.error(`   ⚠️  Skipping doc ${doc.id}: no entityId`);
                    errors++;
                    continue;
                }

                await collection.updateOne(
                    { _id: doc._id },
                    { $set: { assocEntityIds: [doc.entityId] } }
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
            assocEntityIds: { $eq: [] }
        });

        if (remaining === 0) {
            console.log('✅ Verification passed: No documents with empty assocEntityIds remain.\n');
        } else {
            console.log(`⚠️  Warning: ${remaining} documents still have empty assocEntityIds.\n`);
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
