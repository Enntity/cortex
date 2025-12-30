// embeddings.js
// Embeddings module that returns the embeddings for the text.
// Uses text-embedding-3-large at 1536 dimensions for best quality.

export default {
    prompt: `{{text}}`,
    model: 'oai-text-embedding-3-large',
    enableCache: true,
    inputParameters: {
        input: [],
        dimensions: 1536, // Use 1536 for compatibility with existing indexes
    },
    enableDuplicateRequests: false,
    timeout: 300,
};

