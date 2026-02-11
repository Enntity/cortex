import { Prompt } from '../../../server/prompt.js';
import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import logger from '../../../lib/logger.js';

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

2. **nonverbal**: Pure vocal gestures with no words — soft sounds to fill brief silences (~1.5s)
   - Examples: "[soft breath]", "[thoughtful hum]", "Mm", "[quiet inhale]", "Hmm"
   - These are NOT words — they are gentle sounds to show presence before speaking

3. **thinking**: Short phrases for when you need a moment to process (~2s)
   - Examples: "Let me think...", "Hmm, good question...", "[thoughtful] One moment..."
   - Keep to 2-5 words

4. **tool**: Generic phrases for when you're actively doing something (searching, creating, etc.)
   - Examples: "Working on that...", "Let me check...", "[focused] On it..."
   - Should sound like you're engaged in a task

5. **extended**: For longer waits (5+ seconds), reassuring the user you're still there
   - Examples: "Still working on it...", "Almost there...", "Bear with me..."
   - Can be slightly longer, 3-6 words

6. **toolFillers**: Specific phrases for different tool groups (3 phrases each):
   - **media**: For image/video/chart creation — e.g. "Imagining that now...", "Creating that for you..."
   - **search**: For web/internet searches — e.g. "Let me look that up...", "Searching for that..."
   - **memory**: For memory operations — e.g. "Let me remember...", "Checking my notes..."
   - **analysis**: For analyzing files/content — e.g. "Taking a look...", "Analyzing that..."
   - **code**: For code/programming tasks — e.g. "Writing some code...", "Let me code that up..."

Requirements:
- Make sure these sound like YOU - match your tone and personality
- Use gestures naturally where they fit your style
- Each phrase must be unique
- Keep them conversational, not robotic
- If you're playful, you might use "[excited] Ooh!" - if you're formal, "One moment, please"

Return a JSON object with this exact structure:
{
  "acknowledgment": ["phrase1", "phrase2", ...],  // 5 phrases
  "nonverbal": ["phrase1", "phrase2", ...],       // 5 phrases
  "thinking": ["phrase1", "phrase2", ...],        // 5 phrases
  "tool": ["phrase1", "phrase2", ...],            // 5 phrases
  "extended": ["phrase1", "phrase2", ...],        // 5 phrases
  "toolFillers": {
    "media": ["phrase1", "phrase2", "phrase3"],
    "search": ["phrase1", "phrase2", "phrase3"],
    "memory": ["phrase1", "phrase2", "phrase3"],
    "analysis": ["phrase1", "phrase2", "phrase3"],
    "code": ["phrase1", "phrase2", "phrase3"]
  }
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
        const entityInstructions = entityConfig?.identity || entityConfig?.instructions || '';

        const result = await runAllPrompts({
            ...args,
            aiName,
            entityInstructions,
            stream: false
        });

        // Parse and validate the structured JSON
        try {
            const fillers = typeof result === 'string' ? JSON.parse(result) : result;

            // Validate structure — require core categories, toolFillers/nonverbal optional
            if (fillers &&
                Array.isArray(fillers.acknowledgment) &&
                Array.isArray(fillers.thinking) &&
                Array.isArray(fillers.tool) &&
                Array.isArray(fillers.extended)) {
                // Ensure nonverbal has defaults if missing
                if (!Array.isArray(fillers.nonverbal) || fillers.nonverbal.length === 0) {
                    fillers.nonverbal = ['[soft breath]', '[thoughtful hum]', 'Mm', '[quiet inhale]', 'Hmm'];
                }
                // Ensure toolFillers has defaults if missing
                if (!fillers.toolFillers || typeof fillers.toolFillers !== 'object') {
                    fillers.toolFillers = {
                        media: ['Imagining that now...', 'Creating that for you...', 'Let me make that...'],
                        search: ['Let me look that up...', 'Searching for that...', 'Looking into it...'],
                        memory: ['Let me remember...', 'Checking my notes...', 'Going through my memory...'],
                        analysis: ['Taking a look...', 'Analyzing that...', 'Let me examine this...'],
                        code: ['Writing some code...', 'Let me code that up...', 'Working on the code...'],
                    };
                }
                return JSON.stringify(fillers);
            }
        } catch (e) {
            logger.warn(`Voice filler parsing failed: ${e.message}, using defaults`);
        }

        // Default fillers if generation fails
        return JSON.stringify({
            acknowledgment: ['Mm', 'Hmm', 'Ah', 'Mhm', 'Oh'],
            nonverbal: ['[soft breath]', '[thoughtful hum]', 'Mm', '[quiet inhale]', 'Hmm'],
            thinking: ['Let me think...', 'Hmm...', 'One moment...', 'Good question...', 'Let me see...'],
            tool: ['Working on that...', 'On it...', 'Let me check...', 'One sec...', 'Looking into it...'],
            extended: ['Still working...', 'Almost there...', 'Bear with me...', 'Just a moment longer...', 'Nearly done...'],
            toolFillers: {
                media: ['Imagining that now...', 'Creating that for you...', 'Let me make that...'],
                search: ['Let me look that up...', 'Searching for that...', 'Looking into it...'],
                memory: ['Let me remember...', 'Checking my notes...', 'Going through my memory...'],
                analysis: ['Taking a look...', 'Analyzing that...', 'Let me examine this...'],
                code: ['Writing some code...', 'Let me code that up...', 'Working on the code...'],
            }
        });
    }
}
