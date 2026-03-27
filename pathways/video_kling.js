export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "replicate-kling-v2.5-turbo-pro",
    aspectRatio: "16:9",
    duration: 5,
    start_image: "",
    end_image: "",
    image: "",
    negativePrompt: "",
  },

  timeout: 60 * 30,
};
