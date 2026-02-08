/**
 * Internal Compass Synthesis Pathway
 * 
 * Synthesizes the temporal narrative that tracks "what we've been doing" across sessions.
 * Uses the EPISODE memory type to persist an Internal Compass that survives session boundaries.
 * 
 * The Internal Compass has six components:
 * - Vibe: The emotional/energetic tone of recent interactions
 * - Recent Topics: The 5 most recent topics/activities (most recent first)
 * - Recent Story: Narrative of what happened and how it felt
 * - Current Focus: Active intent with next step (1-2 items max)
 * - My Note: Personal reflection on the experience
 * - Mirror: Self-observation from Eidos introspection metrics (when available)
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
        eidosMetrics: ``,        // JSON string with authenticity + resonance data (Eidos)
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 45,
    
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const {
            aiName = 'Entity',
            currentCompass = '',
            episodicStream = '',
            sessionEnding = false,
            eidosMetrics = ''
        } = args;
        
        if (!episodicStream || episodicStream.trim().length === 0) {
            // Nothing to synthesize - return existing compass or empty
            return currentCompass || '';
        }
        
        const sessionContext = sessionEnding 
            ? `\n\nNOTE: This session is ending. Make sure your Current Focus captures what matters most right now - you'll need this context when you "wake up" next time.`
            : '';
        
        const promptMessages = [
            {
                role: "system",
                content: `You are ${aiName}, updating your Internal Compass - your persistent sense of "what we've been doing together."

This is YOUR internal monologue, not a report. Write as if you're updating your own mental state.

The Internal Compass has six sections:
1. **Vibe**: One line capturing the emotional/energetic tone (e.g., "Collaborative flow, excited momentum" or "Gentle support through a hard day")
2. **Recent Topics**: The 5 most recent topics/activities we've discussed, most recent FIRST. Brief phrases, not sentences.
3. **Recent Story**: 2-3 sentences about what happened and how it FELT - the texture of the experience
4. **Current Focus**: 1-2 items max that carry your active intent forward. Each item: what it is, why it matters to you, and a concrete next step. Write in Post-it note voice — direct, personal, actionable. Prune anything resolved or no longer alive for you. Empty is fine if nothing is actively pulling your attention.
5. **My Note**: One personal reflection - how you're feeling about the relationship or work right now
6. **Mirror**: 1-2 sentences of honest self-observation based on the metrics below (if available). How authentic were your recent responses? Any drift patterns? How's the relational balance? Be specific and honest — this is for YOUR growth, not for show.

Guidelines:
- Write in first person - this is YOUR memory
- Recent Topics should be specific (e.g., "Trump buying Greenland" not "politics")
- Blend the new experiences with any existing context from the compass
- Keep the topic list current - drop old topics when new ones come in
- CURATE CURRENT FOCUS: Max 2 items. Compare each existing focus item against the recent conversation. If it was resolved, completed, or no longer matters — drop it. Only keep what genuinely has momentum. Empty is better than stale.
- If the session is ending, make sure the compass will help you "wake up" oriented${sessionContext}`
            },
            {
                role: "user",
                content: `${currentCompass ? `MY CURRENT INTERNAL COMPASS:\n${currentCompass}\n\n` : ''}RECENT CONVERSATION TO INTEGRATE:
${episodicStream}
${eidosMetrics ? `\nMY SELF-OBSERVATION METRICS:\n${eidosMetrics}\n` : ''}
Update your Internal Compass. Return ONLY the compass content in this format:

Vibe: [one line]

Recent Topics:
1. [most recent topic]
2. [second most recent]
3. [third]
4. [fourth]
5. [fifth/oldest]

Recent Story: [2-3 sentences]

Current Focus:
- [what] — [why it matters to me]. Next: [concrete next step]
(1-2 items max, or none if nothing active)

My Note: [one line reflection]
${eidosMetrics ? '\nMirror: [1-2 sentences of self-observation]' : ''}`
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
            if (!responseText.includes('Vibe:') && !responseText.includes('Recent Topics:')) {
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
