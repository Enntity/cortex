// sys_update_entity.js
// Pathway to update entity properties in both MongoDB and the internal cache
// This ensures changes (like tool updates) are immediately reflected without waiting for TTL
//
// Input parameters:
// - entityId: Required - UUID of the entity to update
// - contextId: Required - User ID (must be associated with the entity or be the creator)
// - Entity properties (all optional, only provided ones are updated):
//   - name, description, identity, tools, useMemory, preferredModel, modelOverride, reasoningEffort
//   - avatarText (emoji), avatarDescription (for image gen), avatarImageUrl (avatar image URL)
//
// Response format:
// {
//   success: true/false,
//   entityId: "uuid",
//   updatedProperties: ["name", "tools", ...],
//   error: "..." // Only on failure
// }

import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import logger from '../../../lib/logger.js';

// Properties that can be updated via this pathway
const ALLOWED_PROPERTIES = new Set([
    'name',
    'description', 
    'identity',
    'tools',
    'useMemory',
    'preferredModel',
    'modelOverride',
    'reasoningEffort',
    // Avatar fields (these update nested avatar object)
    'avatarText',        // avatar.text (emoji)
    'avatarDescription', // avatar.description (for image generation)
    'avatarImageUrl'     // avatar.image.url
]);

// Valid values for reasoningEffort
const VALID_REASONING_EFFORTS = new Set(['high', 'medium', 'low']);

// Max lengths for string fields
const MAX_LENGTHS = {
    name: 100,
    description: 1000,
    identity: 50000,
    preferredModel: 100,
    modelOverride: 100,
    avatarText: 10,           // Emoji - should be short
    avatarDescription: 1000,  // Description for image generation
    avatarImageUrl: 2000      // URL
};

