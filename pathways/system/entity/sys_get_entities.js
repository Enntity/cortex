// sys_get_entities.js
// Pathway to get list of available entities with their tools
// Returns entities with UUID identifiers for client use
//
// Input parameters:
// - contextId: Required user ID to filter entities by user association
// - includeSystem: Optional flag to include system entities (default: false)
//
// Response format:
// [
//   {
//     id: "uuid-string",           // Entity UUID (primary identifier)
//     name: "Entity Name",         // Human-readable name
//     description: "...",          // Entity description
//     isDefault: true/false,       // Default entity flag
//     isSystem: true/false,        // System entity flag
//     useMemory: true/false,       // Memory enabled
//     avatar: {                    // Optional visual representation
//       text: "🤖",               // Optional text/emoji
//       image: { url, gcs, name },// Optional image file
//       video: { url, gcs, name } // Optional video file
//     },
//     activeTools: [...]           // List of available tools
//   }
// ]

import { getAvailableEntities } from './tools/shared/sys_entity_tools.js';

export default {
    prompt: [],
    inputParameters: {
        contextId: ``,        // User ID to filter entities
        includeSystem: false  // Include system entities like Enntity
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const { contextId, includeSystem } = args;
            
            // Validate userId is provided
            if (!contextId || contextId.trim() === '') {
                return JSON.stringify({ 
                    error: 'User ID (contextId) is required to get available entities' 
                });
            }
            
            const entities = getAvailableEntities({
                userId: contextId,
                includeSystem: includeSystem === true || includeSystem === 'true'
            });
            return JSON.stringify(entities);
        } catch (error) {
            return JSON.stringify({ error: error.message || 'Failed to get entities' });
        }
    },
    json: true, // We want JSON output
    manageTokenLength: false, // No need to manage token length for this simple operation
}; 