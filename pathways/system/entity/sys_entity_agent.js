// sys_entity_agent.js
// Agentic extension of the entity system that uses OpenAI's tool calling API

// ─── Constants ───────────────────────────────────────────────────────────────

const TOOL_BUDGET = 500;
const DEFAULT_TOOL_COST = 10;
const TOOL_TIMEOUT_MS = 120000;
const MAX_TOOL_RESULT_LENGTH = 150000;
const CONTEXT_COMPRESSION_THRESHOLD = 0.7;
const DEFAULT_MODEL_CONTEXT_LIMIT = 128000;
const TOOL_LOOP_MODEL = 'claude-45-haiku';
const MAX_GATE_RETRIES = 2;
const MAX_REPLAN_SAFETY_CAP = 10;

const SET_GOALS_TOOL_NAME = 'setgoals';

const SET_GOALS_OPENAI_DEF = {
    type: "function",
    function: {
        name: "SetGoals",
        description: "Declare everything that needs to happen before this request is done. Call this alongside your first tool calls. Not a sequential recipe — a checklist of outcomes.",
        parameters: {
            type: "object",
            properties: {
                goal: { type: "string", description: "What the user needs — one sentence" },
                steps: { type: "array", items: { type: "string" }, description: "2-5 specific things to accomplish (not how — what)" }
            },
            required: ["goal", "steps"]
        }
    }
};

const VOICE_FALLBACKS = {
    'GoogleSearch': 'Let me look that up.',
    'GoogleNews': 'Checking the news.',
    'SearchX': 'Searching for that now.',
    'CreateMedia': 'Creating that for you.',
    'ShowOverlay': 'Showing that now.',
    'WorkspaceSSH': 'Working on that.',
    'default': 'One moment.'
};

// ─── Imports ─────────────────────────────────────────────────────────────────

import { callPathway, callTool, say, sendToolStart, sendToolFinish, withTimeout } from '../../../lib/pathwayTools.js';
import { publishRequestProgress } from '../../../lib/redisSubscription.js';
import { encode } from '../../../lib/encodeCache.js';
import logger from '../../../lib/logger.js';
import { logEvent, logEventError, logEventDebug } from '../../../lib/requestLogger.js';
import { config } from '../../../config.js';
import { syncAndStripFilesFromChatHistory } from '../../../lib/fileUtils.js';
import { Prompt } from '../../../server/prompt.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import { COMPRESSION_THRESHOLD, compressOlderToolResults, rehydrateAllToolResults, dehydrateToolHistory } from './tools/shared/tool_result_compression.js';
import CortexResponse from '../../../lib/cortexResponse.js';
import { getContinuityMemoryService } from '../../../lib/continuity/index.js';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function getRequestId(resolver) {
    return resolver.rootRequestId || resolver.requestId;
}

function cloneMessages(msgs) {
    return JSON.parse(JSON.stringify(msgs));
}

function extractResponseText(response) {
    if (response instanceof CortexResponse) return response.output_text || response.content || '';
    if (typeof response === 'string') return response;
    if (response) return response.output_text || response.content || JSON.stringify(response);
    return '';
}

function buildToolCallEntry(toolCall, args) {
    const entry = {
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.function.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
    };
    if (toolCall.thoughtSignature) entry.thoughtSignature = toolCall.thoughtSignature;
    return entry;
}

function safeParse(str) {
    try { return JSON.parse(str); } catch { return undefined; }
}

function detectToolError(result, toolName) {
    if (result?.error !== undefined) {
        return typeof result.error === 'string' ? result.error : String(result.error);
    }
    if (!result?.result) return null;
    const r = result.result;
    if (typeof r === 'string') {
        const parsed = safeParse(r);
        if (parsed?.error !== undefined) {
            return parsed.message || (typeof parsed.error === 'string' ? parsed.error : `Tool ${toolName} returned an error`);
        }
    } else if (typeof r === 'object' && r !== null && r.error !== undefined) {
        return r.message || (typeof r.error === 'string' ? r.error : `Tool ${toolName} returned an error`);
    }
    return null;
}

function drainStreamingCallbacks(resolver) {
    return async (resultHolder) => {
        let hadCallback = false;
        while (resolver._streamingToolCallbackPromise) {
            hadCallback = true;
            const pending = resolver._streamingToolCallbackPromise;
            resolver._streamingToolCallbackPromise = null;
            resultHolder.value = await pending;
        }
        return hadCallback;
    };
}

function logRequestEnd(resolver) {
    if (resolver._requestEndLogged) return;
    const usage = summarizeUsage(resolver.pathwayResultData?.usage);
    logEvent(getRequestId(resolver), 'request.end', {
        durationMs: Date.now() - (resolver.requestStartTime || 0),
        toolRounds: resolver.toolCallRound || 0,
        budgetUsed: resolver.toolBudgetUsed || 0,
        ...(usage && { tokens: usage }),
    });
    resolver._requestEndLogged = true;
}

// ─── Exported Helpers ────────────────────────────────────────────────────────

export function mergeParallelToolResults(toolResults, preToolCallMessages) {
    const merged = [];
    const allToolCallEntries = [];
    const allToolResultMessages = [];
    for (const result of toolResults) {
        if (!result?.messages) continue;
        try {
            for (const msg of result.messages.slice(preToolCallMessages.length)) {
                if (msg.role === 'assistant' && msg.tool_calls) allToolCallEntries.push(...msg.tool_calls);
                else allToolResultMessages.push(msg);
            }
        } catch { /* skip unmerge-able result */ }
    }
    if (allToolCallEntries.length > 0) {
        merged.push({ role: 'assistant', content: '', tool_calls: allToolCallEntries });
        merged.push(...allToolResultMessages);
    }
    return merged;
}

export function extractToolCalls(message) {
    if (!message) return [];
    if (message instanceof CortexResponse) {
        const calls = [...(message.toolCalls || [])];
        if (message.functionCall) calls.push(message.functionCall);
        return calls;
    }
    return [...(message.tool_calls || [])];
}

export function insertSystemMessage(messages, text, requestId = null) {
    const marker = requestId ? `[system message: ${requestId}]` : '[system message]';
    const filtered = messages.filter(msg => {
        if (msg.role !== 'user') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return !content.startsWith(marker);
    });
    filtered.push({ role: "user", content: `${marker} ${text}` });
    return filtered;
}

export function buildStepInstruction(pathwayResolver) {
    if (!pathwayResolver.toolPlan) {
        return "If you need more information, call tools. Otherwise respond with: SYNTHESIZE";
    }
    const { goal, steps } = pathwayResolver.toolPlan;
    const stepsBlock = steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
    return `TODO — Goal: ${goal}
${stepsBlock}

Look at the tool results already in the conversation. If an item is satisfied by existing results, skip it — do NOT re-run tools for work already done.
Call tools only for items with no results yet. Batch as many as possible in one response.
Do NOT retry a tool that already failed or returned an error.
Respond with SYNTHESIZE when all items are addressed.`;
}

export function passesGate(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return false;
    return toolCalls.some(tc => tc.function?.name?.toLowerCase() === SET_GOALS_TOOL_NAME);
}

