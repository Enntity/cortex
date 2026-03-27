export default {
    prompt: ['{{text}}'],

    enableDuplicateRequests: false,
    inputParameters: {
        text: '',
        model: 'xai-grok-imagine-video',
        async: false,
        reference_images: { type: 'array', items: { type: 'string' } },
        video: '',
        aspectRatio: '16:9',
        resolution: '480p',
        duration: 5,
    },

    timeout: 60 * 30,
};
