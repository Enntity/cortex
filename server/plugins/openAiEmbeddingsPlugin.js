// OpenAiEmbeddingsPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

class OpenAiEmbeddingsPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...this.model.params, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, combinedParameters, prompt);
        
        // if these are in the model definition, they should override the parameters
        const { model, dimensions } = {...combinedParameters, ...this.model.params};

        const requestParameters = {
            data:  {
                input: combinedParameters?.input?.length ? combinedParameters.input :  modelPromptText || text,
                model
            }
        };
        // Support dimensions parameter for text-embedding-3 models
        // Allows dimension reduction (e.g., large model at 1536) or explicit sizing
        if (dimensions) {
            requestParameters.data.dimensions = dimensions;
        }
        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = requestParameters.data || {};
        cortexRequest.params = requestParameters.params || {};

        return this.executeRequest(cortexRequest);
    }

    parseResponse(data) {
        return JSON.stringify(data?.data?.map( ({embedding}) => embedding) || []);
    }

    /**
     * Override logRequestData to sanitize embeddings (truncate vectors in logs)
     */
    logRequestData(data, responseData, prompt) {
        const modelInput = data?.input || (Array.isArray(data?.input) ? data.input.join(', ') : '');
    
        if (modelInput) {
            const { length, units } = this.getLength(modelInput);
            logger.info(`[request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(modelInput)}`);
        }
    
        // Sanitize embeddings response - show summary with redaction evidence
        try {
            const parsed = typeof responseData === 'string' ? JSON.parse(responseData) : responseData;
            if (Array.isArray(parsed) && parsed.length > 0) {
                // Show summary: number of embeddings and dimensions
                const dimensions = Array.isArray(parsed[0]) ? parsed[0].length : 0;
                const summary = `[${parsed.length} embedding(s), ${dimensions} dimensions each]`;
                logger.info(`[response received containing ${summary}]`);
                // Show redacted version in verbose - indicates vectors were present but truncated
                const redacted = parsed.map((vec, idx) => 
                    Array.isArray(vec) ? `[embedding ${idx + 1}: ${vec.length} dimensions, redacted]` : vec
                );
                logger.verbose(`${JSON.stringify(redacted)}`);
            } else {
                const { length, units } = this.getLength(JSON.stringify(responseData));
                logger.info(`[response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(JSON.stringify(responseData))}`);
            }
        } catch (error) {
            // Fallback to base behavior if parsing fails
            const responseText = JSON.stringify(responseData);
            const { length, units } = this.getLength(responseText);
            logger.info(`[response received containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(responseText)}`);
        }
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }

}

export default OpenAiEmbeddingsPlugin;