// ─── Logging Helpers ─────────────────────────────────────────────────────────

function summarizeUsage(usage) {
    if (!usage) return undefined;
    const entries = Array.isArray(usage) ? usage : [usage];
    let inputTokens = 0, outputTokens = 0;
    for (const u of entries) {
        if (!u) continue;
        inputTokens += u.prompt_tokens || u.input_tokens || u.promptTokenCount || 0;
        outputTokens += u.completion_tokens || u.output_tokens || u.candidatesTokenCount || 0;
    }
    if (inputTokens === 0 && outputTokens === 0) return undefined;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function summarizeToolNames(tools) {
    if (!tools || !Array.isArray(tools)) return undefined;
    return tools.map(t => t.function?.name || t.name || '?');
}

function summarizeReturnedCalls(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return undefined;
    return toolCalls.map(tc => {
        const name = tc.function?.name || '?';
        let argsSummary;
        try {
            const raw = tc.function?.arguments;
            if (raw) {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const keys = Object.keys(parsed);
                argsSummary = keys.length <= 3
                    ? Object.fromEntries(keys.map(k => {
                        const v = parsed[k];
                        const s = typeof v === 'string' ? v : JSON.stringify(v);
                        return [k, s.length > 80 ? s.slice(0, 77) + '...' : s];
                    }))
                    : `{${keys.join(', ')}}`;
            }
        } catch { /* leave undefined */ }
        return argsSummary ? { name, args: argsSummary } : { name };
    });
}

// ─── Model Calling ───────────────────────────────────────────────────────────

async function callModelLogged(resolver, callArgs, purpose, overrides = {}) {
    const rid = getRequestId(resolver);
    const model = callArgs.modelOverride || overrides.model;
    logEvent(rid, 'model.call', {
        model,
        purpose,
        stream: callArgs.stream,
        reasoningEffort: callArgs.reasoningEffort,
        toolNames: summarizeToolNames(callArgs.tools),
        toolChoice: callArgs.tool_choice || 'auto',
        messageCount: callArgs.chatHistory?.length || 0,
        ...overrides,
    });
    const start = Date.now();
    const result = await resolver.promptAndParse(callArgs);
    const toolCalls = extractToolCalls(result);
    logEvent(rid, 'model.result', {
        model,
        purpose,
        durationMs: Date.now() - start,
        returnedToolCalls: summarizeReturnedCalls(toolCalls),
        ...overrides,
    });
    return result;
}

function makeErrorHandler(args, resolver) {
    return async (error) => {
        const errorMessage = error?.message || (resolver.errors.length > 0
            ? resolver.errors.join(', ')
            : 'Model request failed - no response received');
        logEventError(getRequestId(resolver), 'request.error', { phase: 'model_call', error: errorMessage });
        const errorResponse = await generateErrorResponse(new Error(errorMessage), args, resolver);
        resolver.errors = [];
        publishRequestProgress({
            requestId: getRequestId(resolver),
            progress: 1,
            data: JSON.stringify(errorResponse),
            info: JSON.stringify(resolver.pathwayResultData || {}),
            error: ''
        });
        return errorResponse;
    };
}

// ─── Tool Execution ──────────────────────────────────────────────────────────

function interceptSetGoals(setGoalsCalls, preToolCallMessages, resolver) {
    const rid = getRequestId(resolver);
    return setGoalsCalls.map(planCall => {
        try {
            const planArgs = safeParse(planCall.function.arguments);
            if (planArgs?.goal && Array.isArray(planArgs.steps)) {
                resolver.toolPlan = { goal: planArgs.goal, steps: planArgs.steps };
                logEvent(rid, 'plan.created', { goal: planArgs.goal, steps: planArgs.steps.length, stepList: planArgs.steps });
            }
        } catch { /* malformed plan args — ignore */ }

        const planMessages = cloneMessages(preToolCallMessages);
        planMessages.push({ role: "assistant", content: "", tool_calls: [buildToolCallEntry(planCall, planCall.function.arguments)] });
        planMessages.push({
            role: "tool",
            tool_call_id: planCall.id,
            name: planCall.function.name,
            content: JSON.stringify({ success: true, message: 'Plan acknowledged.' })
        });
        return { success: true, toolCall: planCall, toolArgs: {}, toolFunction: SET_GOALS_TOOL_NAME, messages: planMessages, skipBudget: true };
    });
}

async function executeSingleTool(toolCall, preToolCallMessages, args, resolver, entityTools) {
    const toolFunction = toolCall?.function?.name?.toLowerCase() || 'unknown';
    const toolCallId = toolCall?.id;
    const toolStart = Date.now();
    const rid = getRequestId(resolver);

    try {
        if (!toolCall?.function?.arguments) throw new Error('Invalid tool call structure: missing function arguments');

        const toolArgs = JSON.parse(toolCall.function.arguments);
        const toolMessages = cloneMessages(preToolCallMessages);

        // Duplicate detection
        const cacheKey = `${toolCall.function.name}:${toolCall.function.arguments}`;
        const cachedResult = resolver.toolCallCache?.get(cacheKey);
        if (cachedResult) {
            logEvent(rid, 'tool.exec', { tool: toolCall.function.name, round: (resolver.toolCallRound || 0) + 1, durationMs: 0, success: true, duplicate: true, toolArgs: summarizeReturnedCalls([toolCall])?.[0]?.args });
            toolMessages.push({ role: "assistant", content: "", tool_calls: [buildToolCallEntry(toolCall, toolArgs)] });
            toolMessages.push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: `This tool was already called with these exact arguments. Previous result: ${cachedResult}` });
            return { messages: toolMessages, success: true };
        }

        const toolDef = entityTools[toolFunction]?.definition;
        const hideExecution = toolDef?.hideExecution === true;
        const toolTimeout = toolDef?.timeout || TOOL_TIMEOUT_MS;
        const toolName = toolCall.function.name;
        const toolUserMessage = toolArgs.userMessage || VOICE_FALLBACKS[toolName] || VOICE_FALLBACKS.default;

        if (!hideExecution) {
            try { await sendToolStart(rid, toolCallId, toolDef?.icon || '🛠️', toolUserMessage, toolName, toolArgs); } catch { /* non-fatal */ }
        }

        // Strip infrastructure keys from model-provided toolArgs to prevent override of entityId, contextId, etc.
        const { entityId: _eId, contextId: _cId, entityTools: _eT, entityToolsOpenAiFormat: _eTF,
            entityInstructions: _eI, agentContext: _aC, invocationType: _iT, primaryModel: _pM,
            configuredReasoningEffort: _cRE, ...safeToolArgs } = toolArgs;
        const toolResult = await withTimeout(
            callTool(toolFunction, { ...args, ...safeToolArgs, toolFunction, chatHistory: toolMessages, stream: false, useMemory: false }, entityTools, resolver),
            toolTimeout,
            `Tool ${toolName} timed out after ${toolTimeout / 1000}s`
        );

        toolMessages.push({ role: "assistant", content: "", tool_calls: [buildToolCallEntry(toolCall, toolArgs)] });

        let toolResultContent;
        if (typeof toolResult === 'string') toolResultContent = toolResult;
        else if (typeof toolResult?.result === 'string') toolResultContent = toolResult.result;
        else if (toolResult?.result !== undefined) toolResultContent = JSON.stringify(toolResult.result);
        else toolResultContent = JSON.stringify(toolResult);

        toolMessages.push({ role: "tool", tool_call_id: toolCall.id, name: toolName, content: toolResultContent });
        resolver.toolCallCache?.set(cacheKey, toolResultContent);

        const errorMessage = detectToolError(toolResult, toolName);
        const hasError = errorMessage !== null;

        if (!hideExecution) {
            try { await sendToolFinish(rid, toolCallId, !hasError, errorMessage, toolName); } catch { /* non-fatal */ }
        }

        logEvent(rid, 'tool.exec', {
            tool: toolName, round: (resolver.toolCallRound || 0) + 1, durationMs: Date.now() - toolStart,
            success: !hasError, ...(hasError && { error: errorMessage }),
            resultChars: toolResultContent?.length || 0, ...(toolResultContent?.length > MAX_TOOL_RESULT_LENGTH && { truncated: true }),
            toolArgs: summarizeReturnedCalls([toolCall])?.[0]?.args,
        });

        return { success: !hasError, result: toolResult, error: errorMessage, toolCall, toolArgs, toolFunction, messages: toolMessages };
    } catch (error) {
        logEvent(rid, 'tool.exec', {
            tool: toolCall?.function?.name || 'unknown', round: (resolver.toolCallRound || 0) + 1,
            durationMs: Date.now() - toolStart, success: false, error: error.message, timeout: !!error.message?.includes('timed out'),
        });
        const hideExec = entityTools[toolFunction]?.definition?.hideExecution === true;
        if (!hideExec) { try { await sendToolFinish(rid, toolCallId, false, error.message, toolCall?.function?.name || null); } catch { /* non-fatal */ } }

        const errorMessages = cloneMessages(preToolCallMessages);
        const errEntry = {
            id: toolCall?.id, type: "function",
            function: { name: toolCall?.function?.name || toolFunction, arguments: typeof toolCall?.function?.arguments === 'string' ? toolCall.function.arguments : JSON.stringify(toolCall?.function?.arguments || {}) }
        };
        if (toolCall?.thoughtSignature) errEntry.thoughtSignature = toolCall.thoughtSignature;
        errorMessages.push({ role: "assistant", content: "", tool_calls: [errEntry] });
        errorMessages.push({ role: "tool", tool_call_id: toolCall?.id || toolCallId, name: toolCall?.function?.name || toolFunction, content: `Error: ${error.message}` });
        return {
            success: false, error: error.message, toolCall,
            toolArgs: toolCall?.function?.arguments ? (typeof toolCall.function.arguments === 'string' ? (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })() : toolCall.function.arguments) : {},
            toolFunction, messages: errorMessages
        };
    }
}

