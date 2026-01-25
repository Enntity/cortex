// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const MAX_TOOL_CALLS = 50;
const TOOL_TIMEOUT_MS = 120000; // 2 minute timeout per tool call
const MAX_TOOL_RESULT_LENGTH = 150000; // Truncate oversized tool results to prevent context overflow
const CONTEXT_COMPRESSION_THRESHOLD = 0.7; // Compress when context reaches 70% of model limit
const DEFAULT_MODEL_CONTEXT_LIMIT = 128000; // Default context limit if not available from model

import { callPathway, callTool, say, sendToolStart, sendToolFinish, withTimeout } from '../../../lib/pathwayTools.js';
import { encode } from '../../../lib/encodeCache.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { syncAndStripFilesFromChatHistory } from '../../../lib/fileUtils.js';
import { Prompt } from '../../../server/prompt.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import CortexResponse from '../../../lib/cortexResponse.js';
import { getContinuityMemoryService } from '../../../lib/continuity/index.js';

// Helper function to generate a smart error response using the agent
async function generateErrorResponse(error, args, pathwayResolver) {
    const errorMessage = error?.message || error?.toString() || String(error);
    
    // Clear any accumulated errors since we're handling them intelligently
    pathwayResolver.errors = [];
    
    // Use sys_generator_error to create a smart response
    try {
        const errorResponse = await callPathway('sys_generator_error', {
            ...args,
            text: errorMessage,
            chatHistory: args.chatHistory || [],
            stream: false
        }, pathwayResolver);
        
        return errorResponse;
    } catch (errorResponseError) {
        // Fallback if sys_generator_error itself fails
        logger.error(`Error generating error response: ${errorResponseError.message}`);
        return `I apologize, but I encountered an error while processing your request: ${errorMessage}. Please try again or contact support if the issue persists.`;
    }
}

// Helper function to insert a system message, removing any existing ones first
function insertSystemMessage(messages, text, requestId = null) {
    // Create a unique marker to avoid collisions with legitimate content
    const marker = requestId ? `[system message: ${requestId}]` : '[system message]';
    
    // Remove any existing challenge messages with this specific requestId to avoid spamming the model
    const filteredMessages = messages.filter(msg => {
        if (msg.role !== 'user') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return !content.startsWith(marker);
    });
    
    // Insert the new system message
    filteredMessages.push({
        role: "user",
        content: `${marker} ${text}`
    });
    
    return filteredMessages;
}

// Estimate token count for messages (rough approximation using tiktoken)
function estimateTokens(messages) {
    if (!messages || !Array.isArray(messages)) return 0;
    
    let totalTokens = 0;
    for (const msg of messages) {
        // Add overhead for message structure
        totalTokens += 4;
        
        if (typeof msg.content === 'string') {
            totalTokens += encode(msg.content).length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (typeof part === 'string') {
                    totalTokens += encode(part).length;
                } else if (part?.text) {
                    totalTokens += encode(part.text).length;
                } else if (part?.type === 'image_url') {
                    totalTokens += 85; // Image token overhead
                }
            }
        }
        
        // Tool calls add significant tokens
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                totalTokens += 10; // Tool call overhead
                if (tc.function?.name) totalTokens += encode(tc.function.name).length;
                if (tc.function?.arguments) totalTokens += encode(tc.function.arguments).length;
            }
        }
    }
    
    return totalTokens;
}

// Find a safe split point that doesn't orphan tool results from their tool calls
// Returns the index where we can safely split: messages before this can be summarized
function findSafeSplitPoint(messages, keepRecentCount = 6) {
    // Build map of tool_call_id -> index of message containing that tool_call
    const toolCallIndexMap = new Map();
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                if (tc.id) toolCallIndexMap.set(tc.id, i);
            }
        }
    }
    
    // Start with keeping the last N messages
    let splitIndex = Math.max(0, messages.length - keepRecentCount);
    
    // Move split point back if any tool result in "to keep" references a tool call in "to summarize"
    let adjusted = true;
    while (adjusted && splitIndex > 0) {
        adjusted = false;
        for (let i = splitIndex; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'tool' && msg.tool_call_id) {
                const callIndex = toolCallIndexMap.get(msg.tool_call_id);
                if (callIndex !== undefined && callIndex < splitIndex) {
                    // This tool result's call is in the "to summarize" section
                    // Move split point back to include the call in "to keep"
                    splitIndex = callIndex;
                    adjusted = true;
                    break;
                }
            }
        }
    }
    
    return splitIndex;
}

