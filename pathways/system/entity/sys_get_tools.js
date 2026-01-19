// sys_get_tools.js
// Pathway to get list of all registered tools (enabled by default)
// Returns tool names and basic metadata for client use
//
// Input parameters:
// - includeDisabled: Optional flag to include disabled tools (default: false)
//
// Response format:
// {
//   tools: [
//     {
//       name: "GenerateImage",        // Tool function name
//       icon: "🎨",                   // Tool icon emoji
//       description: "...",           // Tool description
//       pathwayName: "sys_tool_...",  // Source pathway name
//       enabled: true                 // Whether tool is enabled
//     }
//   ],
//   count: 28                         // Total count of tools returned
// }

import { config } from '../../../config.js';

export default {
    prompt: [],
    inputParameters: {
        includeDisabled: false  // Include disabled tools in the response
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const { includeDisabled } = args;
            const includeAll = includeDisabled === true || includeDisabled === 'true';
            
            // Get all registered entity tools from config
            const entityTools = config.get('entityTools') || {};
            
            const tools = [];
            
            for (const [name, toolData] of Object.entries(entityTools)) {
                const definition = toolData?.definition;
                if (!definition) continue;
                
                // Check if tool is enabled (default to true if not specified)
                const isEnabled = definition.enabled !== false;
                
                // Skip disabled tools unless includeDisabled is true
                if (!isEnabled && !includeAll) continue;
                
                tools.push({
                    name: definition.function?.name || name,
                    icon: definition.icon || '',
                    description: definition.function?.description || '',
                    pathwayName: toolData.pathwayName || '',
                    enabled: isEnabled
                });
            }
            
            // Sort alphabetically by name
            tools.sort((a, b) => a.name.localeCompare(b.name));
            
            return JSON.stringify({
                tools,
                count: tools.length
            });
        } catch (error) {
            return JSON.stringify({ error: error.message || 'Failed to get tools' });
        }
    },
    json: true,
    manageTokenLength: false,
};