async function processToolCallRound(toolCalls, args, resolver, entityTools) {
    const preToolCallMessages = cloneMessages(args.chatHistory || []);
    let finalMessages = cloneMessages(preToolCallMessages);
    const rid = getRequestId(resolver);

    if (!toolCalls || toolCalls.length === 0) return { messages: finalMessages, budgetExhausted: false };

    if (resolver.toolBudgetUsed >= TOOL_BUDGET) {
        finalMessages = insertSystemMessage(finalMessages, "Tool budget exhausted - no more tool calls will be executed. Provide your response based on the information gathered so far.", rid);
        args.chatHistory = finalMessages;
        return { messages: finalMessages, budgetExhausted: true };
    }

    const invalidToolCalls = toolCalls.filter(tc => !tc || !tc.function || !tc.function.name);
    if (invalidToolCalls.length > 0) {
        logEvent(rid, 'tool.round', { round: (resolver.toolCallRound || 0) + 1, invalidCount: invalidToolCalls.length, budgetExhausted: true });
        resolver.toolBudgetUsed = TOOL_BUDGET;
        args.chatHistory = finalMessages;
        return { messages: finalMessages, budgetExhausted: true };
    }

    const validToolCalls = toolCalls.filter(tc => tc && tc.function && tc.function.name);
    const setGoalsCalls = validToolCalls.filter(tc => tc.function.name.toLowerCase() === SET_GOALS_TOOL_NAME);
    const realToolCalls = validToolCalls.filter(tc => tc.function.name.toLowerCase() !== SET_GOALS_TOOL_NAME);

    const setGoalsResults = interceptSetGoals(setGoalsCalls, preToolCallMessages, resolver);
    const toolResults = await Promise.all(realToolCalls.map(tc => executeSingleTool(tc, preToolCallMessages, args, resolver, entityTools)));
    const allToolResults = [...setGoalsResults, ...toolResults];

    finalMessages.push(...mergeParallelToolResults(allToolResults, preToolCallMessages));

    // Budget & round accounting
    const budgetCost = allToolResults.reduce((sum, r) => {
        if (r.skipBudget) return sum;
        const def = entityTools[r.toolFunction]?.definition;
        return sum + Math.max(1, def?.toolCost ?? DEFAULT_TOOL_COST);
    }, 0);
    resolver.toolBudgetUsed = (resolver.toolBudgetUsed || 0) + budgetCost;
    resolver.toolCallRound = (resolver.toolCallRound || 0) + 1;

    logEvent(rid, 'tool.round', { round: resolver.toolCallRound, toolCount: validToolCalls.length, failed: allToolResults.filter(r => r && !r.success).length, budgetUsed: resolver.toolBudgetUsed, budgetTotal: TOOL_BUDGET });

    // Pulse tool activity
    if (args.invocationType === 'pulse') {
        if (!resolver.pulseToolActivity) resolver.pulseToolActivity = [];
        for (const r of allToolResults) {
            const argsStr = JSON.stringify(r.toolArgs || {});
            const argsSummary = argsStr.length > 300 ? argsStr.slice(0, 200) + '...' + argsStr.slice(-100) : argsStr;
            let resultStr = r.error ? `ERROR: ${r.error}` : (() => {
                const raw = typeof r.result?.result === 'string' ? r.result.result : JSON.stringify(r.result?.result ?? 'ok');
                return raw.length > 400 ? raw.slice(0, 200) + ' [...] ' + raw.slice(-200) : raw;
            })();
            resolver.pulseToolActivity.push(`${r.toolFunction}(${argsSummary}) → ${resultStr}`);
        }
    }

    // Truncate oversized results
    let processedMessages = finalMessages.map(msg =>
        (msg.role === 'tool' && msg.content && msg.content.length > MAX_TOOL_RESULT_LENGTH)
            ? { ...msg, content: msg.content.substring(0, MAX_TOOL_RESULT_LENGTH) + '\n\n[Content truncated due to length]' }
            : msg
    );

    // Dehydrate (single-model only)
    if (!args.toolLoopModel) {
        for (const msg of processedMessages) {
            if (msg.role === 'tool' && msg.tool_call_id && msg.content && msg.content.length > COMPRESSION_THRESHOLD && !resolver.toolResultStore.has(msg.tool_call_id)) {
                resolver.toolResultStore.set(msg.tool_call_id, { toolName: msg.name || 'unknown', fullContent: msg.content, charCount: msg.content.length, round: resolver.toolCallRound, compressed: false });
            }
        }
        processedMessages = compressOlderToolResults(processedMessages, resolver.toolResultStore, resolver.toolCallRound, entityTools);
    }

    // Context compression
    try { processedMessages = await compressContextIfNeeded(processedMessages, resolver, args); }
    catch (e) { logEventError(rid, 'request.error', { phase: 'compression', error: e.message }); }

    args.chatHistory = processedMessages;
    resolver.errors = [];
    return { messages: processedMessages, budgetExhausted: resolver.toolBudgetUsed >= TOOL_BUDGET };
}

