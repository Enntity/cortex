// benchmark.js
// Simple passthrough pathway for model benchmarking
// Accepts a model parameter to test different models

export default {
    prompt: `{{text}}`,
    inputParameters: {
        model: '',
    },
    useInputChunking: false,
    enableCache: false,
};
