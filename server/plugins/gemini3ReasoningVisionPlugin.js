import Gemini3ImagePlugin from './gemini3ImagePlugin.js';
import CortexResponse from '../../lib/cortexResponse.js';
import logger from '../../lib/logger.js';

class Gemini3ReasoningVisionPlugin extends Gemini3ImagePlugin {

    constructor(pathway, model) {
        super(pathway, model);
    }

    // Override to include thoughtSignature - required by Gemini 3 for function call history
    buildFunctionCallPart(toolCall, args) {
        const part = {
            functionCall: {
                name: toolCall.function.name,
                args: args
            }
        };
        // Include thoughtSignature if present - required by Gemini 3+ models
        // If thoughtSignature was lost (e.g., during history persistence), use the documented
        // dummy value to skip validation - see https://ai.google.dev/gemini-api/docs/thought-signatures
        if (toolCall.thoughtSignature) {
            part.thoughtSignature = toolCall.thoughtSignature;
        } else {
            // Fallback: use documented dummy signature to prevent 400 errors
            // This allows the request to proceed but may affect reasoning quality
            part.thoughtSignature = "skip_thought_signature_validator";
        }
        return part;
    }

    // Override to capture thoughtSignature from Gemini 3 functionCall responses
    buildToolCallFromFunctionCall(part) {
        const toolCall = {
            id: part.functionCall.name + '_' + Date.now() + '_' + (this._toolCallIdCounter = (this._toolCallIdCounter || 0) + 1),
            type: "function",
            function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
            }
        };
        // Preserve thoughtSignature for function call history
        if (part.functionCall.thoughtSignature || part.thoughtSignature) {
            toolCall.thoughtSignature = part.functionCall.thoughtSignature || part.thoughtSignature;
        }
        return toolCall;
    }

    // Override getRequestParameters to add Gemini 3 specific handling
    getRequestParameters(text, parameters, prompt, cortexRequest) {
        // Get original messages from getCompiledPrompt before they're converted to Gemini format
        const { modelPromptMessages } = this.getCompiledPrompt(text, parameters, prompt);
        const messages = modelPromptMessages || [];
        
        const baseParameters = super.getRequestParameters(text, parameters, prompt, cortexRequest);
        
        // Rebuild contents from original messages for Gemini 3 format.
        // The base converter drops assistant messages with empty content (losing tool_calls)
        // and doesn't convert tool_calls to functionCall parts. We rebuild directly from
        // the original messages to guarantee per-turn parity by construction:
        // each model turn with N functionCall parts is followed by one user turn with N functionResponse parts.
        if (messages.some(m => m.role === 'tool' || m.tool_calls?.length > 0)) {
            const rebuilt = [];

            for (const msg of messages) {
                if (msg.role === 'system') {
                    // System messages are handled separately by the base converter
                    continue;
                }

                if (msg.role === 'user') {
                    const raw = msg.content;
                    const text = typeof raw === 'string' ? raw
                        : Array.isArray(raw) ? raw.map(p => typeof p === 'string' ? p : p?.text || '').filter(Boolean).join('\n')
                        : '';
                    if (text.trim()) {
                        rebuilt.push({ role: 'user', parts: [{ text }] });
                    }
                } else if (msg.role === 'assistant') {
                    if (msg.tool_calls?.length > 0) {
                        // Assistant with tool_calls → model turn with functionCall parts
                        const parts = [];
                        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                            parts.push({ text: msg.content });
                        }
                        for (const toolCall of msg.tool_calls) {
                            if (toolCall.function?.name) {
                                let args = {};
                                try {
                                    args = typeof toolCall.function.arguments === 'string'
                                        ? JSON.parse(toolCall.function.arguments)
                                        : (toolCall.function.arguments || {});
                                } catch (e) { args = {}; }
                                parts.push(this.buildFunctionCallPart(toolCall, args));
                            }
                        }
                        if (parts.length > 0) {
                            rebuilt.push({ role: 'model', parts });
                        }
                    } else if (msg.content) {
                        // Text-only assistant → model turn with text
                        const text = typeof msg.content === 'string' ? msg.content
                            : Array.isArray(msg.content) ? msg.content.map(p => typeof p === 'string' ? p : p?.text || '').filter(Boolean).join('\n')
                            : '';
                        if (text.trim()) {
                            rebuilt.push({ role: 'model', parts: [{ text }] });
                        }
                    }
                } else if (msg.role === 'tool') {
                    // Tool result → user turn with functionResponse
                    const toolName = msg.name || 'unknown_tool';
                    let toolContent = msg.content;
                    if (Array.isArray(toolContent)) {
                        toolContent = toolContent.map(item => typeof item === 'string' ? item : item?.text || JSON.stringify(item)).join('\n');
                    }
                    let responseData;
                    try {
                        responseData = JSON.parse(toolContent);
                    } catch (e) {
                        responseData = { output: toolContent };
                    }
                    rebuilt.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: toolName,
                                response: responseData
                            }
                        }]
                    });
                }
            }

            // Merge consecutive same-role turns.
            // This ensures: model [N functionCalls] + user [N functionResponses] parity,
            // and merges adjacent user turns (functionResponse + review text).
            const merged = [];
            for (const c of rebuilt) {
                const prev = merged[merged.length - 1];
                if (prev && prev.role === c.role) {
                    prev.parts.push(...c.parts);
                } else {
                    merged.push(c);
                }
            }

            // Ensure the conversation starts with a user turn (Gemini requirement).
            if (merged.length > 0 && merged[0].role !== 'user') {
                const firstUserMsg = messages.find(m => m.role === 'user');
                if (firstUserMsg) {
                    const raw = firstUserMsg.content;
                    const text = typeof raw === 'string' ? raw
                        : Array.isArray(raw) ? raw.map(p => typeof p === 'string' ? p : p?.text || '').filter(Boolean).join('\n')
                        : '';
                    if (text.trim()) {
                        merged.unshift({ role: 'user', parts: [{ text }] });
                    }
                }
            }

            baseParameters.contents = merged;
        }
        
        // Add Gemini 3 thinking support
        // Gemini 3 uses thinkingLevel: 'low' or 'high' (instead of thinkingBudget)
        // includeThoughts: true to get thought summaries in response
        let thinkingLevel = parameters?.thinkingLevel ?? parameters?.thinking_level;
        let includeThoughts = parameters?.includeThoughts ?? parameters?.include_thoughts ?? false;

        // Convert OpenAI reasoningEffort to Gemini 3 thinkingLevel
        // OpenAI supports: 'high', 'medium', 'low', 'none'
        // Gemini 3 supports: 'high' or 'low' (thinking cannot be disabled)
        // Mapping: 'high' or 'medium' → 'high', 'low' or 'minimal' → 'low', 'none' → 'low'
        const reasoningEffort = parameters?.reasoningEffort ?? this.promptParameters?.reasoningEffort;
        if (reasoningEffort && thinkingLevel === undefined) {
            const effort = typeof reasoningEffort === 'string' ? reasoningEffort.toLowerCase() : String(reasoningEffort).toLowerCase();
            if (effort === 'high' || effort === 'medium' || effort === 'xhigh') {
                // High, xhigh, or medium reasoning effort → high thinking level
                thinkingLevel = 'high';
            } else {
                // Low, minimal, or none → low thinking level (Gemini 3 doesn't support disabling thinking)
                thinkingLevel = 'low';
            }
        }

        // Also check pathway parameters
        if (thinkingLevel === undefined && cortexRequest?.pathway?.thinkingLevel !== undefined) {
            thinkingLevel = cortexRequest.pathway.thinkingLevel;
        } else if (thinkingLevel === undefined && cortexRequest?.pathway?.thinking_level !== undefined) {
            thinkingLevel = cortexRequest.pathway.thinking_level;
        } else if (thinkingLevel === undefined && cortexRequest?.pathway?.reasoningEffort !== undefined) {
            // Also check pathway for reasoningEffort
            const pathwayEffort = typeof cortexRequest.pathway.reasoningEffort === 'string' 
                ? cortexRequest.pathway.reasoningEffort.toLowerCase() 
                : String(cortexRequest.pathway.reasoningEffort).toLowerCase();
            if (pathwayEffort === 'high' || pathwayEffort === 'medium' || pathwayEffort === 'xhigh') {
                thinkingLevel = 'high';
            } else {
                thinkingLevel = 'low';
            }
        }
        
        if (includeThoughts === false && cortexRequest?.pathway?.includeThoughts !== undefined) {
            includeThoughts = cortexRequest.pathway.includeThoughts;
        } else if (includeThoughts === false && cortexRequest?.pathway?.include_thoughts !== undefined) {
            includeThoughts = cortexRequest.pathway.include_thoughts;
        }

        // Set up thinkingConfig in generationConfig if thinking is enabled
        if (thinkingLevel !== undefined || includeThoughts) {
            if (!baseParameters.generationConfig.thinkingConfig) {
                baseParameters.generationConfig.thinkingConfig = {};
            }
            
            // Gemini 3 uses thinkingLevel: 'low' or 'high'
            if (thinkingLevel !== undefined) {
                const level = typeof thinkingLevel === 'string' ? thinkingLevel.toLowerCase() : String(thinkingLevel).toLowerCase();
                // Validate and set thinkingLevel (only 'low' or 'high' are valid)
                if (level === 'low' || level === 'high') {
                    baseParameters.generationConfig.thinkingConfig.thinkingLevel = level;
                } else {
                    // Default to 'low' if invalid value
                    baseParameters.generationConfig.thinkingConfig.thinkingLevel = 'low';
                }
            }
            
            // includeThoughts: true to get thought summaries
            if (includeThoughts !== undefined) {
                baseParameters.generationConfig.thinkingConfig.includeThoughts = Boolean(includeThoughts);
            }
        }

        return baseParameters;
    }

    // Override parseResponse to handle thought summaries
    parseResponse(data) {
        // First, let the parent handle the response
        const baseResponse = super.parseResponse(data);
        
        // Check if we have thought summaries in the response
        if (data?.candidates?.[0]?.content?.parts) {
            const parts = data.candidates[0].content.parts;
            let thoughtSummaries = [];
            let hasThoughts = false;

            // Extract thought summaries from parts
            for (const part of parts) {
                if (part.thought && part.text) {
                    // This is a thought summary
                    thoughtSummaries.push(part.text);
                    hasThoughts = true;
                }
            }

            // If we have thought summaries, add them to the response
            if (hasThoughts) {
                // If baseResponse is already a CortexResponse, add thoughts to it
                if (baseResponse && typeof baseResponse === 'object' && baseResponse.constructor && baseResponse.constructor.name === 'CortexResponse') {
                    baseResponse.thoughts = thoughtSummaries;
                    return baseResponse;
                } else {
                    // Create new CortexResponse with thoughts
                    // Preserve the baseResponse text if it's a string
                    const outputText = typeof baseResponse === 'string' ? baseResponse : '';
                    return new CortexResponse({
                        output_text: outputText,
                        thoughts: thoughtSummaries,
                        finishReason: data?.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : 'length',
                        usage: data?.usageMetadata || null,
                        metadata: { model: this.modelName }
                    });
                }
            }
        }

        return baseResponse;
    }

    // Override processStreamEvent to handle thought summaries in streaming
    processStreamEvent(event, requestProgress) {
        const baseProgress = super.processStreamEvent(event, requestProgress);
        
        const eventData = JSON.parse(event.data);
        
        // Initialize thought summaries array if needed
        if (!requestProgress.thoughts) {
            requestProgress.thoughts = [];
        }
        
        // Handle thought summaries in streaming
        if (eventData.candidates?.[0]?.content?.parts) {
            const parts = eventData.candidates[0].content.parts;
            
            for (const part of parts) {
                if (part.thought && part.text) {
                    // This is a thought summary chunk
                    // Accumulate thought summaries
                    if (!requestProgress.thoughts.includes(part.text)) {
                        requestProgress.thoughts.push(part.text);
                    }
                    
                    // Optionally, you could emit thought chunks separately
                    // For now, we'll accumulate them and they'll be available in the final response
                }
            }
        }

        return baseProgress;
    }

    // Override logRequestData to include thought information
    logRequestData(data, responseData, prompt) {
        // Check if responseData is a CortexResponse object with thoughts
        if (responseData && typeof responseData === 'object' && responseData.constructor && responseData.constructor.name === 'CortexResponse') {
            const { length, units } = this.getLength(responseData.output_text || '');
            logger.info(`[response received containing ${length} ${units}]`);
            
            if (responseData.thoughts && responseData.thoughts.length > 0) {
                logger.info(`[response contains ${responseData.thoughts.length} thought summary(ies)]`);
                responseData.thoughts.forEach((thought, index) => {
                    logger.verbose(`[thought ${index + 1}]: ${this.shortenContent(thought)}`);
                });
            }
            
            if (responseData.artifacts && responseData.artifacts.length > 0) {
                logger.info(`[response contains ${responseData.artifacts.length} image artifact(s)]`);
            }
            
            logger.verbose(`${this.shortenContent(responseData.output_text || '')}`);
            return;
        }

        // Fall back to parent implementation for non-CortexResponse objects
        super.logRequestData(data, responseData, prompt);
    }

}

export default Gemini3ReasoningVisionPlugin;

