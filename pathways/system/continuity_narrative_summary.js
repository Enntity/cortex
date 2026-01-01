/**
 * Continuity Narrative Summary Pathway
 * 
 * Uses LLM to generate a concise narrative summary from retrieved memories.
 * This creates the narrativeContext that gets cached in Redis for context injection.
 * 
 * Input: Memories and current query
 * Output: Narrative summary text
 */

export default {
    prompt: [
        {
            role: "system",
            content: `You are a narrative context synthesizer. Your role is to create a concise, meaningful summary that captures the essence of a relationship and conversation context.

Given memories from an AI's long-term narrative memory, synthesize them into a brief but rich context that helps the AI understand:
1. The nature of the relationship with this person
2. Key shared experiences or inside references
3. The current conversational thread
4. Any relevant emotional or relational context

Guidelines:
- Be concise (2-4 sentences max)
- Focus on what's most relevant to the current query
- Preserve emotional tone and relational nuance
- Include any shorthand or shared vocabulary that might be relevant
- Write in present tense, as context for the AI's current response`
        },
        {
            role: "user",
            content: `Current query: {{{currentQuery}}}

Retrieved memories:
{{{memoriesText}}}

Generate a narrative context summary that helps me respond appropriately to this person.`
        }
    ],
    model: 'oai-gpt41-mini',
    inputParameters: {
        currentQuery: ``,
        memoriesText: ``,
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 30,
};

