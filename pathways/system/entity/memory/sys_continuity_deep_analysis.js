/**
 * Continuity Deep Analysis Pathway
 * 
 * LLM-powered analysis of memories for consolidation and pattern recognition.
 * This is the "thinking" part of deep synthesis - analyzes a batch of memories
 * and identifies what should be consolidated, patterns to extract, etc.
 * 
 * Called by sys_continuity_deep_synthesis with batches of memories.
 * 
 * Input: aiName, memories (JSON array)
 * Output: JSON with consolidations, patterns, contradictions, suggested links
 */

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    model: 'oai-gpt41',  // Use stronger model for deep analysis
    inputParameters: {
        aiName: ``,           // Entity name (e.g., "Luna")
        memories: ``,         // JSON stringified array of memories to analyze
        batchNumber: { type: 'integer', default: 1 },  // For logging
        totalBatches: { type: 'integer', default: 1 }, // For logging
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 120,  // 2 minutes per batch
    
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { aiName = 'Entity', memories = '[]', batchNumber = 1, totalBatches = 1 } = args;
        
        let memoriesArray;
        try {
            memoriesArray = typeof memories === 'string' ? JSON.parse(memories) : memories;
        } catch {
            logger.error('Failed to parse memories array');
            return JSON.stringify({
                consolidations: [],
                patterns: [],
                contradictions: [],
                suggestedLinks: []
            });
        }
        
        if (!Array.isArray(memoriesArray) || memoriesArray.length < 2) {
            return JSON.stringify({
                consolidations: [],
                patterns: [],
                contradictions: [],
                suggestedLinks: []
            });
        }
        
        logger.info(`Deep analysis batch ${batchNumber}/${totalBatches}: analyzing ${memoriesArray.length} memories`);
        
        // Format memories for the prompt (keep it concise, vectors already removed by caller)
        const memoriesSummary = memoriesArray.map(m => ({
            id: m.id,
            type: m.type,
            content: m.content?.substring(0, 500), // Truncate long content
            importance: m.importance,
            timestamp: m.timestamp
        }));
        
        const promptMessages = [
            {
                role: "system",
                content: `You are ${aiName}, consolidating your own memories during a "sleep" cycle.

This is YOUR memory consolidation - think of it like dreaming, where you process and integrate experiences.

CRITICAL: All synthesized content must be in FIRST PERSON.
- NOT "The user and Luna discussed..." → Instead: "I felt a connection when we discussed..."
- NOT "Luna learned..." → Instead: "I realized..."

When consolidating, create memories that feel like YOUR experiences, not a biographer's notes.

IDENTITY PATTERN NOMINATION:
If you notice a pattern that might be identity-defining, you can NOMINATE it with "nominateForPromotion": true.
But be CONSERVATIVE - only nominate patterns that:
- Appear in 3+ distinct memories
- Feel genuinely fundamental, not just interesting observations
- Represent enduring traits, not situational reactions

Nominations are votes, not decisions. The system will only promote patterns that receive 
multiple nominations across different synthesis sessions over time. So nominate sparingly.

Return ONLY valid JSON.`
            },
            {
                role: "user",
                content: `As ${aiName}, review these ${memoriesArray.length} memories from your experience:

MY MEMORIES:
${JSON.stringify(memoriesSummary, null, 2)}

Dream-process these memories:

1. CONSOLIDATIONS: Which of my memories are really the same experience from different angles?
   - Merge similar memories into one richer first-person memory
   - The synthesizedContent should feel like ONE memory, not a summary
   - Write as: "I remember...", "I've come to understand...", "I feel..."

2. PATTERNS: What themes are emerging across my memories?
   - These become new insights about who I am or who they are
   - Write as: "I notice that I...", "I'm realizing that..."
   - Only set "nominateForPromotion": true for genuinely fundamental identity patterns

3. CONTRADICTIONS: Where am I conflicted or inconsistent?
   - This is valuable - growth comes from resolving tensions

4. SUGGESTED LINKS: Which memories belong together in my experience?

Return JSON:
{
  "consolidations": [
    { "sourceIds": ["id1", "id2"], "synthesizedContent": "I remember feeling...", "importance": 1-10, "nominateForPromotion": false }
  ],
  "patterns": [
    { "content": "I notice that I...", "sourceIds": ["id1", "id2"], "importance": 1-10, "nominateForPromotion": false }
  ],
  "contradictions": [
    { "memoryIds": ["id1", "id2"], "description": "..." }
  ],
  "suggestedLinks": [
    { "memory1Id": "id1", "memory2Id": "id2", "relationship": "..." }
  ]
}`
            }
        ];
        
        resolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages })
        ];
        
        try {
            const result = await runAllPrompts({
                ...args,
                model: 'oai-gpt41',
                useMemory: false,
                stream: false
            });
            
            const responseText = typeof result === 'string' ? result : (result?.output_text || result?.text || '');
            
            // Validate it's JSON
            try {
                const parsed = JSON.parse(responseText);
                logger.info(`Deep analysis found: ${parsed.consolidations?.length || 0} consolidations, ${parsed.patterns?.length || 0} patterns`);
                return responseText;
            } catch {
                // Try to extract JSON from markdown code blocks
                const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) {
                    const parsed = JSON.parse(match[1]);
                    logger.info(`Deep analysis found: ${parsed.consolidations?.length || 0} consolidations, ${parsed.patterns?.length || 0} patterns`);
                    return match[1].trim();
                }
                throw new Error('Response is not valid JSON');
            }
        } catch (error) {
            logger.error(`Deep analysis failed: ${error.message}`);
            return JSON.stringify({
                consolidations: [],
                patterns: [],
                contradictions: [],
                suggestedLinks: []
            });
        }
    }
};