// Format messages for compression prompt
function formatMessagesForCompression(messages) {
    let text = '';
    
    for (const msg of messages) {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Format tool calls
            const toolsText = msg.tool_calls.map(tc => {
                const name = tc.function?.name || 'unknown';
                let args = tc.function?.arguments || '{}';
                try {
                    const parsed = JSON.parse(args);
                    const userMsg = parsed.userMessage || parsed.q || '';
                    args = userMsg ? `Goal: ${userMsg}` : JSON.stringify(parsed, null, 2);
                } catch { /* keep as is */ }
                return `Tool: ${name}\n${args}`;
            }).join('\n\n');
            text += `[Tool Calls]:\n${toolsText}\n\n`;
        } else if (msg.role === 'tool') {
            // Format tool results
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            text += `[Tool Result - ${msg.name || 'unknown'}]:\n${content}\n\n`;
        } else if (msg.role === 'user') {
            // Include user messages for context
            const content = typeof msg.content === 'string' ? msg.content : 
                (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';
            if (content && !content.startsWith('[system message')) {
                text += `[User]: ${content}\n\n`;
            }
        }
    }
    
    return text;
}

// Compress chat history when approaching context limits
async function compressContextIfNeeded(messages, pathwayResolver, args) {
    // Get model context limit
    let maxTokens = DEFAULT_MODEL_CONTEXT_LIMIT;
    if (pathwayResolver.modelExecutor?.plugin?.getModelMaxPromptTokens) {
        try {
            maxTokens = pathwayResolver.modelExecutor.plugin.getModelMaxPromptTokens();
        } catch { /* use default */ }
    }
    
    const currentTokens = estimateTokens(messages);
    const threshold = maxTokens * CONTEXT_COMPRESSION_THRESHOLD;
    
    if (currentTokens <= threshold) {
        return messages; // No compression needed
    }
    
    logger.info(`Context compression triggered: ${currentTokens} tokens (${((currentTokens/maxTokens)*100).toFixed(0)}% of ${maxTokens} limit)`);
    
    // Separate system messages (always keep)
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    
    // Find safe split point
    const splitIndex = findSafeSplitPoint(nonSystemMessages);
    
    if (splitIndex < 3) {
        logger.debug('Not enough messages to compress');
        return messages; // Not enough to compress
    }
    
    const toCompress = nonSystemMessages.slice(0, splitIndex);
    const toKeep = nonSystemMessages.slice(splitIndex);
    
    // Count tool-related messages to compress
    const toolMessages = toCompress.filter(m => m.tool_calls || m.role === 'tool');
    if (toolMessages.length < 2) {
        logger.debug('Not enough tool messages to compress');
        return messages; // Not enough tool data to warrant compression
    }
    
    // Extract original user query
    let originalQuery = null;
    for (const msg of toCompress) {
        if (msg.role === 'user') {
            const content = typeof msg.content === 'string' ? msg.content :
                (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';
            if (content && !content.startsWith('[system message') && !content.startsWith('[Context Summary')) {
                originalQuery = content;
                break;
            }
        }
    }
    
    // Send tool UI message
    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
    const compressId = `compress-${Date.now()}`;
    try {
        await sendToolStart(requestId, compressId, '🗜️', 'Compacting conversation context...', 'ContextCompression');
    } catch { /* continue even if UI message fails */ }
    
    try {
        // Format messages for compression
        const researchContent = formatMessagesForCompression(toCompress);
        
        // Call compression pathway
        const summary = await withTimeout(
            callPathway('sys_compress_context', {
                ...args,
                researchContent,
                stream: false
            }, pathwayResolver),
            60000,
            'Context compression timed out'
        );
        
        // Build summary message
        const toolCallCount = toCompress.filter(m => m.tool_calls).length;
        const toolResultCount = toCompress.filter(m => m.role === 'tool').length;
        const summaryText = typeof summary === 'string' ? summary : JSON.stringify(summary);
        const contextSummary = `[Context Summary: The following summarizes ${toolCallCount} tool calls and ${toolResultCount} results from earlier in this conversation. Key findings, URLs, and citations have been preserved.]\n\n${summaryText}`;
        
        // Validate toKeep doesn't have orphaned tool results
        const toolCallsInKeep = new Set();
        for (const msg of toKeep) {
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.id) toolCallsInKeep.add(tc.id);
                }
            }
        }
        
        const validatedToKeep = toKeep.filter(msg => {
            if (msg.role === 'tool' && msg.tool_call_id) {
                if (!toolCallsInKeep.has(msg.tool_call_id)) {
                    logger.warn(`Removing orphaned tool result ${msg.tool_call_id} during compression`);
                    return false;
                }
            }
            return true;
        });
        
        // Reconstruct history
        const compressed = [
            ...systemMessages,
            ...(originalQuery ? [{ role: 'user', content: originalQuery }] : []),
            { role: 'user', content: contextSummary },
            ...validatedToKeep
        ];
        
        const newTokens = estimateTokens(compressed);
        logger.info(`Context compressed: ${currentTokens} -> ${newTokens} tokens (${toolMessages.length} tool messages summarized)`);
        
        await sendToolFinish(requestId, compressId, true, null, 'ContextCompression');
        
        return compressed;
    } catch (error) {
        logger.error(`Context compression failed: ${error.message}`);
        await sendToolFinish(requestId, compressId, false, error.message, 'ContextCompression');
        return messages; // Return original on failure
    }
}

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    manageTokenLength: false, // Agentic models handle context management themselves
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        agentContext: [
            { contextId: ``, contextKey: ``, default: true }
        ],
        chatId: ``,
        language: "English",
        aiName: "Jarvis",
        title: ``,
        messages: [],
        voiceResponse: false,
        codeRequestId: ``,
        skipCallbackMessage: false,
        entityId: ``,
        researchMode: false,
        userInfo: '',
        model: 'oai-gpt41',
        useMemory: true  // Enable continuity memory (default true). False here OR in entity config disables memory.
    },
    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        if (!args || !message || !resolver) {
            return;
        }

        // Handle both CortexResponse objects and plain message objects
        let tool_calls;
        if (message instanceof CortexResponse) {
            tool_calls = [...(message.toolCalls || [])];
            if (message.functionCall) {
                tool_calls.push(message.functionCall);
            }
        } else {
            tool_calls = [...(message.tool_calls || [])];
        }
        
        const pathwayResolver = resolver;
        const { entityTools, entityToolsOpenAiFormat } = args;

        pathwayResolver.toolCallCount = (pathwayResolver.toolCallCount || 0);
        
        const preToolCallMessages = JSON.parse(JSON.stringify(args.chatHistory || []));
        let finalMessages = JSON.parse(JSON.stringify(preToolCallMessages));

        if (tool_calls && tool_calls.length > 0) {
            if (pathwayResolver.toolCallCount < MAX_TOOL_CALLS) {
                // Execute tool calls in parallel but with isolated message histories
                // Filter out any undefined or invalid tool calls
                const invalidToolCalls = tool_calls.filter(tc => !tc || !tc.function || !tc.function.name);
                if (invalidToolCalls.length > 0) {
                    logger.warn(`Found ${invalidToolCalls.length} invalid tool calls: ${JSON.stringify(invalidToolCalls, null, 2)}`);
                    // bail out if we're getting invalid tool calls
                    pathwayResolver.toolCallCount = MAX_TOOL_CALLS;
                }
                
                const validToolCalls = tool_calls.filter(tc => tc && tc.function && tc.function.name);
                
                const toolResults = await Promise.all(validToolCalls.map(async (toolCall) => {
                    // Get tool info for error handling even if early failure
                    const toolFunction = toolCall?.function?.name?.toLowerCase() || 'unknown';
                    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    const toolCallId = toolCall?.id;
                    
                    try {
                        if (!toolCall?.function?.arguments) {
                            throw new Error('Invalid tool call structure: missing function arguments');
                        }

                        const toolArgs = JSON.parse(toolCall.function.arguments);
                        
                        // Create an isolated copy of messages for this tool
                        const toolMessages = JSON.parse(JSON.stringify(preToolCallMessages));
                        
                        // Get the tool definition to check for icon and visibility
                        const toolDefinition = entityTools[toolFunction]?.definition;
                        const toolIcon = toolDefinition?.icon || '🛠️';
                        const hideExecution = toolDefinition?.hideExecution === true;
                        
                        // Get timeout from tool definition or use default
                        const toolTimeout = toolDefinition?.timeout || TOOL_TIMEOUT_MS;

                        // Get the user message for the tool - use natural voice-friendly fallbacks
                        const voiceFallbacks = {
                            'GoogleSearch': 'Let me look that up.',
                            'GoogleNews': 'Checking the news.',
                            'SearchX': 'Searching for that now.',
                            'GenerateImage': 'Creating that image for you.',
                            'EditImage': 'Working on that image.',
                            'AnalyzeFile': 'Taking a look at that.',
                            'AnalyzeImage': 'Looking at this image.',
                            'CallModel': 'Let me think about that.',
                            'DelegateCreative': 'Working on that for you.',
                            'Planner': 'Planning that out.',
                            'WebBrowser': 'Checking that page.',
                            'default': 'One moment.'
                        };
                        const toolName = toolCall.function.name;
                        const fallbackMessage = voiceFallbacks[toolName] || voiceFallbacks.default;
                        const toolUserMessage = toolArgs.userMessage || fallbackMessage;
                        
                        // Send tool start message (unless execution is hidden)
                        if (!hideExecution) {
                            try {
                                await sendToolStart(requestId, toolCallId, toolIcon, toolUserMessage, toolCall.function.name, toolArgs);
                            } catch (startError) {
                                logger.error(`Error sending tool start message: ${startError.message}`);
                                // Continue execution even if start message fails
                            }
                        }

                        // Wrap tool call with timeout to prevent hanging
                        const toolResult = await withTimeout(
                            callTool(toolFunction, {
                                ...args,
                                ...toolArgs,
                                toolFunction,
                                chatHistory: toolMessages,
                                stream: false,
                                useMemory: false  // Disable memory synthesis for tool calls
                            }, entityTools, pathwayResolver),
                            toolTimeout,
                            `Tool ${toolCall.function.name} timed out after ${toolTimeout / 1000}s`
                        );

                        // Tool calls and results need to be paired together in the message history
                        // Add the tool call to the isolated message history
                        // Preserve thoughtSignature for Gemini 3+ models
                        const toolCallEntry = {
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: JSON.stringify(toolArgs)
                            }
                        };
                        if (toolCall.thoughtSignature) {
                            toolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        toolMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [toolCallEntry]
                        });

                        // Add the tool result to the isolated message history
                        // Extract the result - if it's already a string, use it directly; only stringify objects
                        let toolResultContent;
                        if (typeof toolResult === 'string') {
                            toolResultContent = toolResult;
                        } else if (typeof toolResult?.result === 'string') {
                            toolResultContent = toolResult.result;
                        } else if (toolResult?.result !== undefined) {
                            toolResultContent = JSON.stringify(toolResult.result);
                        } else {
                            toolResultContent = JSON.stringify(toolResult);
                        }

                        toolMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResultContent
                        });

                        // Add the screenshots/images using OpenAI image format
                        if (toolResult?.toolImages && toolResult.toolImages.length > 0) {
                            toolMessages.push({
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "The tool with id " + toolCall.id + " has also supplied you with these images."
                                    },
                                    ...toolResult.toolImages.map(toolImage => {
                                        // Handle both base64 strings (screenshots) and image_url objects (file collection images)
                                        if (typeof toolImage === 'string') {
                                            // Base64 string format (screenshots)
                                            return {
                                                type: "image_url",
                                                image_url: {
                                                    url: `data:image/png;base64,${toolImage}`
                                                }
                                            };
                                        } else if (typeof toolImage === 'object' && toolImage.image_url) {
                                            // Image URL object format (file collection images)
                                            return {
                                                type: "image_url",
                                                url: toolImage.url,
                                                gcs: toolImage.gcs,
                                                image_url: toolImage.image_url,
                                                originalFilename: toolImage.originalFilename
                                            };
                                        } else {
                                            // Fallback for any other format
                                            return {
                                                type: "image_url",
                                                image_url: {
                                                    url: toolImage.url || toolImage
                                                }
                                            };
                                        }
                                    })
                                ]
                            });
                        }

                        // Check for errors in tool result
                        // callTool returns { result: parsedResult, toolImages: [] }
                        // We need to check if result has an error field
                        let hasError = false;
                        let errorMessage = null;
                        
                        if (toolResult?.error !== undefined) {
                            // Direct error from callTool (e.g., tool returned null)
                            hasError = true;
                            errorMessage = typeof toolResult.error === 'string' ? toolResult.error : String(toolResult.error);
                        } else if (toolResult?.result) {
                            // Check if result is a string that might contain error JSON
                            if (typeof toolResult.result === 'string') {
                                try {
                                    const parsed = JSON.parse(toolResult.result);
                                    if (parsed.error !== undefined) {
                                        hasError = true;
                                        // Tools return { error: true, message: "..." } so we want the message field
                                        if (parsed.message) {
                                            errorMessage = parsed.message;
                                        } else if (typeof parsed.error === 'string') {
                                            errorMessage = parsed.error;
                                        } else {
                                            // error is true/boolean, so use a generic message
                                            errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                                        }
                                    }
                                } catch (e) {
                                    // Not JSON, ignore
                                }
                            } else if (typeof toolResult.result === 'object' && toolResult.result !== null) {
                                // Check if result object has error field
                                if (toolResult.result.error !== undefined) {
                                    hasError = true;
                                    // Tools return { error: true, message: "..." } so we want the message field
                                    // If message exists, use it; otherwise fall back to error field (if it's a string)
                                    if (toolResult.result.message) {
                                        errorMessage = toolResult.result.message;
                                    } else if (typeof toolResult.result.error === 'string') {
                                        errorMessage = toolResult.result.error;
                                    } else {
                                        // error is true/boolean, so use a generic message
                                        errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                                    }
                                }
                            }
                        }
                        
                        // Send tool finish message (unless execution is hidden)
                        if (!hideExecution) {
                            try {
                                await sendToolFinish(requestId, toolCallId, !hasError, errorMessage, toolCall.function.name);
                            } catch (finishError) {
                                logger.error(`Error sending tool finish message: ${finishError.message}`);
                                // Continue execution even if finish message fails
                            }
                        }

                        return { 
                            success: !hasError, 
                            result: toolResult,
                            error: errorMessage,
                            toolCall,
                            toolArgs,
                            toolFunction,
                            messages: toolMessages
                        };
                    } catch (error) {
                        // Detect if this is a timeout error for clearer logging
                        const isTimeout = error.message?.includes('timed out');
                        logger.error(`${isTimeout ? 'Timeout' : 'Error'} executing tool ${toolCall?.function?.name || 'unknown'}: ${error.message}`);
                        
                        // Send tool finish message (error) - unless execution is hidden
                        // requestId, toolCallId, and toolFunction are defined at the start of this block
                        const errorToolDefinition = entityTools[toolFunction]?.definition;
                        const hideExecution = errorToolDefinition?.hideExecution === true;
                        if (!hideExecution) {
                            try {
                                await sendToolFinish(requestId, toolCallId, false, error.message, toolCall?.function?.name || null);
                            } catch (finishError) {
                                logger.error(`Error sending tool finish message: ${finishError.message}`);
                                // Continue execution even if finish message fails
                            }
                        }
                        
                        // Create error message history
                        const errorMessages = JSON.parse(JSON.stringify(preToolCallMessages));
                        // Preserve thoughtSignature for Gemini 3+ models
                        const errorToolCallEntry = {
                            id: toolCall?.id,
                            type: "function",
                            function: {
                                name: toolCall?.function?.name || toolFunction,
                                arguments: typeof toolCall?.function?.arguments === 'string' 
                                    ? toolCall.function.arguments 
                                    : JSON.stringify(toolCall?.function?.arguments || {})
                            }
                        };
                        if (toolCall?.thoughtSignature) {
                            errorToolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        errorMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [errorToolCallEntry]
                        });
                        errorMessages.push({
                            role: "tool",
                            tool_call_id: toolCall?.id || toolCallId,
                            name: toolCall?.function?.name || toolFunction,
                            content: `Error: ${error.message}`
                        });

                        return { 
                            success: false, 
                            error: error.message,
                            toolCall,
                            toolArgs: toolCall?.function?.arguments ? 
                                (typeof toolCall.function.arguments === 'string' 
                                    ? JSON.parse(toolCall.function.arguments) 
                                    : toolCall.function.arguments) 
                                : {},
                            toolFunction,
                            messages: errorMessages
                        };
                    }
                }));

                // Merge all message histories in order
                for (const result of toolResults) {
                    try {
                        if (!result?.messages) {
                            logger.error('Invalid tool result structure, skipping message history update');
                            continue;
                        }

                        // Add only the new messages from this tool's history
                        const newMessages = result.messages.slice(preToolCallMessages.length);
                        finalMessages.push(...newMessages);
                    } catch (error) {
                        logger.error(`Error merging message history for tool result: ${error.message}`);
                    }
                }

                // Check if any tool calls failed
                const failedTools = toolResults.filter(result => result && !result.success);
                if (failedTools.length > 0) {
                    logger.warn(`Some tool calls failed: ${failedTools.map(t => t.error).join(', ')}`);
                }

                pathwayResolver.toolCallCount = (pathwayResolver.toolCallCount || 0) + toolResults.length;

                // Check if any of the executed tools are hand-off tools (async agents)
                // Hand-off tools don't return results immediately, so we skip the completion check
                const hasHandoffTool = toolResults.some(result => {
                    if (!result || !result.toolFunction) return false;
                    const toolDefinition = entityTools[result.toolFunction]?.definition;
                    return toolDefinition?.handoff === true;
                });

                // Inject challenge message after tools are executed to encourage task completion
                // Only inject in research mode for the first few iterations - after that, let the model decide
                // Skip this check if a hand-off tool was used (async agents handle their own completion)
                const RESEARCH_ENCOURAGEMENT_LIMIT = 3; // Stop pushing after this many tool call rounds
                if (!hasHandoffTool && args.researchMode && pathwayResolver.toolCallCount <= RESEARCH_ENCOURAGEMENT_LIMIT) {
                    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    finalMessages = insertSystemMessage(finalMessages, 
                        "Review the tool results above. If the information gathered is clearly insufficient for the task, call additional tools. If you have gathered reasonable information from multiple sources, proceed to respond to the user.",
                        requestId
                    );
                }

            } else {
                const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                finalMessages = insertSystemMessage(finalMessages,
                    "Maximum tool call limit reached - no more tool calls will be executed. Provide your response based on the information gathered so far.",
                    requestId
                );
            }

            // Truncate oversized individual tool results
            let processedMessages = finalMessages.map(msg => {
                if (msg.role === 'tool' && msg.content && msg.content.length > MAX_TOOL_RESULT_LENGTH) {
                    logger.warn(`Truncating oversized tool result (${msg.content.length} chars) for ${msg.name || 'unknown tool'}`);
                    return {
                        ...msg,
                        content: msg.content.substring(0, MAX_TOOL_RESULT_LENGTH) + '\n\n[Content truncated due to length]'
                    };
                }
                return msg;
            });

            // Compress context if approaching model limits
            try {
                processedMessages = await compressContextIfNeeded(processedMessages, pathwayResolver, args);
            } catch (compressionError) {
                logger.error(`Context compression error: ${compressionError.message}`);
                // Continue with uncompressed messages
            }
            
            args.chatHistory = processedMessages;

            // clear any accumulated pathwayResolver errors from the tools
            pathwayResolver.errors = [];

            // Add a line break to avoid running output together
            await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

            try {
                // Use configured reasoning effort for post-tool calls (synthesis/decisions)
                // Skip memory reload - it was already loaded on the first call
                const result = await pathwayResolver.promptAndParse({
                    ...args,
                    tools: entityToolsOpenAiFormat,
                    tool_choice: "auto",
                    reasoningEffort: args.configuredReasoningEffort || 'low',
                    skipMemoryLoad: true,  // Don't reload memory on intermediate tool calls (context already loaded)
                });
                
                // Check if promptAndParse returned null (model call failed)
                if (!result) {
                    const errorMessage = pathwayResolver.errors.length > 0 
                        ? pathwayResolver.errors.join(', ')
                        : 'Model request failed - no response received';
                    logger.error(`promptAndParse returned null during tool callback: ${errorMessage}`);
                    const errorResponse = await generateErrorResponse(new Error(errorMessage), args, pathwayResolver);
                    // Ensure errors are cleared before returning
                    pathwayResolver.errors = [];
                    return errorResponse;
                }
                
                return result;
            } catch (parseError) {
                // If promptAndParse fails, generate error response instead of re-throwing
                logger.error(`Error in promptAndParse during tool callback: ${parseError.message}`);
                const errorResponse = await generateErrorResponse(parseError, args, pathwayResolver);
                // Ensure errors are cleared before returning
                pathwayResolver.errors = [];
                return errorResponse;
            }
        }
    },
  
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // Load input parameters and information into args
        const { entityId, voiceResponse, chatId, researchMode } = { ...pathwayResolver.pathway.inputParameters, ...args };
        
        // Load entity config on-demand from MongoDB
        const entityConfig = await loadEntityConfig(entityId);
        const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);
        // Support both new field name (identity) and legacy (instructions)
        const entityName = entityConfig?.name;
        const entityInstructions = entityConfig?.identity || entityConfig?.instructions || '';
        
        // Determine useMemory: "False always wins"
        // Memory is only enabled if BOTH entity config AND input args allow it
        // Either can disable by setting to false; default is true for both
        const entityAllowsMemory = entityConfig?.useMemory !== false;
        const inputAllowsMemory = args.useMemory !== false;
        const useContinuityMemory = entityAllowsMemory && inputAllowsMemory;
        
        // Override model from entity config if defined (use modelOverride for dynamic model switching)
        const modelOverride = entityConfig?.modelOverride ?? args.modelOverride;

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

        // Support both new field name (resources) and legacy (files)
        const entityResources = entityConfig?.resources || entityConfig?.files || [];
        if(entityResources.length > 0) {
            //get last user message if not create one to add resources to
            let lastUserMessage = args.chatHistory.filter(message => message.role === "user").slice(-1)[0];
            if(!lastUserMessage) {
                lastUserMessage = {
                    role: "user",
                    content: []
                };
                args.chatHistory.push(lastUserMessage);
            }

            //if last user message content is not array then convert to array
            if(!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = lastUserMessage.content ? [lastUserMessage.content] : [];
            }

            //add resources to the last user message content
            lastUserMessage.content.push(...entityResources.map(resource => ({
                    type: "image_url",
                    gcs: resource?.gcs,
                    url: resource?.url,
                    image_url: { url: resource?.url },
                    originalFilename: resource?.name
                })
            ));
        }

        // Get userInfo from args if provided
        const userInfo = args.userInfo || '';

        args = {
            ...args,
            ...config.get('entityConstants'),
            entityId,
            entityTools,
            entityToolsOpenAiFormat,
            entityInstructions,
            voiceResponse,
            chatId,
            researchMode,
            userInfo
        };

        pathwayResolver.args = {...args};

        // Core of the entity's DNA - either continuity memory or entity instructions
        const entityDNA = useContinuityMemory 
            ? `{{renderTemplate AI_CONTINUITY_CONTEXT}}\n\n` 
            : (entityInstructions ? entityInstructions + '\n\n' : '');

        // Use plain text instructions for system onboarding entity (Vesper), markdown for others
        const commonInstructionsTemplate = entityConfig?.isSystem
            ? `{{renderTemplate AI_COMMON_INSTRUCTIONS_TEXT}}`
            : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}`;
        const instructionTemplates = `${commonInstructionsTemplate}\n\n${entityDNA}{{renderTemplate AI_EXPERTISE}}\n\n`;
        const searchRulesTemplate = researchMode ? `{{renderTemplate AI_SEARCH_RULES}}\n\n` : '';

        // Voice-specific instructions for natural spoken interaction
        const voiceInstructions = voiceResponse ? `