export default {
    prompt: [],
    inputParameters: {
        entityId: ``,
        contextId: ``,
        // Entity properties - all optional, only non-undefined values are updated
        name: undefined,
        description: undefined,
        identity: undefined,
        tools: { type: 'array', items: { type: 'string' }, default: undefined },
        useMemory: { type: 'boolean', default: undefined },
        preferredModel: undefined,
        modelOverride: undefined,
        reasoningEffort: undefined,
        // Avatar fields - update nested avatar object
        avatarText: undefined,        // avatar.text (emoji)
        avatarDescription: undefined, // avatar.description (for image generation)
        avatarImageUrl: undefined     // avatar.image.url
    },
    model: 'oai-gpt41-mini',
    isMutation: true,
    executePathway: async ({ args }) => {
        try {
            const { entityId, contextId, ...properties } = args;
            
            // Validate required inputs
            if (!entityId || entityId.trim() === '') {
                return JSON.stringify({
                    success: false,
                    error: 'entityId is required'
                });
            }
            
            if (!contextId || contextId.trim() === '') {
                return JSON.stringify({
                    success: false,
                    error: 'contextId (user ID) is required'
                });
            }
            
            const entityStore = getEntityStore();
            
            if (!entityStore.isConfigured()) {
                return JSON.stringify({
                    success: false,
                    error: 'Entity storage is not configured'
                });
            }
            
            // Get current entity from MongoDB (fresh fetch)
            const currentEntity = await entityStore.getEntity(entityId, { fresh: true });
            
            if (!currentEntity) {
                return JSON.stringify({
                    success: false,
                    error: `Entity not found: ${entityId}`
                });
            }
            
            // Authorization check: user must be associated with the entity or be the creator
            const isAssociated = currentEntity.assocUserIds?.includes(contextId);
            const isCreator = currentEntity.createdBy === contextId;
            const isSystemEntity = currentEntity.isSystem === true;
            
            // System entities can only be updated by their creator (typically system)
            if (isSystemEntity && !isCreator) {
                return JSON.stringify({
                    success: false,
                    error: 'Cannot update system entities'
                });
            }
            
            if (!isAssociated && !isCreator) {
                return JSON.stringify({
                    success: false,
                    error: 'Not authorized to update this entity'
                });
            }
            
            // Collect properties to update (only non-undefined allowed properties)
            const updatedProperties = [];
            const updateData = { ...currentEntity };
            
            for (const [key, value] of Object.entries(properties)) {
                // Skip undefined values (not provided)
                if (value === undefined) continue;
                
                // Only allow known properties
                if (!ALLOWED_PROPERTIES.has(key)) continue;
                
                // Validate and transform values
                if (key === 'tools') {
                    // Parse tools if it comes as a JSON string
                    let toolsArray = value;
                    if (typeof value === 'string') {
                        try {
                            toolsArray = JSON.parse(value);
                        } catch {
                            return JSON.stringify({
                                success: false,
                                error: 'tools must be a valid JSON array of strings'
                            });
                        }
                    }
                    // Validate it's an array of strings
                    if (!Array.isArray(toolsArray) || !toolsArray.every(t => typeof t === 'string')) {
                        return JSON.stringify({
                            success: false,
                            error: 'tools must be an array of strings'
                        });
                    }
                    updateData[key] = toolsArray;
                } else if (key === 'reasoningEffort') {
                    // Validate reasoningEffort enum
                    if (!VALID_REASONING_EFFORTS.has(value)) {
                        return JSON.stringify({
                            success: false,
                            error: `reasoningEffort must be one of: ${[...VALID_REASONING_EFFORTS].join(', ')}`
                        });
                    }
                    updateData[key] = value;
                } else if (key === 'useMemory') {
                    // Ensure boolean
                    updateData[key] = value === true || value === 'true';
                } else if (key === 'avatarText') {
                    // Update avatar.text (emoji)
                    if (typeof value === 'string' && value.length > MAX_LENGTHS.avatarText) {
                        return JSON.stringify({
                            success: false,
                            error: `avatarText exceeds maximum length of ${MAX_LENGTHS.avatarText} characters`
                        });
                    }
                    updateData.avatar = updateData.avatar || {};
                    updateData.avatar.text = value;
                } else if (key === 'avatarDescription') {
                    // Update avatar.description (for image generation)
                    if (typeof value === 'string' && value.length > MAX_LENGTHS.avatarDescription) {
                        return JSON.stringify({
                            success: false,
                            error: `avatarDescription exceeds maximum length of ${MAX_LENGTHS.avatarDescription} characters`
                        });
                    }
                    updateData.avatar = updateData.avatar || {};
                    updateData.avatar.description = value;
                } else if (key === 'avatarImageUrl') {
                    // Update avatar.image.url
                    if (typeof value === 'string' && value.length > MAX_LENGTHS.avatarImageUrl) {
                        return JSON.stringify({
                            success: false,
                            error: `avatarImageUrl exceeds maximum length of ${MAX_LENGTHS.avatarImageUrl} characters`
                        });
                    }
                    updateData.avatar = updateData.avatar || {};
                    updateData.avatar.image = updateData.avatar.image || {};
                    updateData.avatar.image.url = value;
                } else if (MAX_LENGTHS[key] && typeof value === 'string') {
                    // Check string length limits
                    if (value.length > MAX_LENGTHS[key]) {
                        return JSON.stringify({
                            success: false,
                            error: `${key} exceeds maximum length of ${MAX_LENGTHS[key]} characters`
                        });
                    }
                    updateData[key] = value;
                } else {
                    updateData[key] = value;
                }
                updatedProperties.push(key);
            }
            
            if (updatedProperties.length === 0) {
                return JSON.stringify({
                    success: false,
                    error: 'No properties to update'
                });
            }
            
            // Update entity in MongoDB (this also updates the internal cache)
            const updatedId = await entityStore.upsertEntity(updateData);
            
            if (!updatedId) {
                return JSON.stringify({
                    success: false,
                    error: 'Failed to update entity in database'
                });
            }
            
            logger.info(`Updated entity ${entityId} (${currentEntity.name}): ${updatedProperties.join(', ')}`);
            
            return JSON.stringify({
                success: true,
                entityId: entityId,
                updatedProperties: updatedProperties
            });
            
        } catch (error) {
            logger.error(`Error updating entity: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `Failed to update entity: ${error.message}`
            });
        }
    },
    json: true,
    manageTokenLength: false
};
