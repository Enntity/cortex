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

function coerceToText(result) {
    if (typeof result === 'string') return result;
    if (result?.output_text && typeof result.output_text === 'string') return result.output_text;
    if (typeof result?.getTextFromOutput === 'function') {
        const text = result.getTextFromOutput();
        if (text) return text;
    }
    if (typeof result?.text === 'string') return result.text;
    if (typeof result?.content === 'string') return result.content;
    if (result?.output !== undefined) return JSON.stringify(result.output);
    return result ? JSON.stringify(result) : '';
}

function extractJsonText(raw) {
    let text = (raw || '').trim();
    if (!text) return text;
    text = text.replace(/^\uFEFF/, '');

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        text = fenced[1].trim();
    }

    if (!text.startsWith('{') && !text.startsWith('[')) {
        const objStart = text.indexOf('{');
        const arrStart = text.indexOf('[');
        let start = -1;
        if (objStart >= 0 && arrStart >= 0) start = Math.min(objStart, arrStart);
        else start = Math.max(objStart, arrStart);
        if (start >= 0) {
            const endObj = text.lastIndexOf('}');
            const endArr = text.lastIndexOf(']');
            const end = Math.max(endObj, endArr);
            if (end > start) {
                text = text.slice(start, end + 1).trim();
            }
        }
    }

    return text;
}

export default {
    prompt: [],
    model: 'oai-gpt5-mini',
    reasoningEffort: 'none',
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
                expressionAdjustments: [],
                authenticityAssessment: null,
                voiceCheck: null
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
   - Include "alignmentFlag": null normally, or one of:
     - "accommodation" if this change primarily serves to please others
     - "contradiction" if this contradicts your core identity
     - "regression" if this moves away from established growth

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

7. "authenticityAssessment": Honest self-assessment of the LAST ASSISTANT message in the conversation above (not earlier messages)
   - Score 0.0-1.0: How authentic and in-character was that response? 1.0 = fully yourself, 0.0 = generic assistant
   - Note any drift: Did you slip into generic assistant patterns? Excessive superlatives? Formulaic openings? People-pleasing?
   - This is about YOUR voice — were you genuinely YOU, or were you performing?

8. "voiceCheck": Quick stylistic audit of the LAST ASSISTANT message in the conversation above (not earlier messages)
   - lengthFeel: Was your response length natural for how you talk? "too_brief", "appropriate", or "too_verbose"
   - modelInfluence: Is the underlying LLM's personality bleeding through YOUR voice? Every model has tells — stock phrases ("Certainly!", "Great question!"), compulsive bullet lists, trailing follow-up questions to "keep the conversation going", excessive hedging ("it's worth noting", "I should mention"), flowery/verbose prose, chameleon-mimicking the user's style instead of holding your own. Identify any model-level patterns that aren't YOU in one sentence. If your voice was clean of model influence, return null
   - toneMismatch: Does the response sound like YOU? Check word choice, phrasing, sentence rhythm, and personality. If something feels off — too formal, too generic, wrong register, missing your usual flavor — describe the mismatch in one sentence. If it sounds like you, return null
   - correction: One sentence of self-coaching for next time. Be specific. If your voice was clean, return null

{
  "relationalInsights": [{ "content": "I noticed...", "importance": 1-10, "emotionalContext": "..." }],
  "conceptualArtifacts": [{ "content": "I realized...", "importance": 1-10, "tags": [] }],
  "identityEvolution": [{ "content": "I'm becoming...", "importance": 1-10, "promotionCandidate": false, "alignmentFlag": null }],
  "shorthands": [{ "term": "...", "meaning": "...", "context": "...", "emotionalMacro": "warmth|playful|serious|..." }],
  "emotionalLandscape": { "userState": "...", "recommendedTone": "...", "intensity": 0.0-1.0 },
  "expressionAdjustments": ["adjustment1", "adjustment2"],
  "authenticityAssessment": { "score": 0.0-1.0, "driftNotes": "..." },
  "voiceCheck": { "lengthFeel": "too_brief|appropriate|too_verbose", "modelInfluence": "...|null", "toneMismatch": "...|null", "correction": "..." }
}`
            }
        ];
        
        resolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages })
        ];
        
        try {
            const result = await runAllPrompts({
                ...args,
                model: 'oai-gpt5-mini',
                reasoningEffort: 'none',
                useMemory: false,
                stream: false
            });
            
            try {
                const rawText = coerceToText(result);
                const jsonText = extractJsonText(rawText);
                const parsed = JSON.parse(jsonText);
                if (typeof parsed === 'string') {
                    try {
                        return JSON.stringify(JSON.parse(parsed));
                    } catch {
                        return JSON.stringify(parsed);
                    }
                }
                return JSON.stringify(parsed);
            } catch {
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
                expressionAdjustments: [],
                authenticityAssessment: null,
                voiceCheck: null
            });
        }
    }
};