// ─── Context Management ──────────────────────────────────────────────────────

function estimateTokens(messages) {
    if (!messages || !Array.isArray(messages)) return 0;
    let total = 0;
    for (const msg of messages) {
        total += 4;
        if (typeof msg.content === 'string') {
            total += encode(msg.content).length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (typeof part === 'string') total += encode(part).length;
                else if (part?.text) total += encode(part.text).length;
                else if (part?.type === 'image_url') total += 85;
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += 10;
                if (tc.function?.name) total += encode(tc.function.name).length;
                if (tc.function?.arguments) total += encode(tc.function.arguments).length;
            }
        }
    }
    return total;
}

function findSafeSplitPoint(messages, keepRecentCount = 6) {
    const toolCallIndexMap = new Map();
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].tool_calls) {
            for (const tc of messages[i].tool_calls) {
                if (tc.id) toolCallIndexMap.set(tc.id, i);
            }
        }
    }
    let splitIndex = Math.max(0, messages.length - keepRecentCount);
    let adjusted = true;
    while (adjusted && splitIndex > 0) {
        adjusted = false;
        for (let i = splitIndex; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'tool' && msg.tool_call_id) {
                const callIndex = toolCallIndexMap.get(msg.tool_call_id);
                if (callIndex !== undefined && callIndex < splitIndex) {
                    splitIndex = callIndex;
                    adjusted = true;
                    break;
                }
            }
        }
    }
    return splitIndex;
}

export function sliceByTurns(messages, maxTurns = 10) {
    if (!messages || messages.length === 0) return messages;

    // Find the index of the user message that starts the oldest kept turn.
    // Each user message begins a new turn. Walk backwards counting them.
    let turnCount = 0;
    let cutIndex = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            turnCount++;
            if (turnCount <= maxTurns) {
                cutIndex = i; // tentatively start here
            } else {
                break;
            }
        }
    }

    let sliced = messages.slice(cutIndex);

    // Normalize stringified tool_calls from GraphQL [String] schema into objects
    // so all downstream consumers (compression, token estimation, plan stripping)
    // can safely access .function.name without crashing.
    for (const msg of sliced) {
        if (msg.tool_calls) {
            msg.tool_calls = msg.tool_calls.map(tc => typeof tc === 'string' ? JSON.parse(tc) : tc);
        }
    }

    // Build a tool_call_id → index map for the kept window
    const toolCallIndexMap = new Map();
    for (let i = 0; i < sliced.length; i++) {
        if (sliced[i].tool_calls) {
            for (const tc of sliced[i].tool_calls) {
                if (tc.id) toolCallIndexMap.set(tc.id, i);
            }
        }
    }

    // Filter orphaned tool responses — tool messages whose tool_call_id
    // doesn't match any assistant message's tool_calls in the kept window
    sliced = sliced.filter(msg => {
        if (msg.role !== 'tool' || !msg.tool_call_id) return true;
        return toolCallIndexMap.has(msg.tool_call_id);
    });

    return sliced;
}

function formatMessagesForCompression(messages) {
    let text = '';
    for (const msg of messages) {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            const toolsText = msg.tool_calls.map(tc => {
                const name = tc.function?.name || 'unknown';
                let a = tc.function?.arguments || '{}';
                try {
                    const parsed = JSON.parse(a);
                    const userMsg = parsed.userMessage || parsed.q || '';
                    a = userMsg ? `Goal: ${userMsg}` : JSON.stringify(parsed, null, 2);
                } catch { /* keep as is */ }
                return `Tool: ${name}\n${a}`;
            }).join('\n\n');
            text += `[Tool Calls]:\n${toolsText}\n\n`;
        } else if (msg.role === 'tool') {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            text += `[Tool Result - ${msg.name || 'unknown'}]:\n${content}\n\n`;
        } else if (msg.role === 'user') {
            const content = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';
            if (content && !content.startsWith('[system message')) text += `[User]: ${content}\n\n`;
        }
    }
    return text;
}

async function compressContextIfNeeded(messages, resolver, args) {
    let maxTokens = DEFAULT_MODEL_CONTEXT_LIMIT;
    if (resolver.modelExecutor?.plugin?.getModelMaxPromptTokens) {
        try { maxTokens = resolver.modelExecutor.plugin.getModelMaxPromptTokens(); } catch { /* use default */ }
    }
    const currentTokens = estimateTokens(messages);
    if (currentTokens <= maxTokens * CONTEXT_COMPRESSION_THRESHOLD) return messages;

    const rid = getRequestId(resolver);
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const splitIndex = findSafeSplitPoint(nonSystemMessages);
    if (splitIndex < 3) return messages;

    const toCompress = nonSystemMessages.slice(0, splitIndex);
    const toKeep = nonSystemMessages.slice(splitIndex);
    if (toCompress.filter(m => m.tool_calls || m.role === 'tool').length < 2) return messages;

    let originalQuery = null;
    for (const msg of toCompress) {
        if (msg.role === 'user') {
            const content = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';
            if (content && !content.startsWith('[system message') && !content.startsWith('[Context Summary')) { originalQuery = content; break; }
        }
    }

    const compressId = `compress-${Date.now()}`;
    try { await sendToolStart(rid, compressId, '🗜️', 'Compacting conversation context...', 'ContextCompression'); } catch { /* continue */ }

    try {
        const summary = await withTimeout(
            callPathway('sys_compress_context', { ...args, researchContent: formatMessagesForCompression(toCompress), stream: false }, resolver),
            60000, 'Context compression timed out'
        );

        const summaryText = typeof summary === 'string' ? summary : JSON.stringify(summary);
        const toolCallCount = toCompress.filter(m => m.tool_calls).length;
        const toolResultCount = toCompress.filter(m => m.role === 'tool').length;
        const contextSummary = `[Context Summary: The following summarizes ${toolCallCount} tool calls and ${toolResultCount} results from earlier in this conversation. Key findings, URLs, and citations have been preserved.]\n\n${summaryText}`;

        const toolCallsInKeep = new Set();
        for (const msg of toKeep) { if (msg.tool_calls) for (const tc of msg.tool_calls) if (tc.id) toolCallsInKeep.add(tc.id); }
        const validatedToKeep = toKeep.filter(msg => !(msg.role === 'tool' && msg.tool_call_id && !toolCallsInKeep.has(msg.tool_call_id)));

        const compressed = [
            ...systemMessages,
            ...(originalQuery ? [{ role: 'user', content: originalQuery }] : []),
            { role: 'user', content: contextSummary },
            ...validatedToKeep
        ];

        logEvent(rid, 'compression', { type: 'context', beforeTokens: currentTokens, afterTokens: estimateTokens(compressed), pctOfLimit: Math.round((currentTokens / maxTokens) * 100), toolMsgCount: toCompress.filter(m => m.tool_calls || m.role === 'tool').length });
        await sendToolFinish(rid, compressId, true, null, 'ContextCompression');
        return compressed;
    } catch (error) {
        logEventError(rid, 'request.error', { phase: 'compression', error: error.message });
        await sendToolFinish(rid, compressId, false, error.message, 'ContextCompression');
        return messages;
    }
}

