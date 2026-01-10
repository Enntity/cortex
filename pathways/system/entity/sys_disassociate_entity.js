// sys_disassociate_entity.js
// Pathway to disassociate a user from an entity
// Removes the user from the entity's assocUserIds array
//
// Input parameters:
// - entityId: Entity UUID (required)
// - contextId: User ID to disassociate (required)
//
// Response format:
// {
//   success: true,
//   message: "User disassociated from entity successfully"
// }
// OR
// {
//   success: false,
//   error: "Error message"
// }

import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import logger from '../../../lib/logger.js';

export default {
    prompt: [],
    inputParameters: {
        entityId: ``,      // Entity UUID
        contextId: ``,    // User ID to disassociate
    },
    model: 'oai-gpt41-mini',
    isMutation: true, // Declaratively mark this as a Mutation
    executePathway: async ({ args }) => {
        try {
            const { entityId, contextId } = args;
            
            // Validate required fields
            if (!entityId || !entityId.trim()) {
                return JSON.stringify({
                    success: false,
                    error: 'Entity ID is required'
                });
            }
            
            if (!contextId || !contextId.trim()) {
                return JSON.stringify({
                    success: false,
                    error: 'User ID (contextId) is required'
                });
            }
            
            const entityStore = getEntityStore();
            
            if (!entityStore.isConfigured()) {
                return JSON.stringify({
                    success: false,
                    error: 'Entity storage is not configured'
                });
            }
            
            // Verify entity exists
            const entity = await entityStore.getEntity(entityId);
            if (!entity) {
                return JSON.stringify({
                    success: false,
                    error: 'Entity not found'
                });
            }
            
            // Remove user from entity
            const success = await entityStore.removeUserFromEntity(entityId, contextId);
            
            if (success) {
                return JSON.stringify({
                    success: true,
                    message: `User ${contextId} disassociated from entity ${entityId} successfully`
                });
            } else {
                return JSON.stringify({
                    success: false,
                    error: 'Failed to disassociate user from entity'
                });
            }
        } catch (error) {
            logger.error(`Error disassociating user from entity: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `Failed to disassociate user from entity: ${error.message}`
            });
        }
    },
    json: true,
    manageTokenLength: false,
};
