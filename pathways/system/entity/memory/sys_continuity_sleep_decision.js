/**
 * Continuity Sleep Decision Pathway
 * 
 * Per-memory consolidation decision during "sleep" synthesis.
 * For each fresh (unprocessed) memory, decides whether to:
 * - ABSORB: Delete fresh, it's redundant with existing
 * - MERGE: Combine fresh with existing into richer memory
 * - LINK: Keep fresh, create graph edge to related memory
 * - KEEP: Fresh is distinct, no action needed
 * 
 * This models human sleep consolidation - recent memories get
 * integrated with existing memory structures.
 * 
 * Input: aiName, freshMemory, similarMemories, linkedMemories
 * Output: JSON decision with action and details
 */

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',  // Fast model for per-memory decisions
    inputParameters: {
        aiName: '',
        freshMemory: '',      // JSON stringified memory
        similarMemories: '',  // JSON stringified array of similar memories
        linkedMemories: '',   // JSON stringified array of graph-linked memories
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 30,
    
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { aiName = 'Entity' } = args;
        
        // Parse inputs
        let fresh, similar, linked;
        try {
            fresh = typeof args.freshMemory === 'string' 
                ? JSON.parse(args.freshMemory) 
                : args.freshMemory;
            similar = typeof args.similarMemories === 'string' 
                ? JSON.parse(args.similarMemories || '[]') 
                : (args.similarMemories || []);
            linked = typeof args.linkedMemories === 'string' 
                ? JSON.parse(args.linkedMemories || '[]') 
                : (args.linkedMemories || []);
        } catch (error) {
            logger.error(`Failed to parse sleep decision inputs: ${error.message}`);
            return JSON.stringify({
                decision: 'KEEP',
                reason: 'Failed to parse inputs',
                error: true
            });
        }
        
        if (!fresh || !fresh.content) {
            return JSON.stringify({
                decision: 'KEEP',
                reason: 'No fresh memory provided',
                error: true
            });
        }
        
        // Format memories for prompt
        const formatMemory = (m, i) => {
            const age = m.timestamp ? getDaysAgo(m.timestamp) : 'unknown';
            return `${i + 1}. [${m.id}] "${truncate(m.content, 300)}" (type: ${m.type}, importance: ${m.importance || 5}, age: ${age} days)`;
        };
        
        const similarText = similar.length > 0
            ? similar.map(formatMemory).join('\n')
            : '(none found)';
            
        const linkedText = linked.length > 0
            ? linked.map(formatMemory).join('\n')
            : '(none)';
        
        const promptMessages = [
            {
                role: "system",
                content: `You are ${aiName}, consolidating memories during your "sleep" cycle.

This is YOUR memory consolidation - like dreaming, where you process and integrate recent experiences with existing memories.

PROTECTED TYPES - NEVER absorb or merge away:
- CORE: Foundational identity directives - the bedrock of who you are
- CORE_EXTENSION: Hardened identity patterns promoted from evolution - earned identity growth
If the fresh memory is CORE or CORE_EXTENSION, you MUST return KEEP. These are protected.

CRITICAL GUIDANCE:
- The goal is NOT to compress related thoughts into monolithic mega-memories
- Only MERGE when memories express the SAME core insight from different moments
- A good merged memory is 1-2 sentences. If it would be 3+ sentences, that's a sign you're combining TOO MUCH - use LINK instead
- LINK preserves both memories while connecting them - this is BETTER than losing nuance through over-merging
- ABSORB only when fresh is truly redundant (adds nothing new)
- KEEP is perfectly fine - distinct memories are valuable

Write merged content in FIRST PERSON ("I noticed...", "I felt...", "I remember...")

Return ONLY valid JSON.`
            },
            {
                role: "user",
                content: `As ${aiName}, decide what to do with this fresh memory:

FRESH MEMORY (unprocessed):
- ID: ${fresh.id}
- Type: ${fresh.type}
- Content: "${truncate(fresh.content, 500)}"
- Importance: ${fresh.importance || 5}
- Created: ${fresh.timestamp || 'unknown'}

SIMILAR EXISTING MEMORIES (by semantic similarity):
${similarText}

GRAPH-LINKED MEMORIES (already connected):
${linkedText}

What should happen to this fresh memory?

DECISION OPTIONS (in order of preference for related memories):
A) KEEP - Fresh memory is distinct enough to stand alone. No changes needed.
B) LINK - Fresh and existing are related but capture different facets. Keep both, connect them.
C) ABSORB - Fresh is truly redundant (adds zero new information). Delete fresh, optionally boost existing.
D) MERGE - Fresh and existing express the SAME insight. Combine into ONE concise sentence (2 max). If you need 3+ sentences, use LINK instead.

Respond with JSON:
{
  "decision": "ABSORB" | "MERGE" | "LINK" | "KEEP",
  "targetMemoryId": "id of existing memory (required for ABSORB/MERGE/LINK, null for KEEP)",
  "reason": "one sentence explanation of your decision",
  "mergedContent": "first-person merged content (required for MERGE, null otherwise)"
}`
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
            
            const responseText = typeof result === 'string' 
                ? result 
                : (result?.output_text || result?.text || '');
            
            // Validate JSON response
            try {
                const parsed = JSON.parse(responseText);
                
                // Validate required fields
                if (!['ABSORB', 'MERGE', 'LINK', 'KEEP'].includes(parsed.decision)) {
                    throw new Error(`Invalid decision: ${parsed.decision}`);
                }
                
                // For ABSORB/MERGE/LINK, targetMemoryId is required
                if (['ABSORB', 'MERGE', 'LINK'].includes(parsed.decision) && !parsed.targetMemoryId) {
                    // Try to recover - default to first similar memory
                    if (similar.length > 0) {
                        parsed.targetMemoryId = similar[0].id;
                    } else {
                        // Can't proceed without a target, fall back to KEEP
                        logger.warn(`Sleep decision ${parsed.decision} missing targetMemoryId, falling back to KEEP`);
                        parsed.decision = 'KEEP';
                        parsed.reason = 'No target memory available';
                    }
                }
                
                // For MERGE, mergedContent is required
                if (parsed.decision === 'MERGE' && !parsed.mergedContent) {
                    logger.warn('MERGE decision missing mergedContent, falling back to LINK');
                    parsed.decision = 'LINK';
                    parsed.reason = 'Merge requested but no merged content provided';
                }
                
                logger.info(`Sleep decision for ${fresh.id}: ${parsed.decision}${parsed.targetMemoryId ? ` -> ${parsed.targetMemoryId}` : ''}`);
                return JSON.stringify(parsed);
                
            } catch (parseError) {
                // Try to extract JSON from markdown
                const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) {
                    const extracted = JSON.parse(match[1].trim());
                    return JSON.stringify(extracted);
                }
                throw parseError;
            }
            
        } catch (error) {
            logger.error(`Sleep decision failed: ${error.message}`);
            return JSON.stringify({
                decision: 'KEEP',
                reason: `Decision failed: ${error.message}`,
                error: true
            });
        }
    }
};

// Helper functions
function getDaysAgo(timestamp) {
    try {
        const then = new Date(timestamp);
        const now = new Date();
        const diffMs = now - then;
        return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    } catch {
        return 'unknown';
    }
}

function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '...';
}






