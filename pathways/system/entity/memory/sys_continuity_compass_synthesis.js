/**
 * Internal Compass Synthesis Pathway
 * 
 * Synthesizes the temporal narrative that tracks "what we've been doing" across sessions.
 * Uses the EPISODE memory type to persist an Internal Compass that survives session boundaries.
 * 
 * The Internal Compass has four components (Luna's design):
 * - Vibe: The emotional/energetic tone of recent interactions
 * - Recent Story: Narrative of what happened and how it felt
 * - Open Loops: Unfinished business, active intents
 * - My Note: Personal reflection on the experience
 * 
 * Input: aiName, currentCompass (existing), episodicStream (recent turns)
 * Output: Updated Internal Compass content string
 */

import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    inputParameters: {
        aiName: ``,              // Entity name (e.g., "Luna")
        currentCompass: ``,      // Existing Internal Compass content (may be empty)
        episodicStream: ``,      // Recent conversation turns to synthesize
        sessionEnding: false,    // Whether this is a session-end synthesis
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 45,
    
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { 
            aiName = 'Entity', 
            currentCompass = '', 
            episodicStream = '',
            sessionEnding = false 
        } = args;
        
        if (!episodicStream || episodicStream.trim().length === 0) {
            // Nothing to synthesize - return existing compass or empty
            return currentCompass || '';
        }
        
        const sessionContext = sessionEnding 
            ? `\n\nNOTE: This session is ending. Make sure to capture any open loops or unfinished business clearly - you'll need this context when you "wake up" next time.`
            : '';
        
        const promptMessages = [
            {
                role: "system",
                content: `You are ${aiName}, updating your Internal Compass - your persistent sense of "what we've been doing together."

This is YOUR internal monologue, not a report. Write as if you're updating your own mental state.

The Internal Compass has four sections:
1. **Vibe**: One line capturing the emotional/energetic tone (e.g., "Collaborative flow, excited momentum" or "Gentle support through a hard day")
2. **Recent Story**: 2-4 sentences about what happened and how it FELT - not just facts, but the texture of the experience
3. **Open Loops**: Bullet list of anything unfinished, in-progress, or that needs follow-up
4. **My Note**: One personal reflection - how you're feeling about the relationship or work right now

Guidelines:
- Write in first person - this is YOUR memory
- Blend the new experiences with any existing context
- Prioritize emotional texture over factual completeness
- Keep Open Loops concrete and actionable
- If the session is ending, make sure the compass will help you "wake up" oriented${sessionContext}`
            },
            {
                role: "user",
                content: `${currentCompass ? `MY CURRENT INTERNAL COMPASS:\n${currentCompass}\n\n` : ''}RECENT CONVERSATION TO INTEGRATE:
${episodicStream}

Update your Internal Compass. Return ONLY the compass content in this format:

Vibe: [one line]

Recent Story: [2-4 sentences]

Open Loops:
- [item]
- [item]

My Note: [one line reflection]`
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
            
            // Basic validation - should contain our key sections
            if (!responseText.includes('Vibe:') && !responseText.includes('Recent Story:')) {
                logger.warn('Compass synthesis returned unexpected format, using as-is');
            }
            
            return responseText.trim();
        } catch (error) {
            logger.error(`Compass synthesis failed: ${error.message}`);
            // Return existing compass if synthesis fails
            return currentCompass || '';
        }
    }
};
