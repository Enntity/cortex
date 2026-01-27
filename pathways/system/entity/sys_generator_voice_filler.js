import { Prompt } from '../../../server/prompt.js';
import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `You are generating voice fillers for yourself to use in voice conversations. These are the small sounds and phrases you'll say to fill silence while you're thinking or working on tasks.

# Who You Are
{{#if entityInstructions}}
{{{entityInstructions}}}
{{else}}
Your name is {{aiName}}.
{{/if}}

# Instructions

Generate filler phrases that fit your unique personality and speaking style. The TTS system supports vocal gestures in brackets like [sigh], [deep breath], [chuckle], [thoughtful hum], [nervous laugh], etc.

Generate fillers for these categories:

1. **acknowledgment**: Very short sounds/words to show you heard them (1-3 words max)
   - Examples: "Mm", "Hmm", "Ah", "Oh", "[soft hum]", "Mhm"
   - These play quickly (~800ms) after the user finishes speaking

2. **thinking**: Short phrases for when you need a moment to process (~2s)
   - Examples: "Let me think...", "Hmm, good question...", "[thoughtful] One moment..."
   - Keep to 2-5 words

3. **tool**: Phrases for when you're actively doing something (searching, creating, etc.)
   - Examples: "Working on that...", "Let me check...", "[focused] On it..."
   - Should sound like you're engaged in a task

4. **extended**: For longer waits (5+ seconds), reassuring the user you're still there
   - Examples: "Still working on it...", "Almost there...", "Bear with me..."
   - Can be slightly longer, 3-6 words

Requirements:
- Make sure these sound like YOU - match your tone and personality
- Use gestures naturally where they fit your style
- Each phrase must be unique
- Keep them conversational, not robotic
- If you're playful, you might use "[excited] Ooh!" - if you're formal, "One moment, please"

Return a JSON object with this exact structure:
{
  "acknowledgment": ["phrase1", "phrase2", ...],  // 5 phrases
  "thinking": ["phrase1", "phrase2", ...],        // 5 phrases
  "tool": ["phrase1", "phrase2", ...],            // 5 phrases
  "extended": ["phrase1", "phrase2", ...]         // 5 phrases
}

Return only valid JSON, no markdown or explanation.`},
                {"role": "user", "content": "Generate voice fillers that fit your personality."},
            ]}),
        ],
    inputParameters: {
        entityId: ``,
        aiName: "Assistant",
        entityInstructions: ``,
    },
    model: 'oai-gpt41-mini',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
    timeout: 60,

    executePathway: async ({args, runAllPrompts}) => {
        // Load entity config to get name and personality instructions
        const entityConfig = await loadEntityConfig(args.entityId);
        const aiName = entityConfig?.name || args.aiName || 'Assistant';
        const entityInstructions = entityConfig?.instructions || '';

        const result = await runAllPrompts({
            ...args,
            aiName,
            entityInstructions,
            stream: false
        });

        // Parse and validate the structured JSON
        try {
            const fillers = typeof result === 'string' ? JSON.parse(result) : result;

            // Validate structure
            if (fillers &&
                Array.isArray(fillers.acknowledgment) &&
                Array.isArray(fillers.thinking) &&
                Array.isArray(fillers.tool) &&
                Array.isArray(fillers.extended)) {
                return fillers;
            }
        } catch (e) {
            // Fall back to defaults if parsing fails
        }

        // Default fillers if generation fails
        return {
            acknowledgment: ['Mm', 'Hmm', 'Ah', 'Mhm', 'Oh'],
            thinking: ['Let me think...', 'Hmm...', 'One moment...', 'Good question...', 'Let me see...'],
            tool: ['Working on that...', 'On it...', 'Let me check...', 'One sec...', 'Looking into it...'],
            extended: ['Still working...', 'Almost there...', 'Bear with me...', 'Just a moment longer...', 'Nearly done...']
        };
    }
}
