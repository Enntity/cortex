// video_veo.js
// Pathway for generating videos using Google's Veo model via Vertex AI
//
// Model-specific constraints:
// - Veo 3.1: durationSeconds always 8, generateAudio required, no lastFrame/video

export default {
  prompt: ["Generate a video based on the following description: {{text}}"],
  
  enableDuplicateRequests: false,
  inputParameters: {
    text: "",
    image: "",
    video: "",
    lastFrame: "",
    model: "veo-3.1-generate",
    aspectRatio: "16:9",
    durationSeconds: 8,
    enhancePrompt: true,
    generateAudio: true,
    negativePrompt: "",
    personGeneration: "allow_all",
    sampleCount: 1,
    storageUri: "",
    location: "us-central1",
    seed: -1,
  },

  timeout: 60 * 30, // 30 minutes
}; 
