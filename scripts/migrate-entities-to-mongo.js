#!/usr/bin/env node
/**
 * Entity Migration Script
 * 
 * Migrates entity configurations from config files to MongoDB.
 * This script:
 *   1. Reads entityConfig from the current config files
 *   2. Generates UUIDs for each entity
 *   3. Renames fields (instructions → identity, files → resources)
 *   4. Inserts entities into MongoDB
 *   5. Creates required indexes
 * 
 * Requirements:
 *   MONGO_URI - MongoDB connection string
 *   CORTEX_CONFIG_FILE - Path to config file (optional, uses default.json if not set)
 * 
 * Usage:
 *   node scripts/migrate-entities-to-mongo.js [--dry-run] [--force]
 * 
 *   --dry-run   Preview changes without writing to MongoDB
 *   --force     Overwrite existing entities in MongoDB
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const COLLECTION_NAME = 'entities';

// Parse arguments
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Entity collection indexes
const INDEXES = [
    {
        name: 'idx_entity_id',
        key: { id: 1 },
        options: { unique: true }
    },
    {
        name: 'idx_entity_name',
        key: { name: 1 }
    },
    {
        name: 'idx_entity_default',
        key: { isDefault: 1 }
    }
];

/**
 * Load entity config from JSON file
 */
function loadConfigFile() {
    // Try CORTEX_CONFIG_FILE first, then default.json
    const configPaths = [
        process.env.CORTEX_CONFIG_FILE,
        path.join(__dirname, '..', 'config', 'default.json'),
        path.join(__dirname, '..', 'config', 'local.json')
    ].filter(Boolean);
    
    for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
            console.log(`📄 Loading config from: ${configPath}`);
            const content = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);
            return config.entityConfig || {};
        }
    }
    
    return {};
}

/**
 * Transform entity from config format to MongoDB format
 */
function transformEntity(key, configEntity) {
    const now = new Date();
    
    // Transform avatar if present
    let avatar = null;
    if (configEntity.avatar) {
        avatar = {
            text: configEntity.avatar.text || null,
            image: configEntity.avatar.image ? {
                url: configEntity.avatar.image.url,
                gcs: configEntity.avatar.image.gcs,
                name: configEntity.avatar.image.name || configEntity.avatar.image.originalFilename
            } : null,
            video: configEntity.avatar.video ? {
                url: configEntity.avatar.video.url,
                gcs: configEntity.avatar.video.gcs,
                name: configEntity.avatar.video.name || configEntity.avatar.video.originalFilename
            } : null
        };
    }
    
    return {
        id: uuidv4(), // Generate new UUID
        name: configEntity.name || key.charAt(0).toUpperCase() + key.slice(1),
        isDefault: configEntity.isDefault ?? false,
        useMemory: configEntity.useMemory ?? true,
        description: configEntity.description || '',
        // Rename instructions → identity
        identity: configEntity.instructions || configEntity.identity || '',
        avatar: avatar,
        tools: configEntity.tools || ['*'],
        // Rename files → resources
        resources: (configEntity.files || configEntity.resources || []).map(file => ({
            url: file.url,
            gcs: file.gcs,
            name: file.name || file.originalFilename,
            type: file.type || inferResourceType(file.url || file.name)
        })),
        customTools: configEntity.customTools || {},
        createdAt: now,
        updatedAt: now,
        // Keep original key for reference
        _migratedFrom: key
    };
}

/**
 * Infer resource type from URL or filename
 */
function inferResourceType(urlOrName) {
    if (!urlOrName) return 'unknown';
    
    const lower = urlOrName.toLowerCase();
    
    if (/\.(jpg|jpeg|png|gif|webp|svg)/.test(lower)) return 'image';
    if (/\.(mp4|mov|avi|webm|mkv)/.test(lower)) return 'video';
    if (/\.(mp3|wav|ogg|m4a)/.test(lower)) return 'audio';
    if (/\.(pdf)/.test(lower)) return 'pdf';
    if (/\.(doc|docx)/.test(lower)) return 'document';
    if (/\.(xls|xlsx)/.test(lower)) return 'spreadsheet';
    if (/\.(ppt|pptx)/.test(lower)) return 'presentation';
    if (/\.(txt|md|json|csv)/.test(lower)) return 'text';
    
    return 'file';
}