## Voice Response Guidelines
You are speaking to the user through voice. Follow these guidelines for natural conversation:

1. **Responses**: Keep responses concise and conversational - this is voice, not text. Use natural pacing and speak as you would in a real conversation.

2. **Tool userMessage**: When calling tools, your userMessage should be a brief, natural voice phrase that sounds like something you'd actually say while doing something:
   - GOOD: "Let me look that up", "One moment", "Searching now", "Let me check on that"
   - BAD: "Searching for information about X", "Executing search tool", "Looking up: query terms"
   The userMessage will be spoken aloud, so it must sound natural and human.

3. **Avoid**: Numbered lists, markdown formatting, URLs, or anything that doesn't translate well to speech. Read numbers naturally (e.g., "about fifteen hundred" not "1,500").

4. **Emotion**: Match the emotional tone to the content - be excited about good news, empathetic about problems, curious when exploring topics.
` : '';

        // Only include tool instructions if entity has tools available
        const toolsTemplate = entityToolsOpenAiFormat.length > 0 ? '{{renderTemplate AI_TOOLS}}\n\n' : '';

        const promptMessages = [
            {"role": "system", "content": `${instructionTemplates}${toolsTemplate}${searchRulesTemplate}${voiceInstructions}{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}",
        ];

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        // Determine reasoning effort: Priority: entityConfig > researchMode > default ('low')
        // Use 'high' reasoning effort in research mode for thorough analysis, 'low' in normal mode for faster responses
        let reasoningEffort = entityConfig?.reasoningEffort;
        if (!reasoningEffort) {
            reasoningEffort = researchMode ? 'high' : 'low';
        }
        if (entityConfig?.reasoningEffort) {
            logger.debug(`Using entity reasoningEffort: ${entityConfig.reasoningEffort}`);
        }

        // Limit the chat history to 20 messages to speed up processing
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }

        // Process files in chat history:
        // - Files in collection (all agentContext contexts): stripped, accessible via tools
        // - Files not in collection: left in message for model to see directly
        const { chatHistory: strippedHistory, availableFiles } = await syncAndStripFilesFromChatHistory(
            args.chatHistory, args.agentContext, chatId, entityId
        );
        args.chatHistory = strippedHistory;

        // Compress context if approaching model limits (initial check before first model call)
        try {
            args.chatHistory = await compressContextIfNeeded(args.chatHistory, pathwayResolver, args);
        } catch (compressionError) {
            logger.warn(`Initial context compression failed: ${compressionError.message}`);
        }
      
        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            // Store configured reasoning effort for use after tool calls
            // First call uses 'low' for fast tool selection, subsequent calls use configured value
            args.configuredReasoningEffort = reasoningEffort;

            let response = await runAllPrompts({
                ...args,
                modelOverride,
                chatHistory: currentMessages,
                availableFiles,
                reasoningEffort: 'low',  // Fast first call - just selecting tools
                tools: entityToolsOpenAiFormat,
                tool_choice: "auto"
            });

            // Handle null response (can happen when ModelExecutor catches an error)
            if (!response) {
                const errorDetails = pathwayResolver.errors.length > 0 
                    ? `: ${pathwayResolver.errors.join(', ')}` 
                    : '';
                throw new Error(`Model execution returned null - the model request likely failed${errorDetails}`);
            }

            let toolCallback = pathwayResolver.pathway.toolCallback;

            // Handle both CortexResponse objects and plain responses
            while (response && (
                (response instanceof CortexResponse && response.hasToolCalls()) ||
                (typeof response === 'object' && response.tool_calls)
            )) {
                try {
                    response = await toolCallback(args, response, pathwayResolver);
                    
                    // Handle null response from tool callback
                    if (!response) {
                        throw new Error('Tool callback returned null - a model request likely failed');
                    }
                } catch (toolError) {
                    // Handle errors in tool callback
                    logger.error(`Error in tool callback: ${toolError.message}`);
                    // Generate error response for tool callback errors
                    const errorResponse = await generateErrorResponse(toolError, args, pathwayResolver);
                    // Ensure errors are cleared before returning
                    pathwayResolver.errors = [];
                    return errorResponse;
                }
            }

            // === CONTINUITY MEMORY RECORDING ===
            // Record turn and trigger synthesis ONCE after the full agentic workflow completes.
            // This ensures we only record one turn per user message, regardless of how many
            // intermediate tool calls occurred.
            if (useContinuityMemory && pathwayResolver.continuityEntityId && pathwayResolver.continuityUserId) {
                try {
                    const continuityService = getContinuityMemoryService();
                    if (continuityService.isAvailable()) {
                        // Extract original user message from chatHistory
                        // Find the last actual user message (not tool responses)
                        let userMessage = args.text || '';
                        if (!userMessage && args.chatHistory?.length > 0) {
                            for (let i = args.chatHistory.length - 1; i >= 0; i--) {
                                const msg = args.chatHistory[i];
                                if (msg?.role === 'user') {
                                    const content = msg.content;
                                    if (typeof content === 'string') {
                                        // Skip tool response JSON
                                        if (!content.trim().startsWith('{') || !content.includes('"success"')) {
                                            userMessage = content;
                                            break;
                                        }
                                    } else if (Array.isArray(content)) {
                                        // Extract text from content array
                                        const textItem = content.find(c => typeof c === 'string' || c?.type === 'text');
                                        if (textItem) {
                                            userMessage = typeof textItem === 'string' ? textItem : textItem.text;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Extract final assistant response
                        // For streaming: use accumulated streamedContent
                        // For non-streaming: extract from response object
                        let assistantResponse = '';
                        if (response && typeof response.on === 'function') {
                            // Streaming case - content was accumulated in pathwayResolver
                            assistantResponse = pathwayResolver.streamedContent || '';
                        } else if (response instanceof CortexResponse) {
                            assistantResponse = response.output_text || response.content || '';
                        } else if (typeof response === 'string') {
                            assistantResponse = response;
                        } else if (response) {
                            assistantResponse = response.output_text || response.content || JSON.stringify(response);
                        }
                        
                        // Record turns and trigger synthesis - all fire and forget
                        // No need to block response for Redis writes
                        if (userMessage) {
                            continuityService.recordTurn(
                                pathwayResolver.continuityEntityId,
                                pathwayResolver.continuityUserId,
                                {
                                    role: 'user',
                                    content: userMessage,
                                    timestamp: new Date().toISOString()
                                }
                            );
                        }
                        
                        if (assistantResponse) {
                            continuityService.recordTurn(
                                pathwayResolver.continuityEntityId,
                                pathwayResolver.continuityUserId,
                                {
                                    role: 'assistant',
                                    content: assistantResponse.substring(0, 5000), // Limit stored length
                                    timestamp: new Date().toISOString()
                                }
                            );
                        }
                        
                        continuityService.triggerSynthesis(
                            pathwayResolver.continuityEntityId,
                            pathwayResolver.continuityUserId,
                            {
                                aiName: args.aiName || entityName || 'Entity',
                                entityContext: entityInstructions
                            }
                        );
                        
                        logger.debug(`Continuity memory recorded for turn (user: ${userMessage?.length || 0} chars, assistant: ${assistantResponse?.length || 0} chars)`);
                    }
                } catch (error) {
                    // Non-fatal - log and continue
                    logger.warn(`Continuity memory recording failed (non-fatal): ${error.message}`);
                }
            }

            return response;

        } catch (e) {
            logger.error(`Error in sys_entity_agent: ${e.message}`);
            
            // Generate a smart error response instead of throwing
            const errorResponse = await generateErrorResponse(e, args, pathwayResolver);
            
            // Ensure errors are cleared before returning
            pathwayResolver.errors = [];
            
            return errorResponse;
        }
    }
}; 