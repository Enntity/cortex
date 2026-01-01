/**
 * Continuity Memory Upsert Pathway
 * 
 * Provides rate-limited document upsert operations for the Continuity Memory Architecture.
 * Uses the azure-cognitive model to ensure consistent rate limiting with other cognitive operations.
 * 
 * Input: JSON stringified document with continuity memory schema
 * Output: JSON response from Azure AI Search
 */

export default {
    prompt: `{{{text}}}`,
    model: 'azure-cognitive',
    inputParameters: {
        indexName: `index-continuity-memory`,
        document: ``,      // JSON stringified document to upsert
        inputVector: ``,   // Pre-computed embedding vector (optional)
    },
    mode: 'continuity-upsert',
    enableDuplicateRequests: false,
    timeout: 60,
};

