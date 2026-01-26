// sys_entity_tools.js
// Shared tool definitions that can be used by any entity
import { config } from '../../../../../config.js';
import logger from '../../../../../lib/logger.js';
import { migrateToolList } from './tool_migrations.js';
import { getEntityStore } from '../../../../../lib/MongoEntityStore.js';

export const CUSTOM_TOOLS = {};

const STANDARD_FUNCTION_KEYS = new Set(['name', 'description', 'parameters']);

const sanitizeOpenAiToolDefinition = (toolDefinition, toolName) => {
    if (!toolDefinition || toolDefinition.type !== 'function' || !toolDefinition.function) {
        logger.warn(`Skipping invalid tool definition for ${toolName || 'unknown tool'}`);
        return null;
    }

    const functionDefinition = toolDefinition.function || {};
    const sanitizedFunction = {};

    STANDARD_FUNCTION_KEYS.forEach((key) => {
        if (functionDefinition[key] !== undefined) {
            sanitizedFunction[key] = functionDefinition[key];
        }
    });

    if (!sanitizedFunction.name || !sanitizedFunction.parameters) {
        logger.warn(`Skipping tool with missing standard fields: ${toolName || sanitizedFunction.name || 'unknown tool'}`);
        return null;
    }

    return {
        type: toolDefinition.type,
        function: sanitizedFunction
    };
};

// Helper function to get tools for a specific entity
export const getToolsForEntity = (entityConfig) => {
    // Get system tools from config
    const systemTools = config.get('entityTools') || {};
    
    // Convert all tool names to lowercase in system tools
    const normalizedSystemTools = Object.fromEntries(
        Object.entries(systemTools).map(([key, value]) => [key.toLowerCase(), value])
    );
    
    // Convert custom tools to lowercase if they exist
    const normalizedCustomTools = entityConfig?.customTools ? 
        Object.fromEntries(
            Object.entries(entityConfig.customTools).map(([key, value]) => [key.toLowerCase(), value])
        ) : {};
    
    // Convert CUSTOM_TOOLS to lowercase
    const normalizedCUSTOM_TOOLS = Object.fromEntries(
        Object.entries(CUSTOM_TOOLS).map(([key, value]) => [key.toLowerCase(), value])
    );
    
    // Merge system tools with custom tools (custom tools override system tools)
    const allTools = { ...normalizedSystemTools, ...normalizedCustomTools, ...normalizedCUSTOM_TOOLS };

    // If no tools property specified or array contains *, return all tools
    // Note: ['*'] is supported for backward compatibility but should be phased out
    // New entities should use explicit tool lists
    if (!entityConfig?.tools || entityConfig.tools.includes('*')) {
        return {
            entityTools: allTools,
            entityToolsOpenAiFormat: Object.entries(allTools)
                .map(([toolName, tool]) => sanitizeOpenAiToolDefinition(tool.definition, toolName))
                .filter(Boolean)
        };
    }

    // Get the list of tool names for this entity, applying any migrations for renamed/consolidated tools
    const entityToolNames = migrateToolList(entityConfig.tools);
    
    // Add custom tools to the list of allowed tools if they exist
    if (entityConfig.customTools) {
        Object.keys(entityConfig.customTools).forEach(toolName => {
            if (!entityToolNames.includes(toolName.toLowerCase())) {
                entityToolNames.push(toolName.toLowerCase());
            }
        });
    }
    
    // Filter the tools to only include those specified for this entity
    const filteredTools = Object.fromEntries(
        Object.entries(allTools).filter(([toolName]) =>
            entityToolNames.includes(toolName.toLowerCase())
        )
    );

    return {
        entityTools: filteredTools,
        entityToolsOpenAiFormat: Object.entries(filteredTools)
            .map(([toolName, tool]) => sanitizeOpenAiToolDefinition(tool.definition, toolName))
            .filter(Boolean)
    };
};

// Load entity configuration by UUID (on-demand from MongoDB)
// Entities are stored in MongoDB with UUID identifiers
// Strict matching: only exact UUID matches are returned
export const loadEntityConfig = async (entityId) => {
    try {
        const entityStore = getEntityStore();

        // If entityId is provided, look for exact UUID match
        if (entityId) {
            const entity = await entityStore.getEntity(entityId);
            if (entity) {
                return entity;
            }
            // Entity explicitly requested but not found
            logger.warn(`Entity with UUID ${entityId} not found`);
            return null;
        }

        // No entityId provided - return default entity
        const defaultEntity = await entityStore.getDefaultEntity();
        if (defaultEntity) {
            return defaultEntity;
        }

        return null;
    } catch (error) {
        logger.error(`Error loading entity config: ${error.message}`);
        return null;
    }
};

/**
 * Fetches the list of available entities with their descriptions and active tools (on-demand from MongoDB)
 * Returns entities with their UUID identifiers for client use
 * @param {Object} [options]
 * @param {boolean} [options.includeSystem=false] - Include system entities (like Enntity)
 * @param {string} options.userId - User ID (required) - Filter to entities associated with this user
 * @returns {Promise<Array>} Array of objects containing entity information and their active tools
 */
export const getAvailableEntities = async (options = {}) => {
    const { includeSystem = false, userId } = options;

    // Require userId - return error if not provided
    if (!userId || userId.trim() === '') {
        logger.warn('getAvailableEntities called without userId - userId is required');
        throw new Error('userId is required to get available entities');
    }

    try {
        const entityStore = getEntityStore();
        const entities = await entityStore.getAllEntities({ includeSystem, userId });

        return entities.map(entity => {
            const { entityTools } = getToolsForEntity(entity);
            return {
                id: entity.id,
                name: entity.name,
                description: entity.description || '',
                isDefault: entity.isDefault || false,
                isSystem: entity.isSystem || false,
                useMemory: entity.useMemory ?? true,
                avatar: entity.avatar || null,
                createdAt: entity.createdAt ? (entity.createdAt instanceof Date ? entity.createdAt.toISOString() : entity.createdAt) : null,
                updatedAt: entity.updatedAt ? (entity.updatedAt instanceof Date ? entity.updatedAt.toISOString() : entity.updatedAt) : null,
                activeTools: Object.keys(entityTools), // Just return array of tool names
                // Additional fields for entity settings UI
                tools: entity.tools || [], // Original tools array (may include '*' for legacy)
                preferredModel: entity.preferredModel || null,
                modelOverride: entity.modelOverride || null,
                baseModel: entity.baseModel || null,
                reasoningEffort: entity.reasoningEffort || 'medium',
                voice: entity.voice || null
                // Note: assocUserIds and createdBy intentionally not exposed for privacy
            };
        });
    } catch (error) {
        logger.error(`Error fetching available entities: ${error.message}`);
        return [];
    }
};

/**
 * Get the system entity by name (e.g., "Enntity")
 * @param {string} name - System entity name
 * @returns {Promise<Object|null>} Entity config or null
 */
export const getSystemEntity = async (name) => {
    try {
        const entityStore = getEntityStore();
        return await entityStore.getSystemEntity(name);
    } catch (error) {
        logger.error(`Error getting system entity: ${error.message}`);
        return null;
    }
};
