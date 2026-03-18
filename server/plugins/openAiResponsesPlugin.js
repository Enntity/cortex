// openAiResponsesPlugin.js
// Plugin for OpenAI's Responses API (required for GPT-5.4+ which only supports Responses API)
// Extends GrokResponsesPlugin since both use the Responses API format
// Key differences: tools format, instructions field, annotations handling,
// content type normalization (text → input_text), and chat completion param removal

import GrokResponsesPlugin from './grokResponsesPlugin.js';
import logger from '../../lib/logger.js';
import CortexResponse from '../../lib/cortexResponse.js';
import { requestState } from '../requestState.js';

class OpenAIResponsesPlugin extends GrokResponsesPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Override: Log OpenAI Responses API-specific messages
    logRequestData(data, responseData, prompt) {
        const { stream, input, tools, instructions } = data;

        if (input && Array.isArray(input) && input.length > 1) {
            logger.info(`[openai responses request sent containing ${input.length} messages]`);
            let totalLength = 0;
            let totalUnits;
            input.forEach((message, index) => {
                let content;
                if (typeof message === 'string') {
                    content = message;
                } else if (message.content === undefined) {
                    content = JSON.stringify(message);
                } else if (Array.isArray(message.content)) {
                    content = message.content
                        .map((item) => typeof item === 'string' ? item : JSON.stringify(item))
                        .join(', ');
                } else {
                    content = message.content;
                }
                const { length, units } = this.getLength(content);
                const displayContent = this.shortenContent(content);
                logger.verbose(`message ${index + 1}: role: ${message.role || 'user'}, ${units}: ${length}, content: "${displayContent}"`);
                totalLength += length;
                totalUnits = units;
            });
            logger.info(`[openai responses request contained ${totalLength} ${totalUnits}]`);
        } else if (input && (Array.isArray(input) ? input.length === 1 : true)) {
            const message = Array.isArray(input) ? input[0] : input;
            let content;
            if (typeof message === 'string') {
                content = message;
            } else if (Array.isArray(message.content)) {
                content = message.content
                    .map((item) => typeof item === 'string' ? item : JSON.stringify(item))
                    .join(', ');
            } else {
                content = message.content || message;
            }
            const { length, units } = this.getLength(content);
            logger.info(`[openai responses request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }

        if (instructions) {
            logger.info(`[openai responses request has instructions: ${this.shortenContent(instructions)}]`);
        }

        if (tools && Array.isArray(tools) && tools.length > 0) {
            const toolNames = tools.map((t) => t.type || t.function?.name || 'unknown').join(', ');
            logger.info(`[openai responses request has tools: ${toolNames}]`);
        }

        if (stream) {
            logger.info(`[openai responses response received as an SSE stream]`);
        } else {
            const parsedResponse = this.parseResponse(responseData);
            if (typeof parsedResponse === 'string') {
                const { length, units } = this.getLength(parsedResponse);
                logger.info(`[openai responses response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(parsedResponse)}`);
            } else {
                logger.info(`[openai responses response received containing object]`);
                logger.verbose(`${JSON.stringify(parsedResponse)}`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }

    // Convert a single tool from chat completions format to Responses API format
    // Chat completions: {type: "function", function: {name, description, parameters}}
    // Responses API:    {type: "function", name, description, parameters}
    convertToolToResponsesFormat(tool) {
        if (!tool || typeof tool !== 'object') return tool;

        // Already in Responses API format (has name at top level) or non-function tool
        if (tool.type !== 'function' || !tool.function) return tool;

        // Flatten: pull function properties up to top level
        const { function: fn, ...rest } = tool;
        return { ...rest, ...fn };
    }

    // Override: Convert tools to OpenAI Responses API format
    // Input can be chat completions format or already Responses format
    validateAndTransformTools(tools) {
        if (Array.isArray(tools)) {
            return tools.map((tool) => this.convertToolToResponsesFormat(tool));
        }

        // Convert object format to array format
        const toolsArray = [];

        if (tools.functions) {
            const functions = Array.isArray(tools.functions) ? tools.functions : [tools.functions];
            functions.forEach((fn) => {
                toolsArray.push({ type: 'function', ...fn });
            });
        }

        if (tools.code_interpreter !== undefined) {
            const config = tools.code_interpreter === true ? {} : tools.code_interpreter || {};
            toolsArray.push({ type: 'code_interpreter', ...config });
        }

        if (tools.file_search !== undefined) {
            const config = tools.file_search === true ? {} : tools.file_search || {};
            toolsArray.push({ type: 'file_search', ...config });
        }

        if (tools.web_search_preview !== undefined) {
            const config = tools.web_search_preview === true ? {} : tools.web_search_preview || {};
            toolsArray.push({ type: 'web_search_preview', ...config });
        }

        return toolsArray;
    }

    // Override: Handle OpenAI-specific params
    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = await super.getRequestParameters(text, parameters, prompt);

        if (parameters.instructions) {
            requestParameters.instructions = parameters.instructions;
        }

        if (parameters.previous_response_id) {
            requestParameters.previous_response_id = parameters.previous_response_id;
        }

        // Responses API uses max_output_tokens instead of max_tokens
        if (parameters.max_output_tokens) {
            requestParameters.max_output_tokens = parameters.max_output_tokens;
            delete requestParameters.max_tokens;
        } else if (requestParameters.max_tokens) {
            requestParameters.max_output_tokens = requestParameters.max_tokens;
            delete requestParameters.max_tokens;
        }

        if (parameters.reasoning) {
            requestParameters.reasoning = parameters.reasoning;
        }

        if (parameters.truncation) {
            requestParameters.truncation = parameters.truncation;
        }

        // Not used by OpenAI Responses API
        delete requestParameters.inline_citations;

        // Override tools handling for OpenAI format
        if (parameters.tools) {
            try {
                const directTools = typeof parameters.tools === 'string'
                    ? JSON.parse(parameters.tools)
                    : parameters.tools;
                requestParameters.tools = this.validateAndTransformTools(directTools);
            } catch (error) {
                logger.warn(`Invalid tools parameter, ignoring: ${error.message}`);
            }
        }

        // Preserve raw Responses API input payload for passthrough fidelity
        if (typeof parameters.responses_input_json === 'string' && parameters.responses_input_json.trim() !== '') {
            try {
                requestParameters.input = JSON.parse(parameters.responses_input_json);
                delete requestParameters.messages;
            } catch (error) {
                logger.warn(`Invalid responses_input_json parameter, falling back to messages conversion: ${error.message}`);
            }
        }

        return requestParameters;
    }

    // Convert chat completions messages to Responses API input items.
    // Key differences:
    //   - Content type: user/system use input_text, assistant uses output_text
    //   - Tool calls: assistant tool_calls[] → separate function_call items
    //   - Tool results: role:tool → function_call_output items
    normalizeResponsesApiInput(messages) {
        if (!Array.isArray(messages)) return messages;

        const input = [];

        for (const message of messages) {
            if (!message || typeof message !== 'object') {
                input.push(message);
                continue;
            }

            const { role, content, tool_calls, tool_call_id } = message;

            // Tool result messages → function_call_output
            if (role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: tool_call_id || '',
                    output: typeof content === 'string' ? content
                        : Array.isArray(content) ? content.map((c) => c.text || JSON.stringify(c)).join('')
                        : JSON.stringify(content || ''),
                });
                continue;
            }

            // Normalize content blocks
            const isAssistant = role === 'assistant';
            let normalizedContent = content;
            if (Array.isArray(content)) {
                normalizedContent = content.map((item) => {
                    if (!item || typeof item !== 'object') return item;
                    if (item.type === 'text') {
                        return { ...item, type: isAssistant ? 'output_text' : 'input_text' };
                    }
                    if (item.type === 'image_url') {
                        const url = item.image_url?.url || item.url;
                        return url ? { type: 'input_image', image_url: url } : null;
                    }
                    return item;
                });
            }

            // Assistant messages with tool_calls need special handling:
            // emit the message (text part), then each tool call as a function_call item
            if (isAssistant && tool_calls && tool_calls.length > 0) {
                // Emit text content as a message if present
                if (normalizedContent) {
                    input.push({ role, content: normalizedContent });
                }
                // Emit each tool call as a separate function_call item
                for (const tc of tool_calls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id || '',
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '{}',
                    });
                }
                continue;
            }

            // Regular message — pass through with normalized content
            const normalized = { ...message, content: normalizedContent };
            delete normalized.tool_calls;
            delete normalized.tool_call_id;
            input.push(normalized);
        }

        return input;
    }

    // Override: Parse OpenAI Responses API format
    parseResponsesApiFormat(data) {
        // Note: data.text is a config object in Responses API (e.g. {format:{type:"text"}}),
        // NOT the output text. Only use it as fallback if it's actually a string.
        let outputText = data.output_text || (typeof data.text === 'string' ? data.text : '') || '';

        if (data.output && Array.isArray(data.output)) {
            const textItems = data.output
                .filter((item) => item && (item.type === 'message' || item.content))
                .map((item) => {
                    if (item.type === 'message' && item.content && Array.isArray(item.content)) {
                        return item.content
                            .filter((c) => c.type === 'output_text' || c.type === 'text')
                            .map((c) => c.text)
                            .join('');
                    }
                    return '';
                });

            if (textItems.length > 0) {
                outputText = textItems.join('');
            }
        }

        const cortexResponse = new CortexResponse({
            output_text: outputText,
            finishReason: data.status || 'completed',
            usage: data.usage || null,
            metadata: { model: this.modelName, id: data.id },
        });

        // Handle function call outputs
        if (data.output && Array.isArray(data.output)) {
            const functionCalls = data.output
                .filter((item) => item && item.type === 'function_call')
                .map((item) => ({
                    id: item.call_id || item.id,
                    type: 'function',
                    function: {
                        name: item.name,
                        arguments: typeof item.arguments === 'string'
                            ? item.arguments
                            : JSON.stringify(item.arguments || {}),
                    },
                }));

            if (functionCalls.length > 0) {
                cortexResponse.toolCalls = functionCalls;
            }
        }

        // Handle annotations (url_citation, file_citation, file_path)
        let annotations = [];
        if (data.output && Array.isArray(data.output)) {
            data.output.forEach((item) => {
                if (item.type === 'message' && item.content && Array.isArray(item.content)) {
                    item.content.forEach((contentBlock) => {
                        if (contentBlock.annotations && Array.isArray(contentBlock.annotations)) {
                            contentBlock.annotations.forEach((annotation) => {
                                if (annotation.type === 'url_citation') {
                                    annotations.push({
                                        type: 'url_citation',
                                        url: annotation.url,
                                        title: annotation.title || this.extractTitleFromUrl(annotation.url),
                                        start_index: annotation.start_index,
                                        end_index: annotation.end_index,
                                    });
                                } else if (annotation.type === 'file_citation') {
                                    annotations.push({
                                        type: 'file_citation',
                                        file_id: annotation.file_id,
                                        quote: annotation.quote,
                                        start_index: annotation.start_index,
                                        end_index: annotation.end_index,
                                    });
                                } else if (annotation.type === 'file_path') {
                                    annotations.push({
                                        type: 'file_path',
                                        file_id: annotation.file_id,
                                        start_index: annotation.start_index,
                                        end_index: annotation.end_index,
                                    });
                                }
                            });
                        }
                    });
                }
            });
        }

        if (annotations.length > 0) {
            const urlCitations = annotations.filter((a) => a.type === 'url_citation');
            if (urlCitations.length > 0) {
                cortexResponse.citations = urlCitations.map((a) => ({
                    title: a.title,
                    url: a.url,
                    content: a.title,
                }));
            }
            cortexResponse.metadata.annotations = annotations;
        }

        // Handle reasoning/thinking output
        if (data.output && Array.isArray(data.output)) {
            const reasoningItems = data.output
                .filter((item) => item && item.type === 'reasoning')
                .map((item) => item.summary || item.content || '');

            if (reasoningItems.length > 0) {
                cortexResponse.metadata.reasoning = reasoningItems.join('\n');
            }
        }

        return cortexResponse;
    }

    extractTitleFromUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname.replace(/^www\./, '');
        } catch (e) {
            return url;
        }
    }

    // Convert a text delta to chat completions streaming format so the rest of the
    // system (pathwayResolver streamedContent accumulation + frontend) can understand it.
    toChatCompletionsDelta(textDelta) {
        return JSON.stringify({
            choices: [{ delta: { content: textDelta } }],
        });
    }

    // OpenAI Responses streaming emits response.* lifecycle events.
    // We translate them to chat completions format for downstream compatibility:
    //   - Text deltas → choices[0].delta.content
    //   - Function calls → accumulated in toolCallsBuffer, callback triggered on completion
    //   - Lifecycle events (created, content_part.added, etc.) → silently skipped
    processStreamEvent(event, requestProgress) {
        if (event.data.trim() === '[DONE]') {
            return super.processStreamEvent(event, requestProgress);
        }

        let parsedMessage;
        try {
            parsedMessage = JSON.parse(event.data);
        } catch (_error) {
            return super.processStreamEvent(event, requestProgress);
        }

        const type = parsedMessage?.type;
        const delta = parsedMessage?.delta;

        // ── Text content delta ──
        if (type === 'response.output_text.delta' || type === 'content_block_delta') {
            const textDelta = typeof delta === 'string'
                ? delta
                : delta?.text || parsedMessage?.text || '';
            if (textDelta) {
                this.contentBuffer += textDelta;
                requestProgress.data = this.toChatCompletionsDelta(textDelta);
            }
            return requestProgress;
        }

        // ── Function call: new call announced ──
        if (type === 'response.output_item.added' && parsedMessage.item?.type === 'function_call') {
            const item = parsedMessage.item;
            const index = this.toolCallsBuffer.length;
            this.toolCallsBuffer[index] = {
                id: item.call_id || item.id || '',
                type: 'function',
                function: {
                    name: item.name || '',
                    arguments: item.arguments || '',
                },
            };
            // Map upstream output_index → local buffer index for argument deltas
            this._responsesToolIndexMap = this._responsesToolIndexMap || new Map();
            this._responsesToolIndexMap.set(parsedMessage.output_index, index);
            return requestProgress;
        }

        // ── Function call: argument chunk ──
        if (type === 'response.function_call_arguments.delta') {
            const index = this._responsesToolIndexMap?.get(parsedMessage.output_index) ?? 0;
            if (this.toolCallsBuffer[index]) {
                this.toolCallsBuffer[index].function.arguments += (parsedMessage.delta || '');
            }
            return requestProgress;
        }

        // ── Function call: arguments complete ──
        if (type === 'response.function_call_arguments.done') {
            const index = this._responsesToolIndexMap?.get(parsedMessage.output_index) ?? 0;
            if (this.toolCallsBuffer[index] && parsedMessage.arguments) {
                this.toolCallsBuffer[index].function.arguments = parsedMessage.arguments;
            }
            return requestProgress;
        }

        // ── Function call: item done ──
        if (type === 'response.output_item.done' && parsedMessage.item?.type === 'function_call') {
            // Final state already accumulated above; nothing extra needed
            return requestProgress;
        }

        // ── Stream completion ──
        if (type === 'response.completed' || type === 'response.done' ||
            type === 'response.failed' || type === 'response.cancelled') {

            // If we accumulated tool calls, trigger the tool callback (same as
            // the chat-completions finish_reason:'tool_calls' path in the parent).
            if (this.toolCallsBuffer.length > 0) {
                const pathwayResolver = requestState[this.requestId]?.pathwayResolver;
                if (this.pathwayToolCallback && pathwayResolver) {
                    const validToolCalls = this.toolCallsBuffer.filter(
                        (tc) => tc && tc.function && tc.function.name,
                    );
                    if (validToolCalls.length > 0) {
                        const toolMessage = {
                            role: 'assistant',
                            content: this.contentBuffer || '',
                            tool_calls: validToolCalls,
                        };
                        pathwayResolver._streamingToolCallbackPromise =
                            this.pathwayToolCallback(pathwayResolver?.args, toolMessage, pathwayResolver);
                        requestProgress.toolCallbackInvoked = true;
                    }
                }
            }

            // Also catch any function calls from the final response.done payload
            // that we might not have seen via individual streaming events.
            const finalResponse = parsedMessage.response || parsedMessage;
            if (Array.isArray(finalResponse.output) && !requestProgress.toolCallbackInvoked) {
                const functionCalls = finalResponse.output
                    .filter((item) => item?.type === 'function_call' && item.name)
                    .map((item) => ({
                        id: item.call_id || item.id || '',
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: typeof item.arguments === 'string'
                                ? item.arguments
                                : JSON.stringify(item.arguments || {}),
                        },
                    }));
                if (functionCalls.length > 0) {
                    const pathwayResolver = requestState[this.requestId]?.pathwayResolver;
                    if (this.pathwayToolCallback && pathwayResolver) {
                        const toolMessage = {
                            role: 'assistant',
                            content: this.contentBuffer || '',
                            tool_calls: functionCalls,
                        };
                        pathwayResolver._streamingToolCallbackPromise =
                            this.pathwayToolCallback(pathwayResolver?.args, toolMessage, pathwayResolver);
                        requestProgress.toolCallbackInvoked = true;
                    }
                }
            }

            if (!requestProgress.toolCallbackInvoked) {
                requestProgress.progress = 1;
            }
            this.toolCallsBuffer = [];
            this._responsesToolIndexMap = null;
            this.contentBuffer = '';
            this.citationsBuffer = [];
            this.inlineCitationsBuffer = [];
            return requestProgress;
        }

        // Skip other response.* lifecycle events (response.created, response.content_part.added, etc.)
        if (typeof type === 'string' && type.startsWith('response.')) {
            return requestProgress;
        }

        return super.processStreamEvent(event, requestProgress);
    }

    // Override execute to handle OpenAI Responses API specifics
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = await this.getRequestParameters(text, parameters, prompt);
        const { stream } = parameters;

        const normalizeReasoningEffort = (value) => {
            if (value === undefined || value === null) return null;
            const effort = (typeof value === 'string' ? value : String(value)).trim().toLowerCase();
            return effort || null;
        };

        // Build reasoning object from various input formats
        if (typeof requestParameters.reasoning === 'string') {
            const rawReasoning = requestParameters.reasoning.trim();
            if (rawReasoning) {
                try {
                    requestParameters.reasoning = JSON.parse(rawReasoning);
                } catch (_error) {
                    const normalizedEffort = normalizeReasoningEffort(rawReasoning);
                    if (normalizedEffort) {
                        requestParameters.reasoning = { effort: normalizedEffort };
                    } else {
                        delete requestParameters.reasoning;
                    }
                }
            } else {
                delete requestParameters.reasoning;
            }
        }

        const hasReasoningObject = requestParameters.reasoning &&
            typeof requestParameters.reasoning === 'object' &&
            !Array.isArray(requestParameters.reasoning);

        if (!hasReasoningObject) {
            const normalizedEffort = normalizeReasoningEffort(
                requestParameters.reasoningEffort ??
                requestParameters.reasoning_effort ??
                parameters.reasoningEffort ??
                parameters.reasoning_effort
            );

            if (normalizedEffort) {
                requestParameters.reasoning = { effort: normalizedEffort };
            }
        } else if (typeof requestParameters.reasoning.effort === 'string') {
            requestParameters.reasoning = {
                ...requestParameters.reasoning,
                effort: requestParameters.reasoning.effort.trim().toLowerCase(),
            };
        }

        delete requestParameters.reasoningEffort;
        delete requestParameters.reasoning_effort;

        // Responses API requires model in the request body.
        // Always use the endpoint-configured model name (the actual API model ID),
        // not parameters.model which may be the internal cortex model key (e.g. "oai-gpt54").
        requestParameters.model =
            this.model.endpoints?.[0]?.params?.model ||
            this.model.params?.model ||
            this.model.emulateOpenAIChatModel ||
            requestParameters.model;

        // Convert messages to input format for Responses API
        if (requestParameters.messages) {
            requestParameters.input = this.normalizeResponsesApiInput(requestParameters.messages);
            delete requestParameters.messages;
        }

        // Ensure all tools are in Responses API format (flattened, not nested)
        // Tools may have come through the parent chain in chat completions format
        if (requestParameters.tools && Array.isArray(requestParameters.tools)) {
            requestParameters.tools = requestParameters.tools.map(
                (tool) => this.convertToolToResponsesFormat(tool)
            );
        }

        // Convert response_format → text.format for Responses API
        // Chat Completions: { response_format: { type: "json_object" } }
        // Responses API:    { text: { format: { type: "json_object" } } }
        if (requestParameters.response_format) {
            requestParameters.text = { format: requestParameters.response_format };
            delete requestParameters.response_format;
        }

        // Convert tool_choice: Responses API supports it but specific-function
        // format is flattened: {type:"function", function:{name:"x"}} → {type:"function", name:"x"}
        if (requestParameters.tool_choice &&
            typeof requestParameters.tool_choice === 'object' &&
            requestParameters.tool_choice.function) {
            const { function: fn, ...rest } = requestParameters.tool_choice;
            requestParameters.tool_choice = { ...rest, ...fn };
        }

        // Remove chat completion params not supported by Responses API
        delete requestParameters.frequency_penalty;
        delete requestParameters.presence_penalty;
        delete requestParameters.logit_bias;
        delete requestParameters.logprobs;
        delete requestParameters.top_logprobs;
        delete requestParameters.n;
        delete requestParameters.stop;
        delete requestParameters.temperature;
        delete requestParameters.top_p;
        delete requestParameters.functions;
        delete requestParameters.function_call;

        cortexRequest.data = {
            ...(cortexRequest.data || {}),
            ...requestParameters,
        };
        cortexRequest.params = {};
        cortexRequest.stream = stream;

        return this.executeRequest(cortexRequest);
    }
}

export default OpenAIResponsesPlugin;
