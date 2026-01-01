/**
 * Continuity Memory Delete Pathway
 * 
 * Provides rate-limited document delete operations for the Continuity Memory Architecture.
 * Uses the azure-cognitive model to ensure consistent rate limiting with other cognitive operations.
 * 
 * Input: Document ID to delete
 * Output: JSON response from Azure AI Search
 */

export default {
    prompt: ``,
    model: 'azure-cognitive',
    inputParameters: {
        indexName: `index-continuity-memory`,
        docId: ``,         // Document ID to delete
    },
    mode: 'continuity-delete',
    enableDuplicateRequests: false,
    timeout: 60,
};

