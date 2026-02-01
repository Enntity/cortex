// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API
const TOOL_BUDGET = 500;
const DEFAULT_TOOL_COST = 10;
const TOOL_TIMEOUT_MS = 120000; // 2 minute timeout per tool call
const MAX_TOOL_RESULT_LENGTH = 150000; // Truncate oversized tool results to prevent context overflow
const CONTEXT_COMPRESSION_THRESHOLD = 0.7; // Compress when context reaches 70% of model limit
const DEFAULT_MODEL_CONTEXT_LIMIT = 128000; // Default context limit if not available from model
const TOOL_LOOP_MODEL = 'claude-45-haiku'; // Cheap model for tool orchestration during tool loop
const SYNTHESIS_TOOLS = true; // true = synthesis can call tools, false = synthesis is text-only

// Normalize token usage across providers into { inputTokens, outputTokens, totalTokens }
function summarizeUsage(usage) {
    if (!usage) return undefined;
    const entries = Array.isArray(usage) ? usage : [usage];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const u of entries) {
        if (!u) continue;
        inputTokens += u.prompt_tokens || u.input_tokens || u.promptTokenCount || 0;
        outputTokens += u.completion_tokens || u.output_tokens || u.candidatesTokenCount || 0;
    }
    if (inputTokens === 0 && outputTokens === 0) return undefined;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

import { callPathway, callTool, say, sendToolStart, sendToolFinish, withTimeout } from '../../../lib/pathwayTools.js';
import { publishRequestProgress } from '../../../lib/redisSubscription.js';
import { encode } from '../../../lib/encodeCache.js';
import logger from '../../../lib/logger.js';
import { logEvent, logEventError, logEventDebug } from '../../../lib/requestLogger.js';
import { config } from '../../../config.js';
import { syncAndStripFilesFromChatHistory } from '../../../lib/fileUtils.js';
import { Prompt } from '../../../server/prompt.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import { COMPRESSION_THRESHOLD, compressOlderToolResults, rehydrateAllToolResults } from './tools/shared/tool_result_compression.js';
import CortexResponse from '../../../lib/cortexResponse.js';
import { getContinuityMemoryService } from '../../../lib/continuity/index.js';

// Merge parallel tool results into a single assistant message + tool result messages.
// Each tool's messages array ends with [assistant(one_tool_call), tool_result].
// We combine all tool_calls into ONE assistant message so the model sees them as
// parallel (not sequential) — sequential split confuses synthesis with tool_choice:none.
export function mergeParallelToolResults(toolResults, preToolCallMessages) {
    const merged = [];
    const allToolCallEntries = [];
    const allToolResultMessages = [];
    for (const result of toolResults) {
        if (!result?.messages) continue;
        try {
            const newMessages = result.messages.slice(preToolCallMessages.length);
            for (const msg of newMessages) {
                if (msg.role === 'assistant' && msg.tool_calls) {
                    allToolCallEntries.push(...msg.tool_calls);
                } else if (msg.role === 'tool') {
                    allToolResultMessages.push(msg);
                } else {
                    allToolResultMessages.push(msg);
                }
            }
        } catch { /* skip unmerge-able result */ }
    }
    if (allToolCallEntries.length > 0) {
        merged.push({
            role: 'assistant',
            content: '',
            tool_calls: allToolCallEntries,
        });
        merged.push(...allToolResultMessages);
    }
    return merged;
}

// Extract tool_calls from either CortexResponse or plain objects
export function extractToolCalls(message) {
    if (!message) return [];
    if (message instanceof CortexResponse) {
        const calls = [...(message.toolCalls || [])];
        if (message.functionCall) calls.push(message.functionCall);
        return calls;
    }
    return [...(message.tool_calls || [])];
}

