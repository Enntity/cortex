export default {
    prompt: ['{{text}}'],

    enableDuplicateRequests: false,
    inputParameters: {
        text: '',
        model: 'xai-grok-imagine-image',
        async: false,
        input_image: '',
        input_image_2: '',
        input_image_3: '',
        aspectRatio: '1:1',
        resolution: '1k',
        numberResults: 1,
    },

    timeout: 60 * 10,
};
