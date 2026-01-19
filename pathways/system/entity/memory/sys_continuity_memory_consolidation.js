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
        
        // First content is the NEW memory (M), rest are existing similar memories (S)
        const newMemory = contents[0];
        const existingMemories = contents.slice(1);
        
        const promptMessages = [
            {
                role: "system",
                content: `You are consolidating a new memory with similar existing memories.

CRITICAL RULES:
1. The result must be in FIRST PERSON ("I realized...", "I've noticed...")
2. PRESERVE the new memory's core meaning - don't lose what it specifically says
3. Keep it CONCISE - one to two sentences maximum
4. If you can't preserve the new memory's specifics while merging, just return the new memory unchanged

This is deduplication, not expansion. The goal is to avoid storing near-duplicates, NOT to create richer narratives.

Return ONLY the consolidated memory content. No explanation, no formatting.`
            },
            {
                role: "user",
                content: `NEW MEMORY (must preserve its meaning):
${newMemory}

SIMILAR EXISTING MEMORY/MEMORIES:
${existingMemories.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Merge into ONE first-person memory that:
- Preserves the specific meaning of the NEW memory
- Incorporates relevant context from existing memories IF it doesn't dilute the new memory
- Stays concise (1-2 sentences)
- If the memories are truly saying different things, just return the NEW memory unchanged

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

