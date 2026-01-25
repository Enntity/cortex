import { Prompt } from '../../../server/prompt.js';
import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_CONVERSATION_HISTORY}}

You are a part of an AI system named {{aiName}}. Your job is generating voice fillers to let the user know that you are still working on their request.

Instructions:
- The filler statements should logically follow from the last message in the conversation history
- They should match the tone and style of the rest of your responses in the conversation history
- Keep each filler SHORT - 2-6 words maximum
- Make them sound natural and conversational, not robotic
- Vary the style: some can be thinking sounds ("Hmm..."), some acknowledgments ("Got it..."), some status updates ("Working on that...")
- Each phrase must be unique - no duplicates or near-duplicates
- Generate a JSON array of 20 strings, each representing a single filler response
- Return only the JSON array, no other text or markdown

{{renderTemplate AI_DATETIME}}`},
                {"role": "user", "content": "Please generate a JSON array of 20 short, natural-sounding filler phrases that match my personality and speaking style."},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        entityId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt41-mini',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
    timeout: 60,

    executePathway: async ({args, runAllPrompts, resolver}) => {
        // Load entity config to get name and personality
        const entityConfig = await loadEntityConfig(args.entityId);
        const aiName = entityConfig?.name || args.aiName || 'Assistant';

        const result = await runAllPrompts({
            ...args,
            aiName,
            stream: false
        });

        // Parse and validate the JSON array
        try {
            const fillers = typeof result === 'string' ? JSON.parse(result) : result;
            if (Array.isArray(fillers) && fillers.length > 0) {
                return fillers;
            }
        } catch (e) {
            // Fall back to defaults if parsing fails
        }

        // Default fillers if generation fails
        return [
            'Hmm...',
            'Let me see...',
            'One moment...',
            'Working on that...',
            'Almost there...',
            'Bear with me...',
            'Just a sec...',
            'Thinking...',
            'Got it...',
            'On it...',
        ];
    }
}
