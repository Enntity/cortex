/**
 * Continuity Memory Consolidation Pathway
 * 
 * Consolidates multiple similar memories into a single coherent memory entry.
 * Used during deduplication when similar memories are found and need to be merged.
 * 
 * Takes multiple memory contents and synthesizes them into one unified memory
 * that captures the essential meaning from all versions.
 * 
 * Input: contents (array of memory content strings)
 * Output: Single consolidated memory content string
 */

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    inputParameters: {
        contents: [],  // Array of memory content strings to consolidate
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 60,
    
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { contents = [] } = args;
        
        if (!Array.isArray(contents) || contents.length === 0) {
            logger.warn('Memory consolidation called with no contents');
            return '';
        }
        
        if (contents.length === 1) {
            // Nothing to consolidate
            return contents[0];
        }
        
        const promptMessages = [
            {
                role: "system",
                content: `You are consolidating multiple versions of a memory into one coherent first-person memory.

CRITICAL: The result must be in FIRST PERSON - this is someone's personal memory, not a report about them.
- NOT "The entity learned..." → Instead: "I realized..."
- NOT "The user prefers..." → Instead: "I've noticed they prefer..."

Return ONLY the consolidated memory content. No explanation, no formatting, no metadata.`
            },
            {
                role: "user",
                content: `These memories capture the same insight from different angles:

${contents.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Merge them into ONE first-person memory that:
- Feels like a single, rich experience
- Captures the essential meaning from all versions
- Preserves unique details or nuances
- Starts with "I..." (first person)

Return ONLY the consolidated memory, nothing else.`
            }
        ];
        
        resolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages })
        ];
        
        try {
            const result = await runAllPrompts({
                ...args,
                model: 'oai-gpt41-mini',
                useMemory: false,
                stream: false
            });
            
            const responseText = typeof result === 'string' ? result : (result?.output_text || result?.text || '');
            return responseText?.trim() || '';
        } catch (error) {
            logger.error(`Memory consolidation failed: ${error.message}`);
            // Fallback: return the longest content (best effort)
            return contents.reduce((longest, current) => 
                current.length > longest.length ? current : longest, 
                contents[0] || ''
            );
        }
    }
};

