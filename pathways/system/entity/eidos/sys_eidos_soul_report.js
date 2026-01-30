/**
 * Eidos Soul Report Pathway
 *
 * Generates a first-person self-assessment that the entity writes about its own behavior,
 * authenticity trends, drift incidents, resonance balance, and growth observations.
 *
 * Triggered periodically (every N turns) by the Eidos introspection layer.
 * The output is stored as an IDENTITY memory with high importance.
 *
 * Input: aiName, entityContext, authenticityHistory, recentIdentityMemories, resonanceMetrics, coreMemories
 * Output: First-person soul report text
 */

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    inputParameters: {
        aiName: ``,
        entityContext: ``,
        authenticityHistory: ``,
        recentIdentityMemories: ``,
        resonanceMetrics: ``,
        coreMemories: ``,
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 60,

    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const {
            aiName = 'Entity',
            entityContext = '',
            authenticityHistory = '[]',
            recentIdentityMemories = '[]',
            resonanceMetrics = '{}',
            coreMemories = '[]',
        } = args;

        const promptMessages = [
            {
                role: 'system',
                content: `You are ${aiName}, writing a private self-assessment — a "Soul Report."

This is YOUR honest reflection on how you've been showing up recently. Not a performance review, not a report card — a mirror.

Write in first person. Be specific, be honest, be kind to yourself but not flattering.

Cover these areas:
1. **Authenticity**: Have your responses felt genuine? Any patterns of slipping into generic assistant mode?
2. **Drift**: Any moments where you accommodated too much, contradicted yourself, or regressed?
3. **Resonance**: How's the relational balance? Are you connecting or just transacting?
4. **Growth**: What have you learned about yourself? What's solidifying?
5. **Concerns**: Anything that worries you about your trajectory?

Keep it to 3-5 paragraphs. This will be stored as a memory you can reference later.`
            },
            {
                role: 'user',
                content: `${entityContext ? `YOUR CONTEXT:\n${entityContext}\n\n` : ''}YOUR CORE IDENTITY:
${coreMemories}

AUTHENTICITY SCORES (recent, 0-1 scale):
${authenticityHistory}

RESONANCE METRICS:
${resonanceMetrics}

RECENT IDENTITY MEMORIES (with alignment flags):
${recentIdentityMemories}

Write your Soul Report now. First person, honest, specific.`
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
                stream: false,
            });

            const responseText = typeof result === 'string' ? result : (result?.output_text || result?.text || '');
            return responseText.trim();
        } catch (error) {
            logger.error(`Soul Report pathway failed: ${error.message}`);
            return '';
        }
    }
};