async function migrateEntities() {
    const mongoUri = process.env.MONGO_URI;
    
    if (!mongoUri) {
        console.error('❌ MONGO_URI environment variable not set!');
        console.error('');
        console.error('Set the environment variable:');
        console.error('  export MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/dbname"');
        process.exit(1);
    }
    
    console.log('🔄 Entity Migration to MongoDB');
    console.log('==============================');
    console.log(`Collection: ${COLLECTION_NAME}`);
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (preview only)' : FORCE ? 'FORCE (overwrite)' : 'LIVE'}`);
    console.log('');
    
    // Load entities from config
    const configEntities = loadConfigFile();
    const entityKeys = Object.keys(configEntities);
    
    if (entityKeys.length === 0) {
        console.log('⚠️  No entities found in config file.');
        console.log('Make sure your config file has an entityConfig section.');
        process.exit(0);
    }
    
    console.log(`📋 Found ${entityKeys.length} entities in config:`);
    for (const key of entityKeys) {
        const entity = configEntities[key];
        console.log(`   • ${key}: ${entity.name || key}${entity.isDefault ? ' (default)' : ''}`);
    }
    console.log('');
    
    // Transform entities
    const transformedEntities = entityKeys.map(key => transformEntity(key, configEntities[key]));
    
    console.log('📝 Transformed entities:');
    for (const entity of transformedEntities) {
        console.log(`   • ${entity.name} → ${entity.id}`);
        console.log(`     - isDefault: ${entity.isDefault}`);
        console.log(`     - useMemory: ${entity.useMemory}`);
        console.log(`     - tools: ${entity.tools.join(', ')}`);
        console.log(`     - identity: ${entity.identity ? entity.identity.substring(0, 50) + '...' : '(empty)'}`);
        console.log(`     - resources: ${entity.resources.length} files`);
    }
    console.log('');
    
    if (DRY_RUN) {
        console.log('════════════════════════════════════════');
        console.log('DRY RUN complete - no changes were made.');
        console.log('Run without --dry-run to apply changes.');
        console.log('════════════════════════════════════════');
        process.exit(0);
    }
    
    // Connect to MongoDB
    let client;
    try {
        console.log('📡 Connecting to MongoDB...');
        client = new MongoClient(mongoUri);
        await client.connect();
        
        let db = client.db();
        if (!db.databaseName) {
            db = client.db('cortex');
        }
        console.log(`✓ Connected to database: ${db.databaseName}`);
        console.log('');
        
        const collection = db.collection(COLLECTION_NAME);
        
        // Check for existing entities
        const existingCount = await collection.countDocuments({});
        if (existingCount > 0 && !FORCE) {
            console.log(`⚠️  Collection already contains ${existingCount} entities.`);
            console.log('Use --force to overwrite existing entities.');
            await client.close();
            process.exit(1);
        }
        
        if (FORCE && existingCount > 0) {
            console.log(`🗑️  Removing ${existingCount} existing entities...`);
            await collection.deleteMany({});
            console.log('✓ Existing entities removed');
        }
        
        // Create indexes
        console.log('📇 Creating indexes...');
        for (const indexDef of INDEXES) {
            try {
                await collection.createIndex(indexDef.key, {
                    name: indexDef.name,
                    ...indexDef.options
                });
                console.log(`   ✓ ${indexDef.name}`);
            } catch (error) {
                if (error.code === 85) { // Index already exists
                    console.log(`   ⏭️  ${indexDef.name} (already exists)`);
                } else {
                    console.log(`   ⚠️  ${indexDef.name}: ${error.message}`);
                }
            }
        }
        console.log('');
        
        // Insert entities
        console.log('💾 Inserting entities...');
        for (const entity of transformedEntities) {
            try {
                await collection.insertOne(entity);
                console.log(`   ✓ ${entity.name} (${entity.id})`);
            } catch (error) {
                console.log(`   ❌ ${entity.name}: ${error.message}`);
            }
        }
        console.log('');
        
        // Verify
        const finalCount = await collection.countDocuments({});
        console.log('════════════════════════════════════════');
        console.log(`✅ Migration complete!`);
        console.log(`   Entities in MongoDB: ${finalCount}`);
        console.log('');
        console.log('Generated UUIDs:');
        for (const entity of transformedEntities) {
            console.log(`   ${entity.name}: ${entity.id}`);
        }
        console.log('');
        console.log('Next steps:');
        console.log('1. Update CORTEX_CONFIG_FILE to not include entityConfig (optional)');
        console.log('2. Cortex will now load entities from MongoDB on startup');
        console.log('════════════════════════════════════════');
        
    } catch (error) {
        console.error('');
        console.error('❌ Migration failed!');
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
    
    if (client) {
        await client.close();
    }
    process.exit(0);
}

// Run
migrateEntities();
