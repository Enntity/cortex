// embeddings.js
// Embeddings module that returns the embeddings for the text.
// Uses text-embedding-3-small at 1536 dimensions (native size).
// Small provides 62.3% MTEB score vs 64.6% for large, but at 6.5x lower cost ($0.02 vs $0.13 per 1M tokens).
// Since we use 1536 dimensions (small's native), there's no benefit to using large.

export default {
    prompt: `{{text}}`,
    enableCache: true,
    inputParameters: {
        input: [],
        model: 'oai-text-embedding-3-small', // Can be overridden, but defaults to small for cost efficiency
        dimensions: 1536, // Native size for small model, matches index schema
    },
    enableDuplicateRequests: false,
    timeout: 300,
};