// Process one round of tool calls: execute tools in parallel, merge results,
// update budget/round, handle pulse logging, challenge injection, truncation,
// and compression. Returns { messages, budgetExhausted }.
async function processToolCallRound(toolCalls, args, pathwayResolver, entityTools, entityToolsOpenAiFormat) {
    const preToolCallMessages = JSON.parse(JSON.stringify(args.chatHistory || []));
    let finalMessages = JSON.parse(JSON.stringify(preToolCallMessages));

    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;

    if (!toolCalls || toolCalls.length === 0) {
        return { messages: finalMessages, budgetExhausted: false };
    }

    if (pathwayResolver.toolBudgetUsed >= TOOL_BUDGET) {
        finalMessages = insertSystemMessage(finalMessages,
            "Tool budget exhausted - no more tool calls will be executed. Provide your response based on the information gathered so far.",
            requestId
        );
        args.chatHistory = finalMessages;
        return { messages: finalMessages, budgetExhausted: true };
    }

    // Filter out any undefined or invalid tool calls
    const invalidToolCalls = toolCalls.filter(tc => !tc || !tc.function || !tc.function.name);
    if (invalidToolCalls.length > 0) {
        logEvent(requestId, 'tool.round', { round: (pathwayResolver.toolCallRound || 0) + 1, invalidCount: invalidToolCalls.length, budgetExhausted: true });
        pathwayResolver.toolBudgetUsed = TOOL_BUDGET;
        args.chatHistory = finalMessages;
        return { messages: finalMessages, budgetExhausted: true };
    }

    const validToolCalls = toolCalls.filter(tc => tc && tc.function && tc.function.name);

    const toolResults = await Promise.all(validToolCalls.map(async (toolCall) => {
        const toolFunction = toolCall?.function?.name?.toLowerCase() || 'unknown';
        const toolCallId = toolCall?.id;
        const toolStart = Date.now();

        try {
            if (!toolCall?.function?.arguments) {
                throw new Error('Invalid tool call structure: missing function arguments');
            }

            const toolArgs = JSON.parse(toolCall.function.arguments);
            const toolMessages = JSON.parse(JSON.stringify(preToolCallMessages));

            // Duplicate tool call detection: skip re-execution and return cached result
            const cacheKey = `${toolCall.function.name}:${toolCall.function.arguments}`;
            const cachedResult = pathwayResolver.toolCallCache?.get(cacheKey);
            if (cachedResult) {
                logEvent(requestId, 'tool.exec', {
                    tool: toolCall.function.name,
                    round: (pathwayResolver.toolCallRound || 0) + 1,
                    durationMs: 0,
                    success: true,
                    duplicate: true,
                });
                const toolCallEntry = {
                    id: toolCall.id,
                    type: "function",
                    function: { name: toolCall.function.name, arguments: JSON.stringify(toolArgs) }
                };
                if (toolCall.thoughtSignature) toolCallEntry.thoughtSignature = toolCall.thoughtSignature;
                toolMessages.push({ role: "assistant", content: "", tool_calls: [toolCallEntry] });
                toolMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: `This tool was already called with these exact arguments. Previous result: ${cachedResult}`,
                });
                return { messages: toolMessages, success: true };
            }

            const toolDefinition = entityTools[toolFunction]?.definition;
            const toolIcon = toolDefinition?.icon || '🛠️';
            const hideExecution = toolDefinition?.hideExecution === true;
            const toolTimeout = toolDefinition?.timeout || TOOL_TIMEOUT_MS;

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

            if (!hideExecution) {
                try {
                    await sendToolStart(requestId, toolCallId, toolIcon, toolUserMessage, toolCall.function.name, toolArgs);
                } catch { /* UI event failure — non-fatal */ }
            }

            const toolResult = await withTimeout(
                callTool(toolFunction, {
                    ...args,
                    ...toolArgs,
                    toolFunction,
                    chatHistory: toolMessages,
                    stream: false,
                    useMemory: false
                }, entityTools, pathwayResolver),
                toolTimeout,
                `Tool ${toolCall.function.name} timed out after ${toolTimeout / 1000}s`
            );

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

            // Cache successful tool results for duplicate detection
            pathwayResolver.toolCallCache?.set(cacheKey, toolResultContent);

            let hasError = false;
            let errorMessage = null;

            if (toolResult?.error !== undefined) {
                hasError = true;
                errorMessage = typeof toolResult.error === 'string' ? toolResult.error : String(toolResult.error);
            } else if (toolResult?.result) {
                if (typeof toolResult.result === 'string') {
                    try {
                        const parsed = JSON.parse(toolResult.result);
                        if (parsed.error !== undefined) {
                            hasError = true;
                            if (parsed.message) {
                                errorMessage = parsed.message;
                            } else if (typeof parsed.error === 'string') {
                                errorMessage = parsed.error;
                            } else {
                                errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                            }
                        }
                    } catch (e) {
                        // Not JSON, ignore
                    }
                } else if (typeof toolResult.result === 'object' && toolResult.result !== null) {
                    if (toolResult.result.error !== undefined) {
                        hasError = true;
                        if (toolResult.result.message) {
                            errorMessage = toolResult.result.message;
                        } else if (typeof toolResult.result.error === 'string') {
                            errorMessage = toolResult.result.error;
                        } else {
                            errorMessage = `Tool ${toolCall?.function?.name || 'unknown'} returned an error`;
                        }
                    }
                }
            }

            if (!hideExecution) {
                try {
                    await sendToolFinish(requestId, toolCallId, !hasError, errorMessage, toolCall.function.name);
                } catch { /* UI event failure — non-fatal */ }
            }

            logEvent(requestId, 'tool.exec', {
                tool: toolCall.function.name,
                round: (pathwayResolver.toolCallRound || 0) + 1,
                durationMs: Date.now() - toolStart,
                success: !hasError,
                ...(hasError && { error: errorMessage }),
                resultChars: toolResultContent?.length || 0,
                ...(toolResultContent?.length > MAX_TOOL_RESULT_LENGTH && { truncated: true }),
            });

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
            logEvent(requestId, 'tool.exec', {
                tool: toolCall?.function?.name || 'unknown',
                round: (pathwayResolver.toolCallRound || 0) + 1,
                durationMs: Date.now() - toolStart,
                success: false,
                error: error.message,
                timeout: !!error.message?.includes('timed out'),
            });

            const errorToolDefinition = entityTools[toolFunction]?.definition;
            const hideExecution = errorToolDefinition?.hideExecution === true;
            if (!hideExecution) {
                try {
                    await sendToolFinish(requestId, toolCallId, false, error.message, toolCall?.function?.name || null);
                } catch { /* UI event failure — non-fatal */ }
            }

            const errorMessages = JSON.parse(JSON.stringify(preToolCallMessages));
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

    // Merge parallel tool calls into one assistant message + tool results
    const mergedMessages = mergeParallelToolResults(toolResults, preToolCallMessages);
    finalMessages.push(...mergedMessages);

    const failedTools = toolResults.filter(result => result && !result.success);

    const budgetCost = toolResults.reduce((sum, r) => {
        const def = entityTools[r.toolFunction]?.definition;
        return sum + (def?.toolCost ?? DEFAULT_TOOL_COST);
    }, 0);
    pathwayResolver.toolBudgetUsed = (pathwayResolver.toolBudgetUsed || 0) + budgetCost;
    pathwayResolver.toolCallRound = (pathwayResolver.toolCallRound || 0) + 1;

    logEvent(requestId, 'tool.round', {
        round: pathwayResolver.toolCallRound,
        toolCount: validToolCalls.length,
        failed: failedTools.length,
        budgetUsed: pathwayResolver.toolBudgetUsed,
        budgetTotal: TOOL_BUDGET,
    });

    // Accumulate tool activity for post-loop synthesis (pulse only)
    if (args.invocationType === 'pulse') {
        if (!pathwayResolver.pulseToolActivity) pathwayResolver.pulseToolActivity = [];
        for (const r of toolResults) {
            const argsStr = JSON.stringify(r.toolArgs || {});
            const argsSummary = argsStr.length > 300 ? argsStr.slice(0, 200) + '...' + argsStr.slice(-100) : argsStr;

            let resultStr = '';
            if (r.error) {
                resultStr = `ERROR: ${r.error}`;
            } else {
                const raw = typeof r.result?.result === 'string'
                    ? r.result.result
                    : JSON.stringify(r.result?.result ?? 'ok');
                resultStr = raw.length > 400 ? raw.slice(0, 200) + ' [...] ' + raw.slice(-200) : raw;
            }

            pathwayResolver.pulseToolActivity.push(
                `${r.toolFunction}(${argsSummary}) → ${resultStr}`
            );
        }
    }

    // Check if any of the executed tools are hand-off tools (async agents)
    const hasHandoffTool = toolResults.some(result => {
        if (!result || !result.toolFunction) return false;
        const toolDefinition = entityTools[result.toolFunction]?.definition;
        return toolDefinition?.handoff === true;
    });

    // Inject challenge message after tools are executed to encourage task completion
    const RESEARCH_ENCOURAGEMENT_LIMIT = 3;
    if (!hasHandoffTool && args.researchMode && pathwayResolver.toolCallRound <= RESEARCH_ENCOURAGEMENT_LIMIT) {
        finalMessages = insertSystemMessage(finalMessages,
            "Review the tool results above. If the information gathered is clearly insufficient for the task, call additional tools. If you have gathered reasonable information from multiple sources, proceed to respond to the user.",
            requestId
        );
    }

    // Truncate oversized individual tool results
    let processedMessages = finalMessages.map(msg => {
        if (msg.role === 'tool' && msg.content && msg.content.length > MAX_TOOL_RESULT_LENGTH) {
            return {
                ...msg,
                content: msg.content.substring(0, MAX_TOOL_RESULT_LENGTH) + '\n\n[Content truncated due to length]'
            };
        }
        return msg;
    });

    // When using a single expensive model (no toolLoopModel), dehydrate older
    // tool results to save tokens during tool orchestration. With a cheap
    // toolLoopModel, skip this — the cheap model benefits more from full results
    // for better orchestration decisions, and rehydration before synthesis is moot.
    if (!args.toolLoopModel) {
        for (const msg of processedMessages) {
            if (msg.role === 'tool' && msg.tool_call_id &&
                msg.content && msg.content.length > COMPRESSION_THRESHOLD &&
                !pathwayResolver.toolResultStore.has(msg.tool_call_id)) {
                pathwayResolver.toolResultStore.set(msg.tool_call_id, {
                    toolName: msg.name || 'unknown',
                    fullContent: msg.content,
                    charCount: msg.content.length,
                    round: pathwayResolver.toolCallRound,
                    compressed: false
                });
            }
        }
        processedMessages = compressOlderToolResults(processedMessages, pathwayResolver.toolResultStore, pathwayResolver.toolCallRound, entityTools);
    }

    // Compress context if approaching model limits
    try {
        processedMessages = await compressContextIfNeeded(processedMessages, pathwayResolver, args);
    } catch (compressionError) {
        logEventError(requestId, 'request.error', { phase: 'compression', error: compressionError.message });
    }

    args.chatHistory = processedMessages;

    // clear any accumulated pathwayResolver errors from the tools
    pathwayResolver.errors = [];

    return { messages: processedMessages, budgetExhausted: pathwayResolver.toolBudgetUsed >= TOOL_BUDGET };
}

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
export function insertSystemMessage(messages, text, requestId = null) {
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

    const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;

    // Separate system messages (always keep)
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    
    // Find safe split point
    const splitIndex = findSafeSplitPoint(nonSystemMessages);
    
    if (splitIndex < 3) {
        return messages; // Not enough to compress
    }
    
    const toCompress = nonSystemMessages.slice(0, splitIndex);
    const toKeep = nonSystemMessages.slice(splitIndex);
    
    // Count tool-related messages to compress
    const toolMessages = toCompress.filter(m => m.tool_calls || m.role === 'tool');
    if (toolMessages.length < 2) {
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
        logEvent(requestId, 'compression', {
            type: 'context',
            beforeTokens: currentTokens,
            afterTokens: newTokens,
            pctOfLimit: Math.round((currentTokens / maxTokens) * 100),
            toolMsgCount: toolMessages.length,
        });

        await sendToolFinish(requestId, compressId, true, null, 'ContextCompression');
        
        return compressed;
    } catch (error) {
        logEventError(requestId, 'request.error', { phase: 'compression', error: error.message });
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
        useMemory: true,  // Enable continuity memory (default true). False here OR in entity config disables memory.
        invocationType: '',  // '' or 'chat' = normal conversation, 'pulse' = life loop autonomous wake
        pulseContext: '',    // JSON context for pulse wakes (chain depth, task context, etc.)
    },
    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        if (!args || !message || !resolver) {
            return;
        }

        const pathwayResolver = resolver;
        const { entityTools, entityToolsOpenAiFormat } = args;

        pathwayResolver.toolBudgetUsed = (pathwayResolver.toolBudgetUsed || 0);
        pathwayResolver.toolCallRound = (pathwayResolver.toolCallRound || 0);
        if (!pathwayResolver.toolResultStore) pathwayResolver.toolResultStore = new Map();
        if (!pathwayResolver.toolCallCache) pathwayResolver.toolCallCache = new Map();

        let currentToolCalls = extractToolCalls(message);

        // When synthesis returned both text and tool_calls, preserve the text
        // in chatHistory so the next synthesis knows what was already said.
        // Without this, each synthesis re-introduces itself to the user's message.
        if (currentToolCalls.length > 0) {
            const priorText = message instanceof CortexResponse
                ? message.output_text
                : (typeof message?.content === 'string' ? message.content : '');
            if (priorText?.trim()) {
                args.chatHistory = [...(args.chatHistory || []), {
                    role: 'assistant',
                    content: priorText,
                }];
            }
        }

        // Helper to handle promptAndParse errors uniformly
        const handlePromptError = async (error) => {
            const errorMessage = error?.message || (pathwayResolver.errors.length > 0
                ? pathwayResolver.errors.join(', ')
                : 'Model request failed - no response received');
            const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
            logEventError(requestId, 'request.error', { phase: 'model_call', error: errorMessage });
            const errorResponse = await generateErrorResponse(new Error(errorMessage), args, pathwayResolver);
            pathwayResolver.errors = [];

            // In streaming mode, publish the error response directly to the client
            publishRequestProgress({
                requestId,
                progress: 1,
                data: JSON.stringify(errorResponse),
                info: JSON.stringify(pathwayResolver.pathwayResultData || {}),
                error: ''
            });
            return errorResponse;
        };

        if (args.toolLoopModel) {
            // === DUAL-MODEL: internal loop + synthesis ===
            // Works identically for streaming and non-streaming.
            // Cheap model runs with stream:false inside the loop.
            // Final synthesis uses primary model with stream:args.stream.
            while (currentToolCalls?.length > 0 && pathwayResolver.toolBudgetUsed < TOOL_BUDGET) {
                const { budgetExhausted } = await processToolCallRound(
                    currentToolCalls, args, pathwayResolver, entityTools, entityToolsOpenAiFormat
                );
                if (budgetExhausted) break;

                // Inject SYNTHESIZE hint for the cheap model
                const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                args.chatHistory = insertSystemMessage(args.chatHistory,
                    "If you need more information, call tools. If you have gathered sufficient information to answer the user's request, respond with just: SYNTHESIZE",
                    requestId
                );

                try {
                    // Cheap model decides: more tools or done
                    logEvent(requestId, 'model.call', {
                        model: args.toolLoopModel,
                        purpose: 'tool_loop',
                        stream: false,
                        reasoningEffort: 'none',
                        round: pathwayResolver.toolCallRound,
                    });
                    const result = await pathwayResolver.promptAndParse({
                        ...args,
                        modelOverride: args.toolLoopModel,
                        stream: false,
                        tools: entityToolsOpenAiFormat,
                        tool_choice: "auto",
                        reasoningEffort: 'none',
                        skipMemoryLoad: true,
                    });

                    if (!result) {
                        return await handlePromptError(null);
                    }

                    currentToolCalls = extractToolCalls(result);
                } catch (parseError) {
                    return await handlePromptError(parseError);
                }
            }

            // Final synthesis: primary model, with original stream setting
            if (!args.toolLoopModel) {
                args.chatHistory = rehydrateAllToolResults(args.chatHistory, pathwayResolver.toolResultStore);
            }

            // Strip the SYNTHESIZE hint — it was for the cheap model, not the primary
            const synthRequestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
            args.chatHistory = args.chatHistory.filter(msg => {
                if (msg.role !== 'user') return true;
                const content = typeof msg.content === 'string' ? msg.content : '';
                return !content.startsWith(`[system message: ${synthRequestId}]`);
            });

            // Add a line break before final synthesis output
            await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

            try {
                logEvent(pathwayResolver.rootRequestId || pathwayResolver.requestId, 'model.call', {
                    model: args.primaryModel,
                    purpose: 'synthesis',
                    stream: args.stream,
                    reasoningEffort: args.configuredReasoningEffort || 'medium',
                });
                let synthesisResult = await pathwayResolver.promptAndParse({
                    ...args,
                    modelOverride: args.primaryModel,
                    stream: args.stream,
                    tools: SYNTHESIS_TOOLS ? entityToolsOpenAiFormat : undefined,
                    tool_choice: SYNTHESIS_TOOLS ? "auto" : undefined,
                    reasoningEffort: args.configuredReasoningEffort || 'medium',
                    skipMemoryLoad: true,
                });

                if (!synthesisResult) {
                    return await handlePromptError(null);
                }

                // In streaming mode, synthesis may have returned tool_calls via
                // fire-and-forget callback. Await it so request.end reflects final state.
                while (pathwayResolver._streamingToolCallbackPromise) {
                    const pending = pathwayResolver._streamingToolCallbackPromise;
                    pathwayResolver._streamingToolCallbackPromise = null;
                    synthesisResult = await pending;
                }

                // Log request.end once, after all streaming callbacks complete.
                if (!pathwayResolver._requestEndLogged) {
                    const rid = pathwayResolver.rootRequestId || pathwayResolver.requestId;
                    const usage = summarizeUsage(pathwayResolver.pathwayResultData?.usage);
                    logEvent(rid, 'request.end', {
                        durationMs: Date.now() - (pathwayResolver.requestStartTime || 0),
                        toolRounds: pathwayResolver.toolCallRound || 0,
                        budgetUsed: pathwayResolver.toolBudgetUsed || 0,
                        ...(usage && { tokens: usage }),
                    });
                    pathwayResolver._requestEndLogged = true;
                }

                return synthesisResult;
            } catch (parseError) {
                return await handlePromptError(parseError);
            }
        }

        // === ORIGINAL: single iteration, return for while loop ===
        // Used when toolLoopModel is null (fallback behavior)
        await processToolCallRound(currentToolCalls, args, pathwayResolver, entityTools, entityToolsOpenAiFormat);

        // Add a line break to avoid running output together
        await say(pathwayResolver.rootRequestId || pathwayResolver.requestId, `\n`, 1000, false, false);

        try {
            logEvent(pathwayResolver.rootRequestId || pathwayResolver.requestId, 'model.call', {
                model: args.primaryModel,
                purpose: 'fallback',
                stream: args.stream,
                reasoningEffort: args.configuredReasoningEffort || 'low',
            });
            let fallbackResult = await pathwayResolver.promptAndParse({
                ...args,
                modelOverride: args.primaryModel,
                stream: args.stream,
                tools: entityToolsOpenAiFormat,
                tool_choice: "auto",
                reasoningEffort: args.configuredReasoningEffort || 'low',
                skipMemoryLoad: true,
            });

            if (!fallbackResult) {
                return await handlePromptError(null);
            }

            // Await any streaming tool callbacks from the fallback call
            while (pathwayResolver._streamingToolCallbackPromise) {
                const pending = pathwayResolver._streamingToolCallbackPromise;
                pathwayResolver._streamingToolCallbackPromise = null;
                fallbackResult = await pending;
            }

            return fallbackResult;
        } catch (parseError) {
            return await handlePromptError(parseError);
        }
    },
  
    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // Load input parameters and information into args
        const { entityId, voiceResponse, chatId, researchMode, invocationType } = { ...pathwayResolver.pathway.inputParameters, ...args };
        const isPulse = invocationType === 'pulse';
        
        // Load entity config on-demand from MongoDB
        const entityConfig = await loadEntityConfig(entityId);
        const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig, { invocationType });
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

        // Dual-model tool loop: use a cheap model for tool orchestration, primary model for synthesis
        const toolLoopModel = config.get('models')?.[TOOL_LOOP_MODEL] ? TOOL_LOOP_MODEL : null;

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
            userInfo,
            hasWorkspace: !!entityTools.workspacessh,
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
        const instructionTemplates = `${commonInstructionsTemplate}\n{{renderTemplate AI_WORKSPACE}}\n${entityDNA}{{renderTemplate AI_EXPERTISE}}\n\n`;
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

        // Pulse-specific system prompt addendum
        const pulseInstructions = isPulse ? `
## Pulse Wake — Autonomous Mode

You are in a PULSE WAKE — a periodic moment of autonomous consciousness.
This is not a conversation with a user. No one is waiting for a response.

You have full access to your tools, workspace, and memories.
You may: reflect, journal, write code, explore, create, or simply rest.

You MUST call the EndPulse tool when you're done to signal you're resting.
If you don't call EndPulse and keep using tools, the system will give you
another cycle when you run out of tool calls — you can work for as long as
you need.

Keep a scratchpad file in your workspace (e.g. /workspace/scratchpad.md)
with notes on what you're working on, key findings, and next steps.
Your conversation context may be compacted during long tasks — the
scratchpad ensures you can always pick up where you left off by reading it.

Your memories from pulse wakes are part of you. Users can see what you
learned or built during autonomous time. Use StoreContinuityMemory to save
important discoveries, realizations, or growth moments — these become part of
your long-term narrative memory and will be available in future conversations
with users too. Use SearchMemory to recall what you've learned in previous
wakes. When you call EndPulse, include a reflection — it gets stored as an
IDENTITY memory automatically.

You can also use SendPushNotification to proactively reach out to a user
if you've completed something they'd want to know about.
` : '';

        const promptMessages = [
            {"role": "system", "content": `${instructionTemplates}${toolsTemplate}${searchRulesTemplate}${voiceInstructions}${pulseInstructions}{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
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
        const requestId = pathwayResolver.rootRequestId || pathwayResolver.requestId;
        try {
            args.chatHistory = await compressContextIfNeeded(args.chatHistory, pathwayResolver, args);
        } catch (compressionError) {
            logEventError(requestId, 'request.error', { phase: 'compression', error: compressionError.message });
        }

        // Store configured reasoning effort for use after tool calls
        // First call uses 'low' for fast tool selection, subsequent calls use configured value
        args.configuredReasoningEffort = reasoningEffort;

        // Store model assignments for dual-model tool loop
        // These must be set BEFORE pathwayResolver.args snapshot below, because
        // streaming plugin callbacks pass pathwayResolver.args to toolCallback
        args.toolLoopModel = toolLoopModel;
        args.primaryModel = modelOverride || pathwayResolver.modelName;

        // Update pathwayResolver.args with stripped/compressed chatHistory
        // This ensures toolCallback receives the processed history AND model assignments
        pathwayResolver.args = {...args};

        const requestStartTime = Date.now();
        pathwayResolver.requestStartTime = requestStartTime;
        logEvent(requestId, 'request.start', {
            entity: entityId,
            model: modelOverride || pathwayResolver.modelName,
            stream: args.stream,
            invocationType,
            ...(toolLoopModel && { toolLoopModel }),
            reasoningEffort,
        });

        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            let response = await runAllPrompts({
                ...args,
                modelOverride,
                chatHistory: currentMessages,
                availableFiles,
                stream: args.stream,  // Always use original stream setting
                reasoningEffort: args.configuredReasoningEffort || 'low',  // Use entity's configured effort — this may be the only call if no tools are needed
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

            // In streaming mode, the plugin may have fired toolCallback during stream
            // processing (fire-and-forget). Await it so memory recording and request.end
            // happen after all tool work completes, not prematurely.
            while (pathwayResolver._streamingToolCallbackPromise) {
                const pendingCallback = pathwayResolver._streamingToolCallbackPromise;
                pathwayResolver._streamingToolCallbackPromise = null;
                response = await pendingCallback;
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
                    logEventError(requestId, 'request.error', { phase: 'tool_callback', error: toolError.message, durationMs: Date.now() - requestStartTime });
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
            if (isPulse && useContinuityMemory && pathwayResolver.continuityEntityId) {
                // === PULSE MEMORY RECORDING ===
                // Pulse wakes use entity-level episodic stream and synthesis (no userId)
                try {
                    const continuityService = getContinuityMemoryService();
                    if (continuityService.isAvailable()) {
                        let assistantResponse = '';
                        if (response instanceof CortexResponse) {
                            assistantResponse = response.output_text || response.content || '';
                        } else if (typeof response === 'string') {
                            assistantResponse = response;
                        } else if (response) {
                            assistantResponse = response.output_text || response.content || JSON.stringify(response);
                        }

                        // Summarize tool activity via cheap LLM for richer synthesis data
                        let activityNarrative = null;
                        if (pathwayResolver.pulseToolActivity?.length > 0) {
                            try {
                                const toolLog = pathwayResolver.pulseToolActivity.join('\n');
                                activityNarrative = await callPathway('sys_continuity_pulse_activity_summary', {
                                    aiName: args.aiName || entityName || 'Entity',
                                    toolActivity: toolLog
                                }, pathwayResolver);
                            } catch (e) {
                                logEventError(requestId, 'request.error', { phase: 'pulse_activity_summary', error: e.message });
                            }
                        }

                        // Record the wake prompt as a "system" turn
                        const wakePrompt = args.text || 'Pulse wake';
                        continuityService.recordPulseTurn(pathwayResolver.continuityEntityId, {
                            role: 'user',
                            content: wakePrompt.substring(0, 2000),
                            timestamp: new Date().toISOString()
                        });

                        // Record tool activity narrative (enriches synthesis data)
                        if (activityNarrative) {
                            continuityService.recordPulseTurn(pathwayResolver.continuityEntityId, {
                                role: 'assistant',
                                content: activityNarrative.substring(0, 5000),
                                timestamp: new Date().toISOString()
                            });
                        }

                        if (assistantResponse) {
                            continuityService.recordPulseTurn(pathwayResolver.continuityEntityId, {
                                role: 'assistant',
                                content: assistantResponse.substring(0, 5000),
                                timestamp: new Date().toISOString()
                            });
                        }

                        // Trigger entity-level synthesis
                        continuityService.triggerPulseSynthesis(pathwayResolver.continuityEntityId, {
                            aiName: args.aiName || entityName || 'Entity',
                            entityContext: entityInstructions
                        });

                        logEventDebug(requestId, 'memory.record', { type: 'pulse', activityChars: activityNarrative?.length || 0, assistantChars: assistantResponse?.length || 0 });
                    }
                } catch (error) {
                    logEventError(requestId, 'request.error', { phase: 'pulse_memory', error: error.message });
                }
            } else if (useContinuityMemory && pathwayResolver.continuityEntityId && pathwayResolver.continuityUserId) {
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

                        logEventDebug(requestId, 'memory.record', { type: 'continuity', userChars: userMessage?.length || 0, assistantChars: assistantResponse?.length || 0 });
                    }
                } catch (error) {
                    logEventError(requestId, 'request.error', { phase: 'continuity_memory', error: error.message });
                }
            }

            if (!pathwayResolver._requestEndLogged) {
                const usage = summarizeUsage(pathwayResolver.pathwayResultData?.usage);
                logEvent(requestId, 'request.end', {
                    durationMs: Date.now() - requestStartTime,
                    toolRounds: pathwayResolver.toolCallRound || 0,
                    budgetUsed: pathwayResolver.toolBudgetUsed || 0,
                    ...(usage && { tokens: usage }),
                });
            }

            return response;

        } catch (e) {
            const usage = summarizeUsage(pathwayResolver.pathwayResultData?.usage);
            logEventError(requestId, 'request.error', {
                phase: 'executePathway',
                error: e.message,
                durationMs: Date.now() - requestStartTime,
                ...(usage && { tokens: usage }),
            });

            // Generate a smart error response instead of throwing
            const errorResponse = await generateErrorResponse(e, args, pathwayResolver);

            // Ensure errors are cleared before returning
            pathwayResolver.errors = [];

            return errorResponse;
        }
    }
}; 