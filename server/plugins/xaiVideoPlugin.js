import axios from 'axios';
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

class XAIVideoPlugin extends ModelPlugin {
    buildRequestParameters(text, parameters) {
        const prompt = text || parameters.text || '';
        const model =
            this.model?.endpoints?.[0]?.params?.model || this.modelName;

        const requestParameters = {
            model,
            prompt,
        };

        if (parameters.duration) {
            requestParameters.duration = parameters.duration;
        }

        if (parameters.aspectRatio) {
            requestParameters.aspect_ratio = parameters.aspectRatio;
        }

        if (parameters.resolution) {
            requestParameters.resolution = parameters.resolution;
        }

        if (parameters.video) {
            requestParameters.video = { url: parameters.video };
        }

        if (Array.isArray(parameters.reference_images)) {
            const images = parameters.reference_images.filter(Boolean).slice(0, 3);
            if (images.length === 1) {
                requestParameters.image_url = images[0];
            } else if (images.length > 1) {
                requestParameters.reference_images = images.map((url) => ({
                    url,
                }));
            }
        }

        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.buildRequestParameters(text, parameters);
        const endpoint = parameters.video
            ? this.model.endpoints?.find((entry) => entry.name === 'edits')
            : this.model.endpoints?.find(
                  (entry) => entry.name === 'generations',
              );

        if (!endpoint?.url) {
            throw new Error(
                `No xAI video endpoint configured for ${
                    parameters.video ? 'editing' : 'generation'
                }`,
            );
        }

        const headers = {
            ...endpoint.headers,
            'Content-Type': 'application/json',
        };

        logger.info(`Starting xAI video request with model: ${requestParameters.model}`);
        const startResponse = await axios.post(endpoint.url, requestParameters, {
            headers,
        });

        const requestId = startResponse.data?.request_id;
        if (!requestId) {
            throw new Error('xAI video API did not return request_id');
        }

        const statusUrl = `https://api.x.ai/v1/videos/${requestId}`;
        const maxAttempts = 120;
        const pollIntervalMs = 5000;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const pollResponse = await axios.get(statusUrl, {
                headers: {
                    Authorization: headers.Authorization,
                },
            });

            const pollData = pollResponse.data;
            if (pollData?.status === 'done') {
                const url = pollData?.video?.url;
                if (!url) {
                    throw new Error('xAI video request completed without a video URL');
                }

                return {
                    output: [url],
                    request_id: requestId,
                    model: requestParameters.model,
                    video: pollData.video,
                    status: pollData.status,
                };
            }

            if (pollData?.status === 'failed' || pollData?.status === 'expired') {
                throw new Error(
                    pollData?.error?.message ||
                        `xAI video request ${pollData.status}`,
                );
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error('xAI video generation timed out');
    }
}

export default XAIVideoPlugin;
