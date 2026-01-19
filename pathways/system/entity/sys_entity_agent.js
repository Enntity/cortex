// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const MAX_TOOL_CALLS = 50;

import { callPathway, callTool, say, sendToolStart, sendToolFinish } from '../../../lib/pathwayTools.js';
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
                    try {
                        if (!toolCall?.function?.arguments) {
                            throw new Error('Invalid tool call structure: missing function arguments');
                        }

                        const toolArgs = JSON.parse(toolCall.function.arguments);
                        const toolFunction = toolCall.function.name.toLowerCase();
                        
                        // Create an isolated copy of messages for this tool
                        const toolMessages = JSON.parse(JSON.stringify(preToolCallMessages));
                        
                        // Get the tool definition to check for icon and visibility
                        const toolDefinition = entityTools[toolFunction]?.definition;
                        const toolIcon = toolDefinition?.icon || '🛠️';
                        const hideExecution = toolDefinition?.hideExecution === true;
                        
                        // Get the user message for the tool
                        const toolUserMessage = toolArgs.userMessage || `Executing tool: ${toolCall.function.name}`;
                        
                        // Send tool start message (unless execution is hidden)
                        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                        const toolCallId = toolCall.id;
                        if (!hideExecution) {
                            try {
                                await sendToolStart(requestId, toolCallId, toolIcon, toolUserMessage, toolCall.function.name, toolArgs);
                            } catch (startError) {
                                logger.error(`Error sending tool start message: ${startError.message}`);
                                // Continue execution even if start message fails
                            }
                        }

                        const toolResult = await callTool(toolFunction, {
                            ...args,
                            ...toolArgs,
                            toolFunction,
                            chatHistory: toolMessages,
                            stream: false,
                            useMemory: false  // Disable memory synthesis for tool calls
                        }, entityTools, pathwayResolver);

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
                        logger.error(`Error executing tool ${toolCall?.function?.name || 'unknown'}: ${error.message}`);
                        
                        // Send tool finish message (error) - unless execution is hidden
                        // Get requestId and toolCallId if not already defined (in case error occurred before they were set)
                        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                        const toolCallId = toolCall.id;
                        const errorToolDefinition = entityTools[toolCall?.function?.name?.toLowerCase()]?.definition;
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
                            id: toolCall.id,
                            type: "function",
                            function: {
                                name: toolCall.function.name,
                                arguments: JSON.stringify(toolCall.function.arguments)
                            }
                        };
                        if (toolCall.thoughtSignature) {
                            errorToolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                        }
                        errorMessages.push({
                            role: "assistant",
                            content: "",
                            tool_calls: [errorToolCallEntry]
                        });
                        errorMessages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: `Error: ${error.message}`
                        });

                        return { 
                            success: false, 
                            error: error.message,
                            toolCall,
                            toolArgs: toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {},
                            toolFunction: toolCall?.function?.name?.toLowerCase() || 'unknown',
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
                // Only inject in research mode - in normal mode, let the model be more decisive
                // Skip this check if a hand-off tool was used (async agents handle their own completion)
                if (!hasHandoffTool && args.researchMode) {
                    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    finalMessages = insertSystemMessage(finalMessages, 
                        "Review the tool results above. If your task is incomplete or requires additional steps or information, call the necessary tools now. Adapt your approach and re-plan if you are not finding the information you need. Only respond to the user once the task is complete and sufficient information has been gathered.",
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

            args.chatHistory = finalMessages;

            // clear any accumulated pathwayResolver errors from the tools
            pathwayResolver.errors = [];

            // Add a line break to avoid running output together
            await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

            try {
                const result = await pathwayResolver.promptAndParse({
                    ...args,
                    tools: entityToolsOpenAiFormat,
                    tool_choice: "auto",
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
        
        // Load entity config - cache is kept in sync by MongoEntityStore._syncConfigCache()
        const entityConfig = loadEntityConfig(entityId);
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

        args = {
            ...args,
            ...config.get('entityConstants'),
            entityId,
            entityTools,
            entityToolsOpenAiFormat,
            entityInstructions,
            voiceResponse,
            chatId,
            researchMode
        };

        pathwayResolver.args = {...args};

        // Core of the entity's DNA - either continuity memory or entity instructions
        const entityDNA = useContinuityMemory 
            ? `{{renderTemplate AI_CONTINUITY_CONTEXT}}\n\n` 
            : (entityInstructions ? entityInstructions + '\n\n' : '');

        const instructionTemplates = `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\n${entityDNA}{{renderTemplate AI_EXPERTISE}}\n\n`;
        const searchRulesTemplate = researchMode ? `{{renderTemplate AI_SEARCH_RULES}}\n\n` : '';

        const promptMessages = [
            {"role": "system", "content": `${instructionTemplates}{{renderTemplate AI_TOOLS}}\n\n${searchRulesTemplate}{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
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
            args.chatHistory, args.agentContext, chatId
        );
        args.chatHistory = strippedHistory;

        // truncate the chat history in case there is really long content
        const truncatedChatHistory = resolver.modelExecutor.plugin.truncateMessagesToTargetLength(args.chatHistory, null, 1000);
      
        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            let response = await runAllPrompts({
                ...args,
                modelOverride,
                chatHistory: currentMessages,
                availableFiles,
                reasoningEffort,
                tools: entityToolsOpenAiFormat,
                tool_choice: "auto"
            });

            // Handle null response (can happen when ModelExecutor catches an error)
            if (!response) {
                throw new Error('Model execution returned null - the model request likely failed');
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
                        
                        // Record user turn
                        if (userMessage) {
                            await continuityService.recordTurn(
                                pathwayResolver.continuityEntityId,
                                pathwayResolver.continuityUserId,
                                {
                                    role: 'user',
                                    content: userMessage,
                                    timestamp: new Date().toISOString()
                                }
                            );
                        }
                        
                        // Record assistant turn
                        if (assistantResponse) {
                            await continuityService.recordTurn(
                                pathwayResolver.continuityEntityId,
                                pathwayResolver.continuityUserId,
                                {
                                    role: 'assistant',
                                    content: assistantResponse.substring(0, 5000), // Limit stored length
                                    timestamp: new Date().toISOString()
                                }
                            );
                        }
                        
                        // Trigger background synthesis (fire and forget)
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
            // Note: We don't call logError here because generateErrorResponse will clear errors
            // and we want to handle the error gracefully rather than tracking it
            const errorResponse = await generateErrorResponse(e, args, pathwayResolver);
            
            // Ensure errors are cleared before returning (in case any were added during error response generation)
            pathwayResolver.errors = [];
            
            return errorResponse;
        }
    }
}; 