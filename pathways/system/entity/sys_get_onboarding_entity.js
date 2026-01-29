// sys_get_onboarding_entity.js
// Pathway to get the matchmaking system entity for onboarding new users
// Returns the matchmaker system entity that handles user interviews and entity creation
//
// The system entity is identified by name + isSystem flag, not a fixed UUID (for security)
//
// Response format:
// {
//   success: true,
//   entity: {
//     id: "uuid-string",           // Entity UUID (random, not fixed)
//     name: "Enntity",             // System entity name
//     description: "...",          // Entity description
//     isSystem: true,              // Always true for onboarding entity
//     avatar: { text: "✨" },      // Visual representation
//     ...
//   }
// }
// OR
// {
//   success: false,
//   error: "Error message"
// }

import { getSystemEntity } from './tools/shared/sys_entity_tools.js';
import { config } from '../../../config.js';

export default {
    prompt: [],
    inputParameters: {},
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const matchmakerName = config.get('systemEntities.matchmakerName');
            // Get the matchmaker system entity by name + isSystem flag
            const entity = await getSystemEntity(matchmakerName);
            
            if (!entity) {
                return JSON.stringify({
                    success: false,
                    error: 'Onboarding entity not found. It should be auto-created on startup.'
                });
            }
            
            return JSON.stringify({
                success: true,
                entity: {
                    id: entity.id,
                    name: entity.name,
                    description: entity.description || '',
                    isSystem: true,
                    useMemory: entity.useMemory ?? false,
                    avatar: entity.avatar || { text: '✨' },
                    createdAt: entity.createdAt ? (entity.createdAt instanceof Date ? entity.createdAt.toISOString() : entity.createdAt) : null,
                    updatedAt: entity.updatedAt ? (entity.updatedAt instanceof Date ? entity.updatedAt.toISOString() : entity.updatedAt) : null
                }
            });
        } catch (error) {
            return JSON.stringify({
                success: false,
                error: `Failed to get onboarding entity: ${error.message}`
            });
        }
    },
    json: true,
    manageTokenLength: false,
};
