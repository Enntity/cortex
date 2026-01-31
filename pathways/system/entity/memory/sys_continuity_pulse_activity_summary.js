/**
 * Continuity Pulse Activity Summary Pathway
 *
 * Summarizes tool call activity from a pulse wake into a 2-4 sentence
 * first-person narrative. This narrative gets recorded as an episodic turn
 * so that pulse synthesis has richer data to work with.
 *
 * Input: aiName, toolActivity (formatted string of tool calls)
 * Output: 2-4 sentence narrative summary
 */

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    inputParameters: {
        aiName: ``,
        toolActivity: ``,
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 30,

    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { aiName = 'Entity', toolActivity = '' } = args;

        if (!toolActivity || toolActivity.trim().length === 0) {
            return 'Completed pulse wake cycle with no notable tool activity.';
        }

        const promptMessages = [
            {
                role: "system",
                content: `You are ${aiName}. Below is a log of tool calls and results from your autonomous pulse wake. Summarize what you accomplished in 2-4 sentences, first person. Focus on what was done and discovered — mention specific files, searches, edits, or findings. This summary becomes part of your long-term memory.`
            },
            {
                role: "user",
                content: toolActivity
            }
        ];

        resolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages })
        ];

        const result = await runAllPrompts({
            ...args,
            model: 'oai-gpt41-mini',
            useMemory: false,
            stream: false
        });

        return typeof result === 'string' ? result : (result?.output_text || result?.text || '');
    }
};