// ─── Plan Management ─────────────────────────────────────────────────────────

function stripSetGoalsFromHistory(chatHistory) {
    const ids = new Set();
    for (const msg of chatHistory) {
        if (msg.tool_calls) for (const tc of msg.tool_calls) if (tc.function?.name?.toLowerCase() === SET_GOALS_TOOL_NAME) ids.add(tc.id);
    }
    if (ids.size === 0) return chatHistory;
    return chatHistory.map(msg => {
        if (msg.tool_calls) {
            const filtered = msg.tool_calls.filter(tc => !ids.has(tc.id));
            if (filtered.length === 0 && msg.tool_calls.length > 0) return null;
            return { ...msg, tool_calls: filtered };
        }
        if (msg.role === 'tool' && ids.has(msg.tool_call_id)) return null;
        return msg;
    }).filter(Boolean);
}

// ─── Error Handling ──────────────────────────────────────────────────────────

async function generateErrorResponse(error, args, resolver) {
    const errorMessage = error?.message || error?.toString() || String(error);
    resolver.errors = [];
    try {
        return await callPathway('sys_generator_error', { ...args, text: errorMessage, chatHistory: args.chatHistory || [], stream: false }, resolver);
    } catch (e) {
        logger.error(`Error generating error response: ${e.message}`);
        return `I apologize, but I encountered an error while processing your request: ${errorMessage}. Please try again or contact support if the issue persists.`;
    }
}

// ─── Tool Callback ───────────────────────────────────────────────────────────

function preservePriorText(message, args) {
    const priorText = message instanceof CortexResponse ? message.output_text : (typeof message?.content === 'string' ? message.content : '');
    if (priorText?.trim()) {
        args.chatHistory = [...(args.chatHistory || []), { role: 'assistant', content: priorText }];
    }
}

async function runFallbackPath(currentToolCalls, args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    await processToolCallRound(currentToolCalls, args, resolver, entityTools);
    await say(getRequestId(resolver), `\n`, 1000, false, false);

    try {
        // Restore full tool outputs before the final model call.
        if (resolver.toolResultStore && resolver.toolResultStore.size > 0) {
            args.chatHistory = rehydrateAllToolResults(args.chatHistory, resolver.toolResultStore);
        }

        // Dehydrate tool history onto pathwayResultData before fallback streams the final info block
        const startIdx = resolver._preToolHistoryLength || 0;
        const toolHistory = dehydrateToolHistory(args.chatHistory, entityTools, startIdx);
        if (toolHistory.length > 0) {
            resolver.pathwayResultData = { ...(resolver.pathwayResultData || {}), toolHistory };
        }

        let fallbackResult = await callModelLogged(resolver, {
            ...args, modelOverride: args.primaryModel, stream: args.stream, tools: entityToolsOpenAiFormat,
            tool_choice: "auto", reasoningEffort: args.configuredReasoningEffort || 'low', skipMemoryLoad: true,
        }, 'fallback', { model: args.primaryModel });

        if (!fallbackResult) return await handlePromptError(null);

        const holder = { value: fallbackResult };
        await drainStreamingCallbacks(resolver)(holder);
        return holder.value;
    } catch (e) {
        return await handlePromptError(e);
    }
}

async function enforceGate(currentToolCalls, args, resolver, entityToolsOpenAiFormat, callbackDepth, handlePromptError) {
    let gateRetries = 0;
    while (currentToolCalls.length > 0 && !passesGate(currentToolCalls)) {
        if (gateRetries >= MAX_GATE_RETRIES) {
            logEvent(getRequestId(resolver), 'plan.skipped', { reason: 'gate_retries_exhausted' });
            currentToolCalls = [];
            break;
        }
        gateRetries++;
        logEvent(getRequestId(resolver), 'plan.skipped', { reason: 'missing_setgoals', gateRetry: gateRetries });
        args.chatHistory = insertSystemMessage(args.chatHistory,
            'Your tool calls were discarded because they did not include SetGoals. You MUST call SetGoals alongside your other tool calls to establish a plan. Try again.',
            getRequestId(resolver)
        );
        try {
            const gateResult = await callModelLogged(resolver, {
                ...args, modelOverride: args.primaryModel, stream: false,
                tools: [...entityToolsOpenAiFormat, SET_GOALS_OPENAI_DEF],
                tool_choice: "auto", reasoningEffort: args.configuredReasoningEffort || 'medium', skipMemoryLoad: true,
            }, 'gate_retry', { model: args.primaryModel, callbackDepth });
            if (!gateResult) return { toolCalls: currentToolCalls, error: await handlePromptError(null) };
            currentToolCalls = extractToolCalls(gateResult);
        } catch (e) {
            return { toolCalls: currentToolCalls, error: await handlePromptError(e) };
        }
    }
    return { toolCalls: currentToolCalls, error: null };
}

async function executorLoop(args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    while (resolver.toolBudgetUsed < TOOL_BUDGET) {
        const rid = getRequestId(resolver);
        if (resolver.toolPlan) logEvent(rid, 'plan.step', { round: resolver.toolCallRound || 0, steps: resolver.toolPlan.steps.length });
        args.chatHistory = insertSystemMessage(args.chatHistory, buildStepInstruction(resolver), rid);

        try {
            const result = await callModelLogged(resolver, {
                ...args, modelOverride: args.toolLoopModel, stream: false, tools: entityToolsOpenAiFormat,
                tool_choice: "auto", reasoningEffort: 'low', skipMemoryLoad: true,
            }, 'tool_loop', { model: args.toolLoopModel, round: resolver.toolCallRound, hasPlan: !!resolver.toolPlan });

            if (!result) return await handlePromptError(null);
            const calls = extractToolCalls(result);
            if (calls.length === 0) break; // SYNTHESIZE

            const { budgetExhausted } = await processToolCallRound(calls, args, resolver, entityTools);
            if (budgetExhausted) break;
        } catch (e) {
            return await handlePromptError(e);
        }
    }
    return null;
}

function prepareForSynthesis(args, resolver) {
    const rid = getRequestId(resolver);
    // Strip SYNTHESIZE hints
    args.chatHistory = args.chatHistory.filter(msg => {
        if (msg.role !== 'user') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return !content.startsWith(`[system message: ${rid}]`);
    });
    args.chatHistory = stripSetGoalsFromHistory(args.chatHistory);
    if (resolver.toolPlan) {
        args.chatHistory = insertSystemMessage(args.chatHistory,
            `Review the tool results above against your todo list (Goal: ${resolver.toolPlan.goal}).\nIf results are sufficient, respond to the user.\nIf the approach failed or you need a different strategy, call SetGoals with a new todo list (and optionally other tools) — the items will be executed by the tool loop.`,
            rid
        );
    }
}

