// sys_get_entities.js
// Pathway to get list of available entities with their tools
// Returns entities with UUID identifiers for client use
//
// Response format:
// [
//   {
//     id: "uuid-string",           // Entity UUID (primary identifier)
//     name: "Entity Name",         // Human-readable name
//     description: "...",          // Entity description
//     isDefault: true/false,       // Default entity flag
//     useMemory: true/false,       // Memory enabled
//     memoryBackend: "continuity", // Memory system type
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
    inputParameters: {},
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const entities = getAvailableEntities();
            return JSON.stringify(entities);
        } catch (error) {
            return JSON.stringify(error);
        }
    },
    json: true, // We want JSON output
    manageTokenLength: false, // No need to manage token length for this simple operation
}; 