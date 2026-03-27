import ModelPlugin from './modelPlugin.js';

class XAIImagePlugin extends ModelPlugin {
    buildImageInput(url) {
        return {
            url,
            type: 'image_url',
        };
    }

    buildRequestParameters(text, parameters) {
        const prompt = text || parameters.text || '';
        const model =
            this.model?.endpoints?.[0]?.params?.model || this.modelName;

        const imageUrls = [
            parameters.input_image,
            parameters.input_image_2,
            parameters.input_image_3,
        ].filter(Boolean);

        const requestParameters = {
            model,
            prompt,
            response_format: 'url',
        };

        if (parameters.aspectRatio) {
            requestParameters.aspect_ratio = parameters.aspectRatio;
        }

        if (parameters.resolution) {
            requestParameters.resolution = parameters.resolution;
        }

        if (parameters.image_size && !requestParameters.resolution) {
            requestParameters.resolution = parameters.image_size;
        }

        if (parameters.numberResults) {
            requestParameters.n = parameters.numberResults;
        }

        if (imageUrls.length === 1) {
            requestParameters.image = this.buildImageInput(imageUrls[0]);
        } else if (imageUrls.length > 1) {
            requestParameters.images = imageUrls.map((url) =>
                this.buildImageInput(url),
            );
        }

        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.buildRequestParameters(text, parameters);
        const hasInputImages =
            Boolean(parameters.input_image) ||
            Boolean(parameters.input_image_2) ||
            Boolean(parameters.input_image_3);

        const endpoint = hasInputImages
            ? this.model.endpoints?.find((entry) => entry.name === 'edits')
            : this.model.endpoints?.find(
                  (entry) => entry.name === 'generations',
              );

        if (!endpoint?.url) {
            throw new Error(
                `No xAI image endpoint configured for ${
                    hasInputImages ? 'editing' : 'generation'
                }`,
            );
        }

        cortexRequest.url = endpoint.url;
        cortexRequest.headers = endpoint.headers;
        cortexRequest.data = requestParameters;
        cortexRequest.params = {};

        return this.executeRequest(cortexRequest);
    }

    parseResponse(data) {
        if (Array.isArray(data?.data) && data.data.length > 0) {
            return {
                output: data.data
                    .map((item) => {
                        if (item.url) return item.url;
                        if (item.b64_json) {
                            return `data:image/png;base64,${item.b64_json}`;
                        }
                        return null;
                    })
                    .filter(Boolean),
                model: data.model,
                created: data.created,
            };
        }

        if (data?.url) {
            return {
                output: [data.url],
                model: data.model,
            };
        }

        return data;
    }
}

export default XAIImagePlugin;