async function callSynthesis(args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError) {
    await say(getRequestId(resolver), `\n`, 1000, false, false);
    const synthesisTools = [...entityToolsOpenAiFormat, SET_GOALS_OPENAI_DEF];

    try {
        let synthesisResult = await callModelLogged(resolver, {
            ...args, modelOverride: args.primaryModel, stream: args.stream, tools: synthesisTools,
            tool_choice: "auto", reasoningEffort: args.configuredReasoningEffort || 'medium', skipMemoryLoad: true,
        }, 'synthesis', { model: args.primaryModel, replanCount: resolver.replanCount || 0, callbackDepth });

        if (!synthesisResult) return { result: await handlePromptError(null), done: true };

        const holder = { value: synthesisResult };
        const hadStreamingCallback = await drainStreamingCallbacks(resolver)(holder);
        synthesisResult = holder.value;

        const synthToolCalls = extractToolCalls(synthesisResult);
        // Update model.result log with streaming info
        if (hadStreamingCallback) {
            logEvent(getRequestId(resolver), 'model.result', {
                model: args.primaryModel, purpose: 'synthesis', streamingCallback: true, hasPlan: !!resolver.toolPlan, callbackDepth,
            });
        }

        if (synthToolCalls.length === 0 || hadStreamingCallback) return { result: synthesisResult, done: true };

        // Non-streaming tool_calls from synthesis
        const isReplan = passesGate(synthToolCalls);
        if (isReplan && (resolver.replanCount || 0) < MAX_REPLAN_SAFETY_CAP) {
            resolver.replanCount = (resolver.replanCount || 0) + 1;
            logEvent(getRequestId(resolver), 'plan.replan', { replanCount: resolver.replanCount, tools: summarizeReturnedCalls(synthToolCalls) });
            return { result: null, done: false, toolCalls: synthToolCalls };
        } else {
            logEvent(getRequestId(resolver), 'plan.continuation', { tools: summarizeReturnedCalls(synthToolCalls) });
            await processToolCallRound(synthToolCalls, args, resolver, entityTools);
            return { result: synthesisResult, done: true };
        }
    } catch (e) {
        return { result: await handlePromptError(e), done: true };
    }
}

async function runDualModelPath(currentToolCalls, args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError) {
    if (typeof resolver.replanCount !== 'number') resolver.replanCount = 0;

    // No depth cap: the tool budget already prevents runaway loops, and duplicate
    // detection catches repeated calls. If the synthesis model wants to spend rounds
    // calling tools at any nesting level, let it — as long as budget holds.

    // Gate (initial call only — nested callbacks already passed the gate)
    if (callbackDepth <= 1) {
        const gateResult = await enforceGate(currentToolCalls, args, resolver, entityToolsOpenAiFormat, callbackDepth, handlePromptError);
        if (gateResult.error) return gateResult.error;
        currentToolCalls = gateResult.toolCalls;
    }

    // Main loop: process → executor → synthesis → maybe replan
    let synthesisResult;
    while (true) {
        if (currentToolCalls.length > 0) {
            const { budgetExhausted } = await processToolCallRound(currentToolCalls, args, resolver, entityTools);
            if (budgetExhausted) currentToolCalls = [];
        }

        // Strip SetGoals from executor context
        for (const msg of args.chatHistory) {
            if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('SetGoals')) {
                msg.content = msg.content.replace(/IMPORTANT:.*?2-5 items\.\n\n/s, '');
                break;
            }
        }
        args.chatHistory = stripSetGoalsFromHistory(args.chatHistory);

        const loopErr = await executorLoop(args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError);
        if (loopErr) return loopErr;

        prepareForSynthesis(args, resolver);

        // Dehydrate tool history onto pathwayResultData before synthesis streams the final info block
        const startIdx = resolver._preToolHistoryLength || 0;
        const toolHistory = dehydrateToolHistory(args.chatHistory, entityTools, startIdx);
        if (toolHistory.length > 0) {
            resolver.pathwayResultData = { ...(resolver.pathwayResultData || {}), toolHistory };
        }

        const synthResult = await callSynthesis(args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError);
        if (synthResult.done) { synthesisResult = synthResult.result; break; }
        currentToolCalls = synthResult.toolCalls;
    }

    logRequestEnd(resolver);
    return synthesisResult;
}

// ─── Execute Pathway ─────────────────────────────────────────────────────────

function loadEntityContext(entityConfig, args, resolver) {
    const entityName = entityConfig?.name;
    const entityInstructions = entityConfig?.identity || entityConfig?.instructions || '';
    const entityAllowsMemory = entityConfig?.useMemory !== false;
    const inputAllowsMemory = args.useMemory !== false;
    const useContinuityMemory = entityAllowsMemory && inputAllowsMemory;
    const modelOverride = entityConfig?.modelOverride ?? args.modelOverride;
    const toolLoopModel = config.get('models')?.[TOOL_LOOP_MODEL] ? TOOL_LOOP_MODEL : null;
    return { entityName, entityInstructions, useContinuityMemory, modelOverride, toolLoopModel };
}

function buildPromptTemplate(entityConfig, entityToolsOpenAiFormat, entityInstructions, useContinuityMemory, voiceResponse, isPulse) {
    const entityDNA = useContinuityMemory
        ? `{{renderTemplate AI_CONTINUITY_CONTEXT}}\n\n`
        : (entityInstructions ? entityInstructions + '\n\n' : '');

    const commonInstructionsTemplate = entityConfig?.isSystem
        ? `{{renderTemplate AI_COMMON_INSTRUCTIONS_TEXT}}`
        : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}`;
    const instructionTemplates = `${commonInstructionsTemplate}\n{{renderTemplate AI_WORKSPACE}}\n${entityDNA}{{renderTemplate AI_EXPERTISE}}\n\n`;
    const searchRulesTemplate = `{{renderTemplate AI_SEARCH_RULES}}\n\n`;

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

    const toolsTemplate = entityToolsOpenAiFormat.length > 0 ? '{{renderTemplate AI_TOOLS}}\n\n' : '';
    const planInstruction = entityToolsOpenAiFormat.length > 0
        ? `IMPORTANT: If you call ANY tools, you MUST include SetGoals in the same response. Tool calls without SetGoals will be discarded. SetGoals is your todo list — not sequential steps but everything that needs to happen before you're done. Each item should be a specific outcome to achieve, not a procedure to follow. 2-5 items.\n\n`
        : '';

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

