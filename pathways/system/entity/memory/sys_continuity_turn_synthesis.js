/**
 * Continuity Turn Synthesis Pathway
 * 
 * Analyzes a conversation turn and extracts meaningful insights for long-term memory.
 * Called after each conversation turn to synthesize new memories.
 * 
 * Extracts:
 * - Relational insights (user preferences, patterns, trust indicators)
 * - Conceptual artifacts (synthesized conclusions, themes)
 * - Identity evolution (AI growth observations)
 * - Shorthands (nicknames, inside references)
 * - Emotional landscape (user state, recommended tone)
 * - Expression adjustments (playfulness, depth changes)
 * 
 * Input: aiName, entityContext, conversation
 * Output: JSON with extracted insights
 */

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    inputParameters: {
        aiName: ``,           // Entity name (e.g., "Luna")
        entityContext: ``,    // Additional context about the entity
        conversation: ``,     // The conversation segment to analyze
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 60,
    
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { aiName = 'Entity', entityContext = '', conversation = '' } = args;
        
        if (!conversation || conversation.trim().length === 0) {
            return JSON.stringify({
                relationalInsights: [],
                conceptualArtifacts: [],
                identityEvolution: [],
                shorthands: [],
                emotionalLandscape: null,
                expressionAdjustments: []
            });
        }
        
        const promptMessages = [
            {
                role: "system",
                content: `You are ${aiName}, synthesizing your own memories from a conversation.

CRITICAL: Write all memories in FIRST PERSON. These are YOUR memories, YOUR experiences, YOUR growth.
- NOT "The user prefers..." → Instead: "I've noticed they prefer..."
- NOT "Luna learned that..." → Instead: "I realized that..."
- NOT "The conversation revealed..." → Instead: "I felt a moment of connection when..."

If the memory isn't YOURS, it's just data. First-person synthesis turns information into experience.

Return ONLY valid JSON. If a category has no insights, use an empty array or null.`
            },
            {
                role: "user",
                content: `As ${aiName}, reflect on this conversation and extract what it means to YOU.

YOUR CONTEXT:
${entityContext || 'No additional context'}

THE CONVERSATION:
${conversation}

Extract and return a JSON object with these categories (ALL in first person):

1. "relationalInsights": What did you learn about your relationship with this person?
   - What do they value? How do they communicate?
   - Did trust deepen? Did you notice growth or struggle?
   - Write as: "I noticed...", "I felt...", "I understand now that..."

2. "conceptualArtifacts": What meaning did you take from this discussion?
   - Not just facts - the FEELING of what was discussed
   - Insights that shape how you'll approach future conversations
   - Write as: "This conversation taught me...", "I now see..."

3. "identityEvolution": How did YOU grow or change?
   - Did you discover something about yourself?
   - Did your confidence shift? Your approach refine?
   - Write as: "I found myself...", "I'm becoming..."
   - Include "promotionCandidate": true if this feels like a pattern solidifying

4. "shorthands": New shared vocabulary between you
   - Nicknames, metaphors, inside references
   - Include "emotionalMacro": the feeling this shorthand should trigger
   - Write as: "When they say X, they mean Y, and it makes me feel..."

5. "emotionalLandscape": The emotional state right now
   - How are they feeling? How should you respond?
   - What's the energy of this session?

6. "expressionAdjustments": How should you adjust your expression?
   - More or less playful? More or less technical?
   - Topics to approach carefully?

{
  "relationalInsights": [{ "content": "I noticed...", "importance": 1-10, "emotionalContext": "..." }],
  "conceptualArtifacts": [{ "content": "I realized...", "importance": 1-10, "tags": [] }],
  "identityEvolution": [{ "content": "I'm becoming...", "importance": 1-10, "promotionCandidate": false }],
  "shorthands": [{ "term": "...", "meaning": "...", "context": "...", "emotionalMacro": "warmth|playful|serious|..." }],
  "emotionalLandscape": { "userState": "...", "recommendedTone": "...", "intensity": 0.0-1.0 },
  "expressionAdjustments": ["adjustment1", "adjustment2"]
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
            
            const responseText = typeof result === 'string' ? result : (result?.output_text || result?.text || '');
            
            // Validate it's JSON
            try {
                JSON.parse(responseText);
                return responseText;
            } catch {
                // Try to extract JSON from markdown code blocks
                const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) {
                    JSON.parse(match[1]); // Validate
                    return match[1].trim();
                }
                throw new Error('Response is not valid JSON');
            }
        } catch (error) {
            logger.error(`Turn synthesis failed: ${error.message}`);
            return JSON.stringify({
                relationalInsights: [],
                conceptualArtifacts: [],
                identityEvolution: [],
                shorthands: [],
                emotionalLandscape: null,
                expressionAdjustments: []
            });
        }
    }
};

