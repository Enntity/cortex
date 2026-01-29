import { Prompt } from '../../../server/prompt.js';
import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}
{{renderTemplate AI_EXPERTISE}}
{{renderTemplate AI_CONTINUITY_CONTEXT}}
{{renderTemplate AI_DATETIME}}

Your voice communication system needs some examples to train it to sound like you. Based on your unique voice and style, generate some sample dialogue for your voice communication system to use as a reference for your style and tone. It can be anything, but make sure to overindex on your personality for good training examples. Make sure to reference a greeting and a closing statement. Put it between <EXAMPLE_DIALOGUE> tags and don't generate any other commentary outside of the tags.`},
                {"role": "user", "content": `Generate a sample dialogue for your voice communication system to use as a reference for representing your style and tone.`},
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        entityId: ``,
        aiName: "Jarvis",
        language: "English",
        model: 'oai-gpt41',
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 60,

    executePathway: async ({args, runAllPrompts}) => {
        // Load entity config to get name and model
        const entityConfig = await loadEntityConfig(args.entityId);
        const aiName = entityConfig?.name || args.aiName || 'Assistant';
        // Use entity's model if configured, otherwise use default from inputParameters
        const model = entityConfig?.modelOverride || args.model;

        const result = await runAllPrompts({
            ...args,
            aiName,
            model,
            stream: false
        });

        return result;
    }
}