Use /workspace/scratchpad.md for notes during this wake — what you're working
on, intermediate findings, next steps. The scratchpad is cleared when you call
EndPulse, so it's for within-wake context only. For anything you want to
persist across wakes, save it to a named file (e.g. /workspace/journal.md,
/workspace/project_notes.md). Your conversation context may be compacted
during long tasks — the scratchpad helps you track state within a single wake.

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

    return [
        {"role": "system", "content": `${instructionTemplates}${toolsTemplate}${planInstruction}${searchRulesTemplate}${voiceInstructions}${pulseInstructions}{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}\n\n{{renderTemplate AI_AVAILABLE_FILES}}\n\n{{renderTemplate AI_DATETIME}}`},
        "{{chatHistory}}",
    ];
}

function extractUserMessage(args) {
    let userMessage = args.text || '';
    if (!userMessage && args.chatHistory?.length > 0) {
        for (let i = args.chatHistory.length - 1; i >= 0; i--) {
            const msg = args.chatHistory[i];
            if (msg?.role === 'user') {
                const content = msg.content;
                if (typeof content === 'string') {
                    if (!content.trim().startsWith('{') || !content.includes('"success"')) { userMessage = content; break; }
                } else if (Array.isArray(content)) {
                    const textItem = content.find(c => typeof c === 'string' || c?.type === 'text');
                    if (textItem) { userMessage = typeof textItem === 'string' ? textItem : textItem.text; break; }
                }
            }
        }
    }
    return userMessage;
}

async function recordPulseMemory(resolver, args, response, entityName, entityInstructions) {
    const rid = getRequestId(resolver);
    try {
        const continuityService = getContinuityMemoryService();
        if (!continuityService.isAvailable()) return;

        const assistantResponse = extractResponseText(response);

        let activityNarrative = null;
        if (resolver.pulseToolActivity?.length > 0) {
            try {
                activityNarrative = await callPathway('sys_continuity_pulse_activity_summary', {
                    aiName: args.aiName || entityName || 'Entity', toolActivity: resolver.pulseToolActivity.join('\n')
                }, resolver);
            } catch (e) { logEventError(rid, 'request.error', { phase: 'pulse_activity_summary', error: e.message }); }
        }

        continuityService.recordPulseTurn(resolver.continuityEntityId, { role: 'user', content: (args.text || 'Pulse wake').substring(0, 2000), timestamp: new Date().toISOString() });
        if (activityNarrative) continuityService.recordPulseTurn(resolver.continuityEntityId, { role: 'assistant', content: activityNarrative.substring(0, 5000), timestamp: new Date().toISOString() });
        if (assistantResponse) continuityService.recordPulseTurn(resolver.continuityEntityId, { role: 'assistant', content: assistantResponse.substring(0, 5000), timestamp: new Date().toISOString() });

        continuityService.triggerPulseSynthesis(resolver.continuityEntityId, { aiName: args.aiName || entityName || 'Entity', entityContext: entityInstructions });
        logEventDebug(rid, 'memory.record', { type: 'pulse', activityChars: activityNarrative?.length || 0, assistantChars: assistantResponse?.length || 0 });
    } catch (error) {
        logEventError(rid, 'request.error', { phase: 'pulse_memory', error: error.message });
    }
}

async function recordConversationMemory(resolver, args, response, entityName, entityInstructions) {
    const rid = getRequestId(resolver);
    try {
        const continuityService = getContinuityMemoryService();
        if (!continuityService.isAvailable()) return;

        const userMessage = extractUserMessage(args);
        let assistantResponse = '';
        if (response && typeof response.on === 'function') {
            assistantResponse = resolver.streamedContent || '';
        } else {
            assistantResponse = extractResponseText(response);
        }

        if (userMessage) {
            continuityService.recordTurn(resolver.continuityEntityId, resolver.continuityUserId, { role: 'user', content: userMessage, timestamp: new Date().toISOString() });
        }
        if (assistantResponse) {
            continuityService.recordTurn(resolver.continuityEntityId, resolver.continuityUserId, { role: 'assistant', content: assistantResponse.substring(0, 5000), timestamp: new Date().toISOString() });
        }
        continuityService.triggerSynthesis(resolver.continuityEntityId, resolver.continuityUserId, { aiName: args.aiName || entityName || 'Entity', entityContext: entityInstructions });
        logEventDebug(rid, 'memory.record', { type: 'continuity', userChars: userMessage?.length || 0, assistantChars: assistantResponse?.length || 0 });
    } catch (error) {
        logEventError(rid, 'request.error', { phase: 'continuity_memory', error: error.message });
    }
}

// ─── Default Export ──────────────────────────────────────────────────────────

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    enableDuplicateRequests: false,
    useSingleTokenStream: false,
    manageTokenLength: false,
    inputParameters: {
        privateData: false,
        chatHistory: [{role: '', content: []}],
        agentContext: [{ contextId: ``, contextKey: ``, default: true }],
        chatId: ``,
        language: "English",
        aiName: "Jarvis",
        title: ``,
        messages: [],
        voiceResponse: false,
        voiceProviderInstructions: '',
        codeRequestId: ``,
        skipCallbackMessage: false,
        entityId: ``,
        userInfo: '',
        model: 'oai-gpt41',
        useMemory: true,
        invocationType: '',
    },
    timeout: 600,

    toolCallback: async (args, message, resolver) => {
        if (!args || !message || !resolver) return;

        const { entityTools, entityToolsOpenAiFormat } = args;
        resolver.toolBudgetUsed = resolver.toolBudgetUsed || 0;
        resolver.toolCallRound = resolver.toolCallRound || 0;
        if (!resolver.toolResultStore) resolver.toolResultStore = new Map();
        if (!resolver.toolCallCache) resolver.toolCallCache = new Map();

        resolver._callbackDepth = (resolver._callbackDepth || 0) + 1;
        const callbackDepth = resolver._callbackDepth;

        let currentToolCalls = extractToolCalls(message);
        const rid = getRequestId(resolver);
        logEvent(rid, 'callback.entry', { depth: callbackDepth, incomingToolCalls: summarizeReturnedCalls(currentToolCalls), hasPlan: !!resolver.toolPlan, budgetUsed: resolver.toolBudgetUsed });

        if (currentToolCalls.length > 0) preservePriorText(message, args);

        const handlePromptError = makeErrorHandler(args, resolver);

        if (args.toolLoopModel) {
            return await runDualModelPath(currentToolCalls, args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError);
        }

        // Fallback: single-model path
        return await runFallbackPath(currentToolCalls, args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError);
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { entityId, voiceResponse, chatId, invocationType } = { ...resolver.pathway.inputParameters, ...args };
        const isPulse = invocationType === 'pulse';

        if (isPulse && (!args.agentContext || !args.agentContext.length || !args.agentContext.some(ctx => ctx?.contextId))) {
            args.agentContext = [{ contextId: entityId, contextKey: null, default: true }];
        }

        const entityConfig = await loadEntityConfig(entityId);
        const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig, { invocationType });
        const { entityName, entityInstructions, useContinuityMemory, modelOverride, toolLoopModel } = loadEntityContext(entityConfig, args, resolver);

        if (!args.chatHistory || args.chatHistory.length === 0) args.chatHistory = [];

        // Attach entity resources to last user message
        const entityResources = entityConfig?.resources || entityConfig?.files || [];
        if (entityResources.length > 0) {
            let lastUserMessage = args.chatHistory.filter(message => message.role === "user").slice(-1)[0];
            if (!lastUserMessage) {
                lastUserMessage = { role: "user", content: [] };
                args.chatHistory.push(lastUserMessage);
            }
            if (!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = lastUserMessage.content ? [lastUserMessage.content] : [];
            }
            lastUserMessage.content.push(...entityResources.map(resource => ({
                type: "image_url", gcs: resource?.gcs, url: resource?.url,
                image_url: { url: resource?.url }, originalFilename: resource?.name
            })));
        }

        const userInfo = args.userInfo || '';
        args = {
            ...args, ...config.get('entityConstants'),
            entityId, entityTools, entityToolsOpenAiFormat, entityInstructions,
            voiceResponse, chatId, userInfo, hasWorkspace: !!entityTools.workspacessh,
        };
        resolver.args = {...args};

        const promptMessages = buildPromptTemplate(entityConfig, entityToolsOpenAiFormat, entityInstructions, useContinuityMemory, voiceResponse, isPulse);
        resolver.pathwayPrompt = [new Prompt({ messages: promptMessages })];

        const reasoningEffort = entityConfig?.reasoningEffort || 'low';

        args.chatHistory = sliceByTurns(args.messages && args.messages.length > 0 ? args.messages : args.chatHistory);

        const { chatHistory: strippedHistory, availableFiles } = await syncAndStripFilesFromChatHistory(args.chatHistory, args.agentContext, chatId, entityId);
        args.chatHistory = strippedHistory;

        const rid = getRequestId(resolver);
        try { args.chatHistory = await compressContextIfNeeded(args.chatHistory, resolver, args); }
        catch (e) { logEventError(rid, 'request.error', { phase: 'compression', error: e.message }); }

        args.configuredReasoningEffort = reasoningEffort;
        args.toolLoopModel = toolLoopModel;
        args.primaryModel = modelOverride || resolver.modelName;
        resolver.args = {...args};

        const requestStartTime = Date.now();
        resolver.requestStartTime = requestStartTime;
        logEvent(rid, 'request.start', {
            entity: entityId, model: modelOverride || resolver.modelName, stream: args.stream, invocationType,
            ...(toolLoopModel && { toolLoopModel }), reasoningEffort,
            entityToolCount: entityToolsOpenAiFormat.length, entityToolNames: summarizeToolNames(entityToolsOpenAiFormat),
        });

        try {
            const hasTools = entityToolsOpenAiFormat.length > 0;
            const firstCallTools = hasTools ? [...entityToolsOpenAiFormat, SET_GOALS_OPENAI_DEF] : entityToolsOpenAiFormat;

            let response = await runAllPrompts({
                ...args, modelOverride, chatHistory: cloneMessages(args.chatHistory), availableFiles,
                stream: args.stream, reasoningEffort: args.configuredReasoningEffort || 'low',
                tools: firstCallTools, tool_choice: "auto"
            });

            if (!response) {
                const errorDetails = resolver.errors.length > 0 ? `: ${resolver.errors.join(', ')}` : '';
                throw new Error(`Model execution returned null - the model request likely failed${errorDetails}`);
            }

            // Drain streaming callbacks from initial call
            const holder = { value: response };
            const hadStreamingCallback = await drainStreamingCallbacks(resolver)(holder);
            response = holder.value;

            logEvent(rid, 'model.result', {
                model: modelOverride || resolver.modelName, purpose: 'initial',
                returnedToolCalls: summarizeReturnedCalls(extractToolCalls(response)),
                streamingCallback: hadStreamingCallback,
                contentChars: (response instanceof CortexResponse ? response.output_text?.length : (typeof response === 'string' ? response.length : 0)) || 0,
            });

            const toolCallback = resolver.pathway.toolCallback;
            resolver._preToolHistoryLength = args.chatHistory.length;
            while (response && (
                (response instanceof CortexResponse && response.hasToolCalls()) ||
                (typeof response === 'object' && response.tool_calls)
            )) {
                try {
                    response = await toolCallback(args, response, resolver);
                    if (!response) throw new Error('Tool callback returned null - a model request likely failed');
                } catch (toolError) {
                    logEventError(rid, 'request.error', { phase: 'tool_callback', error: toolError.message, durationMs: Date.now() - requestStartTime });
                    const errorResponse = await generateErrorResponse(toolError, args, resolver);
                    resolver.errors = [];
                    return errorResponse;
                }
            }

            // Continuity memory recording
            if (isPulse && useContinuityMemory && resolver.continuityEntityId) {
                await recordPulseMemory(resolver, args, response, entityName, entityInstructions);
            } else if (useContinuityMemory && resolver.continuityEntityId && resolver.continuityUserId) {
                await recordConversationMemory(resolver, args, response, entityName, entityInstructions);
            }

            // Safety net: NEVER return an empty response. If every model call, tool
            // execution, and callback produced nothing, we still owe the client a response.
            // Without this, a streaming client hangs forever waiting for text that never arrives.
            if (!extractResponseText(response).trim()) {
                logEventError(rid, 'request.error', { phase: 'empty_response', error: 'All processing completed but no text was produced', durationMs: Date.now() - requestStartTime });
                response = await generateErrorResponse(
                    new Error('I processed your request but wasn\'t able to generate a response. Please try again.'),
                    args, resolver
                );
            }

            if (!resolver._requestEndLogged) {
                const usage = summarizeUsage(resolver.pathwayResultData?.usage);
                logEvent(rid, 'request.end', {
                    durationMs: Date.now() - requestStartTime, toolRounds: resolver.toolCallRound || 0,
                    budgetUsed: resolver.toolBudgetUsed || 0, ...(usage && { tokens: usage }),
                });
            }

            // Final guarantee: close the stream. If streaming produced text normally,
            // the plugin already sent [DONE]. But if it didn't (e.g., model returned
            // only tool_calls, or callbacks swallowed the content), force-close now.
            // Skip for stream objects — asyncResolve.handleStream owns their lifecycle
            // (including error handling and completion). Sending progress:1 here would
            // race ahead of handleStream and mask stream errors.
            if (args.stream && !(response && typeof response.on === 'function')) {
                publishRequestProgress({
                    requestId: rid,
                    progress: 1,
                    data: JSON.stringify(response),
                    info: JSON.stringify(resolver.pathwayResultData || {}),
                    error: resolver.errors?.length > 0 ? resolver.errors.join(', ') : ''
                });
            }

            return response;
        } catch (e) {
            const usage = summarizeUsage(resolver.pathwayResultData?.usage);
            logEventError(rid, 'request.error', { phase: 'executePathway', error: e.message, durationMs: Date.now() - requestStartTime, ...(usage && { tokens: usage }) });
            const errorResponse = await generateErrorResponse(e, args, resolver);
            resolver.errors = [];

            // Close the stream even on error — NEVER leave the client hanging.
            if (args.stream) {
                publishRequestProgress({
                    requestId: rid,
                    progress: 1,
                    data: JSON.stringify(errorResponse),
                    info: JSON.stringify(resolver.pathwayResultData || {}),
                    error: e.message || ''
                });
            }

            return errorResponse;
        }
    }
};
