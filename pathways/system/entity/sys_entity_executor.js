// sys_entity_executor.js
// Shared execution core for the entity runtime tool loop and synthesis flow

// ─── Constants ───────────────────────────────────────────────────────────────

const TOOL_BUDGET = 500;
const DEFAULT_TOOL_COST = 10;
const TOOL_TIMEOUT_MS = 120000;
const MAX_TOOL_RESULT_LENGTH = 150000;
const CONTEXT_COMPRESSION_THRESHOLD = 0.7;
const DEFAULT_MODEL_CONTEXT_LIMIT = 128000;
const TOOL_LOOP_MODEL = 'xai-grok-4-1-fast-non-reasoning';
const MAX_REPLAN_SAFETY_CAP = 10;
const ROUTER_MAX_INPUT_CHARS = 280;
const ROUTER_MAX_RECENT_FILES = 3;
const FAST_CHAT_MAX_TURNS = 3;
const FAST_REACTION_MAX_TURNS = 2;
const FAST_REACTION_MAX_MESSAGES = 4;
const FAST_TOOL_MAX_TURNS = 2;
const FAST_TOOL_MAX_MESSAGES = 8;
const FAST_CHAT_REASONING_EFFORT = 'low';
const LATENCY_PREPARE_REQUESTED_OUTPUT = 'latency_prepare';
const SYNTHESIS_REVIEW_MARKER = '[runtime review]';
const EVIDENCE_LEDGER_MARKER = '[runtime evidence]';
const MAX_CHILD_WORKER_ROUNDS = 3;
const TASK_NOVELTY_STOP_WORDS = new Set([
    'a', 'an', 'and', 'angle', 'angles', 'any', 'around', 'at', 'be', 'beyond',
    'by', 'check', 'checks', 'detail', 'details', 'different', 'do', 'evidence',
    'expand', 'fact', 'facts', 'find', 'for', 'from', 'general', 'get', 'identify',
    'in', 'into', 'is', 'it', 'its', 'jason', 'lookup', 'lookups', 'memory',
    'mentioned', 'more', 'of', 'on', 'or', 'outcome', 'outcomes', 'query',
    'reference', 'references', 'result', 'results', 'scan', 'search', 'specific',
    'task', 'tasks', 'that', 'the', 'their', 'them', 'there', 'these', 'this',
    'those', 'through', 'to', 'up', 'user', 'what', 'who', 'with',
]);
const RESEARCH_DELEGATION_TOOL_CATEGORIES = new Set([
    'memory',
    'web',
]);
const RESEARCH_DELEGATION_TOOL_NAMES = new Set([
    'searchmemory',
    'storecontinuitymemory',
    'searchinternet',
    'searchxplatform',
    'fetchwebpagecontentjina',
    'analyzepdf',
    'analyzevideo',
]);
const RESEARCH_RETRIEVAL_TOOL_NAMES = new Set([
    'searchmemory',
    'searchinternet',
    'searchxplatform',
    'fetchwebpagecontentjina',
    'analyzepdf',
    'analyzevideo',
]);
const TERMINAL_REPLAN_STOP_REASONS = new Set([
    'low_novelty',
    'insufficient_grounding',
    'evidence_cap',
    'tool_budget_cap',
    'research_round_cap',
    'search_cap',
    'fetch_cap',
    'child_cap',
    'repeated_search_cap',
    'per_round_tool_cap',
    'tool_envelope_cap',
]);

const SET_GOALS_TOOL_NAME = 'setgoals';
const DELEGATE_RESEARCH_TOOL_NAME = 'delegateresearch';
const DELEGATE_TASK_TOOL_NAME = 'delegatetask';
const ROUTER_DECISION_TOOL_NAME = 'SelectRoute';
const ROUTER_ALLOWED_MODES = new Set(['plan', 'direct_reply', 'direct_search']);
const ROUTER_ALLOWED_TOOL_CATEGORIES = new Set(['general', 'workspace', 'images', 'web', 'memory', 'media', 'chart']);

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

const DELEGATE_RESEARCH_OPENAI_DEF = {
    type: "function",
    function: {
        name: "DelegateResearch",
        description: "Request another bounded worker research pass when the current evidence is not enough to answer yet. Break missing work into independent sub-tasks that can run in parallel.",
        parameters: {
            type: "object",
            properties: {
                goal: { type: "string", description: "What the worker pass must resolve before the supervisor can answer" },
                tasks: { type: "array", items: { type: "string" }, description: "2-5 concrete missing findings or checks for the worker pass. Prefer orthogonal search angles that can run in parallel rather than one sequential recipe." },
            },
            required: ["goal", "tasks"]
        }
    }
};

const DELEGATE_TASK_OPENAI_DEF = {
    type: "function",
    function: {
        name: "DelegateTask",
        description: "Hand off one bounded serial sub-task to a worker that can use tools until the task is done, blocked, or exhausted. Use this for the next concrete step when parallel fanout is unnecessary.",
        parameters: {
            type: "object",
            properties: {
                goal: { type: "string", description: "What the worker must complete before control returns to the supervisor" },
                task: { type: "string", description: "One concrete task brief for the worker to execute end-to-end" },
            },
            required: ["goal", "task"]
        }
    }
};

const ROUTER_DECISION_OPENAI_DEF = {
    type: 'function',
    function: {
        name: ROUTER_DECISION_TOOL_NAME,
        description: 'Return the route classification for the current user turn.',
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['plan', 'direct_reply', 'direct_search'],
                },
                confidence: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                },
                toolCategory: {
                    type: 'string',
                    enum: ['general', 'workspace', 'images', 'web', 'memory', 'media', 'chart'],
                },
                planningEffort: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                },
                synthesisEffort: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                },
                conversationMode: {
                    type: 'string',
                    enum: ['chat', 'agentic', 'creative', 'research', 'nsfw'],
                },
                modeAction: {
                    type: 'string',
                    enum: ['stay', 'switch'],
                },
                reason: {
                    type: 'string',
                },
                modeReason: {
                    type: 'string',
                },
            },
            required: ['mode', 'confidence', 'toolCategory', 'planningEffort', 'synthesisEffort', 'conversationMode', 'modeAction', 'reason', 'modeReason'],
        },
    },
};

const VOICE_FALLBACKS = {
    'GoogleSearch': 'Let me look that up.',
    'GoogleNews': 'Checking the news.',
    'SearchX': 'Searching for that now.',
    'SearchMemory': 'Checking memory.',
    'CreateMedia': 'Creating that for you.',
    'ShowOverlay': 'Showing that now.',
    'WorkspaceSSH': 'Working on that.',
    'default': 'One moment.'
};

const FINAL_RESPONSE_NEUTRALIZATION_PURPOSES = new Set([
    'synthesis',
    'synthesis_finalize',
    'initial_finalize',
    'fast_chat',
    'fast_finalize',
]);

// ─── Imports ─────────────────────────────────────────────────────────────────

import { callPathway, callTool, say, sendToolStart, sendToolFinish, withTimeout } from '../../../lib/pathwayTools.js';
import { publishRequestProgress } from '../../../lib/redisSubscription.js';
import { encode } from '../../../lib/encodeCache.js';
import logger from '../../../lib/logger.js';
import { logEvent, logEventError, logEventDebug } from '../../../lib/requestLogger.js';
import { config } from '../../../config.js';
import { syncAndStripFilesFromChatHistory } from '../../../lib/fileUtils.js';
import { Prompt } from '../../../server/prompt.js';
import { requestState } from '../../../server/requestState.js';
import { buildNeutralizationInstructionBlock } from '../../../lib/research/styleNeutralization.js';
import { getToolsForEntity, loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import { COMPRESSION_THRESHOLD, compressOlderToolResults, rehydrateAllToolResults, dehydrateToolHistory } from './tools/shared/tool_result_compression.js';
import CortexResponse from '../../../lib/cortexResponse.js';
import { getContinuityMemoryService } from '../../../lib/continuity/index.js';
import {
    applyConversationModeAffiliation,
    ENTITY_RUNTIME_MODE,
    buildPromptCacheHint,
    buildSemanticToolKey,
    extractRecentFileReferences,
    getConversationModeAffiliationPolicy,
    getEntityRuntime,
    getEntityRuntimeStore,
    isEntityRuntimeEnabled,
    normalizeConversationMode,
    normalizeToolFamily,
    routeEntityTurn,
    resolveAuthorityEnvelope,
    resolveEntityModelPolicy,
    safeParseRuntimeValue,
    shortlistToolsForCategory,
    summarizeAuthorityEnvelope,
    summarizeOrientationPacket,
} from '../../../lib/entityRuntime/index.js';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function getRequestId(resolver) {
    return resolver.rootRequestId || resolver.requestId;
}

function getConversationModeLabel(mode = '') {
    const normalized = normalizeConversationMode(mode);
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function publishConversationModeMessage({ resolver, previousMode = '', nextMode = '', reason = '', source = 'router' } = {}) {
    const previous = normalizeConversationMode(previousMode);
    const next = normalizeConversationMode(nextMode);
    if (!resolver || previous === next) return;

    const requestId = getRequestId(resolver);
    const modeMessage = {
        type: 'conversation_mode',
        previousMode: previous,
        mode: next,
        reason: reason || 'mode_switch',
        source,
        label: getConversationModeLabel(next),
    };

    publishRequestProgress({
        requestId,
        progress: 0.15,
        data: '',
        error: '',
        info: JSON.stringify({
            ...(resolver.pathwayResultData || {}),
            modeMessage,
        }),
    });

    resolver.pathwayResultData = {
        ...(resolver.pathwayResultData || {}),
        entityRuntime: {
            ...(resolver.pathwayResultData?.entityRuntime || {}),
            conversationMode: next,
            modeMessage,
        },
    };
}

function normalizeModeConfidence(value = '') {
    return String(value || '').trim().toLowerCase() === 'high' ? 'high' : 'low';
}

function applyResolverPromptOverride(resolver, promptOverride) {
    if (!resolver || promptOverride === undefined) return resolver;

    const promptList = Array.isArray(promptOverride) ? promptOverride : [promptOverride];
    resolver.prompts = promptList.map((prompt) => (
        prompt instanceof Prompt ? prompt : new Prompt({ prompt })
    ));

    if (typeof resolver.getChunkMaxTokenLength === 'function') {
        resolver.chunkMaxTokenLength = resolver.getChunkMaxTokenLength();
    }

    return resolver;
}

function createShadowResolver(resolver, overrides = {}) {
    if (!resolver || typeof resolver !== 'object') return { ...overrides };
    const { pathwayPrompt, prompts, ...restOverrides } = overrides;
    const shadow = Object.create(Object.getPrototypeOf(resolver) || Object.prototype);
    Object.defineProperties(shadow, Object.getOwnPropertyDescriptors(resolver));
    Object.assign(shadow, restOverrides);
    if (pathwayPrompt !== undefined) {
        applyResolverPromptOverride(shadow, pathwayPrompt);
    } else if (prompts !== undefined) {
        applyResolverPromptOverride(shadow, prompts);
    }
    return shadow;
}

function cloneMessages(msgs) {
    return JSON.parse(JSON.stringify(msgs));
}

function isGeminiModel(model = '') {
    return /^gemini-/i.test(String(model || '').trim());
}

function hasToolName(tools = [], toolName = '') {
    const needle = String(toolName || '').trim().toLowerCase();
    if (!needle) return false;
    return (tools || []).some((tool) => String(tool?.function?.name || '').trim().toLowerCase() === needle);
}

function escapeRegExp(text = '') {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMarkdownSections(text = '', headings = []) {
    let result = String(text || '');
    for (const heading of headings) {
        const escapedHeading = escapeRegExp(heading);
        result = result.replace(
            new RegExp(`(?:^|\\n)## ${escapedHeading}\\n[\\s\\S]*?(?=(?:\\n## [^\\n]+\\n)|$)`, 'g'),
            '',
        );
    }
    return result.replace(/\n{3,}/g, '\n\n').trim();
}

export function pruneGeminiFinalContinuityContext(context = '') {
    return stripMarkdownSections(context, [
        'Current Expression State',
        'My Internal Compass',
    ]);
}

function buildLeanResponsePromptTemplate({
    isSystem = false,
    entityInstructions = '',
    useContinuityMemory = false,
    resolvedContinuityContext = '',
    runtimeContext = null,
    promptContext = {},
    purpose = '',
    allowReplan = false,
    replanOnly = false,
    delegateToolName = '',
} = {}) {
    const entityContext = buildEntityContextBlock({
        entityInstructions,
        useContinuityMemory,
        resolvedContinuityContext,
    });
    const runtimeInstructions = buildRuntimeInstructionBlock(runtimeContext);

    const commonInstructionsTemplate = isSystem
        ? `{{renderTemplate AI_COMMON_INSTRUCTIONS_TEXT}}`
        : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}`;
    const stableInstructionBlock = `${commonInstructionsTemplate}\n\n{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}`.trim();
    const effectiveDelegateToolName = delegateToolName || 'SetGoals';
    const purposeInstruction = allowReplan
        ? (replanOnly
            ? `If the evidence is insufficient, call ${effectiveDelegateToolName} only with the missing outcomes. Do not call search/fetch or any other tools directly in this step. Otherwise answer directly. Any factual answer you give from search/tool evidence must appear explicitly in the evidence above. Do not infer or guess missing facts.`
            : `If the evidence is insufficient, call ${effectiveDelegateToolName} with the missing outcomes. Otherwise answer directly. Any factual answer you give from search/tool evidence must appear explicitly in the evidence above. Do not infer or guess missing facts.`)
        : '';
    const styleInstructionBlock = '{{renderTemplate AI_STYLE_NEUTRALIZATION}}';

    const messages = [
        { role: 'system', content: stableInstructionBlock },
        ...(styleInstructionBlock ? [{ role: 'system', content: styleInstructionBlock }] : []),
        ...(entityContext.trim() ? [{ role: 'system', content: entityContext.trim() }] : []),
        ...(runtimeInstructions.trim() ? [{ role: 'system', content: runtimeInstructions.trim() }] : []),
        ...(purposeInstruction ? [{ role: 'system', content: purposeInstruction }] : []),
    ];

    if (purpose === 'fast_chat' || purpose === 'fast_finalize') {
        messages.push({
            role: 'system',
            content: 'Answer directly in your normal voice. Start with the answer itself. Keep it concise unless the user asked for depth.',
        });
    }

    if (promptContext.includeDateTime) {
        messages.push({ role: 'system', content: '{{renderTemplate AI_DATETIME}}' });
    }

    return [
        ...messages,
        '{{chatHistory}}',
    ];
}

function buildFastSearchPromptTemplate({
    isSystem = false,
    entityInstructions = '',
    useContinuityMemory = false,
    resolvedContinuityContext = '',
    runtimeContext = null,
    promptContext = {},
} = {}) {
    const entityContext = buildEntityContextBlock({
        entityInstructions,
        useContinuityMemory,
        resolvedContinuityContext,
    }).trim();
    const runtimeInstructions = buildRuntimeInstructionBlock(runtimeContext).trim();
    const commonInstructionsTemplate = isSystem
        ? `{{renderTemplate AI_COMMON_INSTRUCTIONS_TEXT}}`
        : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}`;
    const searchInstructionBlock = [
        commonInstructionsTemplate,
        '{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}',
        'This is a simple current-information turn.',
        'Call the search/fetch tools you need in a single response, then stop. Do not call SetGoals.',
        'Bundle complementary web lookups together when one query is likely ambiguous or easy to confuse with unrelated results.',
        'If the target is unnamed, rumored, newly opened, or could be confused with unrelated venues/topics, use at least two complementary lookups before you stop.',
        'Prefer the minimum search set that reaches a confident identification, not the fewest possible queries.',
    ].join('\n\n').trim();

    return [
        { role: 'system', content: searchInstructionBlock },
        { role: 'system', content: '{{renderTemplate AI_STYLE_NEUTRALIZATION}}' },
        ...(entityContext ? [{ role: 'system', content: entityContext }] : []),
        ...(runtimeInstructions ? [{ role: 'system', content: runtimeInstructions }] : []),
        ...(promptContext.includeDateTime ? [{ role: 'system', content: '{{renderTemplate AI_DATETIME}}' }] : []),
        '{{chatHistory}}',
    ];
}

export function buildInitialPlanningTools({
    planningToolsOpenAiFormat = [],
    entityToolsOpenAiFormat = [],
    runtimeEnabled = false,
    delegateOnly = false,
} = {}) {
    const hasEntityTools = entityToolsOpenAiFormat.length > 0;
    if (!hasEntityTools) return planningToolsOpenAiFormat;

    if (runtimeEnabled) {
        const runtimeTools = delegateOnly
            ? [DELEGATE_RESEARCH_OPENAI_DEF]
            : [DELEGATE_RESEARCH_OPENAI_DEF, ...planningToolsOpenAiFormat.filter((tool) => tool?.function?.name !== 'SetGoals')];
        const seen = new Set();
        return runtimeTools.filter((tool) => {
            const name = String(tool?.function?.name || '').trim().toLowerCase();
            if (!name || seen.has(name)) return false;
            seen.add(name);
            return true;
        });
    }

    return [...planningToolsOpenAiFormat, SET_GOALS_OPENAI_DEF];
}

export function shouldForceInitialResearchDelegation(route = {}, args = {}) {
    if (!isEntityRuntimeEnabled(args) || route?.mode !== 'plan') return false;
    const conversationMode = normalizeConversationMode(args.runtimeConversationMode || 'chat');
    if (conversationMode === 'research') return true;
    const toolCategory = String(route?.toolCategory || '').trim().toLowerCase();
    if (RESEARCH_DELEGATION_TOOL_CATEGORIES.has(toolCategory)) return true;

    const initialToolNames = Array.isArray(route?.initialToolNames)
        ? route.initialToolNames
        : [];
    const normalizedToolNames = initialToolNames
        .map((toolName) => String(toolName || '').trim().toLowerCase())
        .filter(Boolean);

    if (normalizedToolNames.length === 0) return false;

    const hasRetrievalTool = normalizedToolNames.some((toolName) => RESEARCH_RETRIEVAL_TOOL_NAMES.has(toolName));
    const allResearchTools = normalizedToolNames.every((toolName) => RESEARCH_DELEGATION_TOOL_NAMES.has(toolName));
    return hasRetrievalTool && allResearchTools;
}

function buildRuntimeLoopTools(_entityToolsOpenAiFormat = [], { delegateOnly = false } = {}) {
    if (delegateOnly) {
        return [DELEGATE_RESEARCH_OPENAI_DEF];
    }
    return [DELEGATE_RESEARCH_OPENAI_DEF, DELEGATE_TASK_OPENAI_DEF];
}

function buildChildWorkerPromptTemplate({
    isSystem = false,
    entityInstructions = '',
    useContinuityMemory = false,
    resolvedContinuityContext = '',
    runtimeContext = null,
    promptContext = {},
    workerGoal = '',
    workerTaskBrief = '',
    workerTaskIndex = 1,
    workerTaskCount = 1,
} = {}) {
    const entityContext = buildEntityContextBlock({
        entityInstructions,
        useContinuityMemory,
        resolvedContinuityContext,
    }).trim();
    const runtimeInstructions = buildRuntimeInstructionBlock(runtimeContext).trim();
    const commonInstructionsTemplate = isSystem
        ? `{{renderTemplate AI_COMMON_INSTRUCTIONS_TEXT}}`
        : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}`;
    const taskLabel = `Assigned worker task ${workerTaskIndex}/${workerTaskCount}`;
    const workerInstructionBlock = [
        commonInstructionsTemplate,
        '{{renderTemplate AI_WORKSPACE}}',
        '{{renderTemplate AI_EXPERTISE}}',
        '{{renderTemplate AI_SEARCH_RULES}}',
        '{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}',
        'You are one autonomous worker inside a parallel research run.',
        workerGoal ? `Overall goal: ${workerGoal}` : '',
        workerTaskBrief ? `${taskLabel}: ${workerTaskBrief}` : taskLabel,
        'Your job is to solve your assigned part of the overall goal so the supervisor can combine your findings with sibling workers.',
        'Review the existing conversation and tool results before acting.',
        'If this assigned task is already satisfied by existing evidence, respond with SYNTHESIZE.',
        'If more evidence is needed, use the tools needed for this task and keep working until the task is satisfied, blocked, or obvious next steps are exhausted.',
        'Prefer focused, high-signal tool calls over broad repetition. If you need multiple complementary lookups, batch them together.',
        'Do not call SetGoals or DelegateResearch.',
        'Do not answer the user directly.',
        'Return only tool calls or SYNTHESIZE.',
    ].filter(Boolean).join('\n\n').trim();

    return [
        { role: 'system', content: workerInstructionBlock },
        { role: 'system', content: '{{renderTemplate AI_STYLE_NEUTRALIZATION}}' },
        ...(entityContext ? [{ role: 'system', content: entityContext }] : []),
        ...(runtimeInstructions ? [{ role: 'system', content: runtimeInstructions }] : []),
        ...(promptContext.includeAvailableFiles ? [{ role: 'system', content: '{{renderTemplate AI_AVAILABLE_FILES}}' }] : []),
        ...(promptContext.includeDateTime ? [{ role: 'system', content: '{{renderTemplate AI_DATETIME}}' }] : []),
        '{{chatHistory}}',
    ];
}

export function buildPurposePromptOverride(callArgs = {}, purpose = '') {
    const promptMeta = callArgs.promptTemplateMeta || {};
    if (!promptMeta || typeof promptMeta !== 'object') return null;
    const hasDelegateResearch = hasToolName(callArgs.tools, 'DelegateResearch');
    const hasDelegateTask = hasToolName(callArgs.tools, 'DelegateTask');
    const delegateToolName = hasDelegateResearch && hasDelegateTask
        ? 'DelegateResearch or DelegateTask'
        : (hasDelegateResearch
            ? 'DelegateResearch'
            : (hasDelegateTask
                ? 'DelegateTask'
                : (hasToolName(callArgs.tools, 'SetGoals') ? 'SetGoals' : '')));
    const runtimeAllowsDirectTools = isEntityRuntimeEnabled(callArgs)
        && Array.isArray(callArgs.tools)
        && callArgs.tools.some((tool) => {
            const name = String(tool?.function?.name || '').trim().toLowerCase();
            return name && ![DELEGATE_RESEARCH_TOOL_NAME, DELEGATE_TASK_TOOL_NAME].includes(name);
        });

    const templateArgs = {
        ...promptMeta,
        promptContext: promptMeta.promptContext || {},
        resolvedContinuityContext: promptMeta.resolvedContinuityContext || '',
        runtimeContext: callArgs.runtimeContext || null,
        purpose,
        delegateToolName,
    };

    switch (purpose) {
    case 'synthesis':
        if (runtimeAllowsDirectTools) {
            return buildLeanResponsePromptTemplate(templateArgs);
        }
        return buildLeanResponsePromptTemplate({
            ...templateArgs,
            allowReplan: Boolean(delegateToolName),
            replanOnly: Boolean(delegateToolName) && isEntityRuntimeEnabled(callArgs),
        });
    case 'synthesis_finalize':
    case 'initial_finalize':
    case 'fast_chat':
    case 'fast_finalize':
        return buildLeanResponsePromptTemplate(templateArgs);
    case 'fast_search':
        return buildFastSearchPromptTemplate(templateArgs);
    case 'child_fanout':
        return buildChildWorkerPromptTemplate({
            ...templateArgs,
            workerGoal: callArgs.workerGoal || '',
            workerTaskBrief: callArgs.workerTaskBrief || '',
            workerTaskIndex: callArgs.workerTaskIndex || 1,
            workerTaskCount: callArgs.workerTaskCount || 1,
        });
    default:
        return null;
    }
}

function extractResponseText(response) {
    if (response instanceof CortexResponse) return response.output_text || response.content || '';
    if (typeof response === 'string') return response;
    if (response) return response.output_text || response.content || '';
    return '';
}

function sanitizeToolStatusDetail(value = '', maxLength = 72) {
    const compact = String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/[.?!,:;]+$/g, '')
        .trim();
    if (!compact) return '';
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildDefaultToolUserMessage(toolName = '', toolArgs = {}) {
    if (toolName === 'SearchMemory') {
        const queryDetail = sanitizeToolStatusDetail(toolArgs?.query || '');
        if (queryDetail) {
            return `Checking memory for ${queryDetail}.`;
        }
    }

    return VOICE_FALLBACKS[toolName] || VOICE_FALLBACKS.default;
}

function getFinalAssistantText(resolver, response) {
    return String(resolver?.streamedContent || extractResponseText(response) || '').trim();
}

function getExecutionState(resolver) {
    if (!resolver) return null;
    if (!resolver._executionState) {
        resolver._executionState = {
            routeMode: '',
            executedTools: false,
            toolExecutions: 0,
            enteredSupervisor: false,
            producedUserFacingAnswer: false,
            answerMode: null,
        };
    }
    return resolver._executionState;
}

function initializeExecutionState(resolver, routeMode = '') {
    const state = getExecutionState(resolver);
    if (state && routeMode) {
        state.routeMode = routeMode;
    }
    return state;
}

function markExecutionRoute(resolver, routeMode = '') {
    const state = getExecutionState(resolver);
    if (state && routeMode) {
        state.routeMode = routeMode;
    }
    return state;
}

function markToolExecution(resolver, count = 0) {
    if (!(count > 0)) return;
    const state = getExecutionState(resolver);
    if (!state) return;
    state.executedTools = true;
    state.toolExecutions += count;
    state.answerMode = 'agentic_execution';
}

function markSupervisorEntry(resolver, answerMode = 'agentic_synthesis') {
    const state = getExecutionState(resolver);
    if (!state) return;
    state.enteredSupervisor = true;
    state.answerMode = answerMode;
}

function markAnswerProduced(resolver, answerMode = '') {
    const state = getExecutionState(resolver);
    if (!state) return;
    state.producedUserFacingAnswer = true;
    if (answerMode) {
        state.answerMode = answerMode;
    }
}

function canRewriteInitialResponse(resolver) {
    const state = getExecutionState(resolver);
    if (!state) return true;
    return !state.executedTools && !state.enteredSupervisor;
}

function hasSignedUrlParams(url = '') {
    return typeof url === 'string'
        && (
            url.includes('X-Goog-Algorithm=')
            || url.includes('X-Goog-Signature=')
            || url.includes('GoogleAccessId=')
            || url.includes('Signature=')
        );
}

function extractManagedBlobPathFromUrl(url) {
    if (!url || typeof url !== 'string') return null;

    if (url.startsWith('gs://')) {
        const withoutProtocol = url.slice(5);
        const slashIndex = withoutProtocol.indexOf('/');
        return slashIndex === -1 ? null : decodeURIComponent(withoutProtocol.slice(slashIndex + 1));
    }

    try {
        const urlObj = new URL(url);
        const pathnameParts = urlObj.pathname.split('/').filter(Boolean);

        if (
            urlObj.hostname === 'storage.googleapis.com'
            || urlObj.hostname === 'storage.cloud.google.com'
        ) {
            if (pathnameParts.length >= 2) {
                return decodeURIComponent(pathnameParts.slice(1).join('/'));
            }
            return null;
        }

        if (
            pathnameParts.length >= 5
            && pathnameParts[0] === 'storage'
            && pathnameParts[1] === 'v1'
            && pathnameParts[2] === 'b'
        ) {
            const objectIndex = pathnameParts.indexOf('o');
            if (objectIndex !== -1 && pathnameParts.length > objectIndex + 1) {
                return decodeURIComponent(pathnameParts.slice(objectIndex + 1).join('/'));
            }
        }
    } catch {
        return null;
    }

    return null;
}

function collectSignedManagedMediaUrls(value, signedUrlsByBlobPath) {
    if (!value) return;

    if (typeof value === 'string') {
        const parsed = safeParse(value);
        if (parsed !== undefined) {
            collectSignedManagedMediaUrls(parsed, signedUrlsByBlobPath);
        }
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((item) => collectSignedManagedMediaUrls(item, signedUrlsByBlobPath));
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    const directUrl = typeof value.url === 'string' ? value.url : null;
    const nestedImageUrl = typeof value.image_url?.url === 'string' ? value.image_url.url : null;
    const candidateUrl = directUrl || nestedImageUrl;
    const candidateBlobPath = typeof value.blobPath === 'string'
        ? value.blobPath
        : extractManagedBlobPathFromUrl(candidateUrl);

    if (candidateBlobPath && candidateUrl && hasSignedUrlParams(candidateUrl)) {
        signedUrlsByBlobPath.set(candidateBlobPath, candidateUrl);
    }

    Object.values(value).forEach((nested) => {
        collectSignedManagedMediaUrls(nested, signedUrlsByBlobPath);
    });
}

export function repairManagedMediaUrlsInText(text = '', messages = []) {
    if (!text || typeof text !== 'string') {
        return text;
    }

    const normalizedText = text.replace(
        /:cd_source\[([^\]]+)\]((?:\[[^\]]+\])+)/g,
        (_match, firstId, trailingIds) => {
            const ids = [firstId];
            const extraMatches = trailingIds.matchAll(/\[([^\]]+)\]/g);

            for (const extraMatch of extraMatches) {
                if (extraMatch?.[1]) {
                    ids.push(extraMatch[1]);
                }
            }

            return ids.map((id) => `:cd_source[${id}]`).join(' ');
        },
    );

    if (!Array.isArray(messages) || messages.length === 0) {
        return normalizedText;
    }

    const signedUrlsByBlobPath = new Map();
    collectSignedManagedMediaUrls(messages, signedUrlsByBlobPath);

    if (signedUrlsByBlobPath.size === 0) {
        return normalizedText;
    }

    return normalizedText.replace(/https?:\/\/[^\s<>"')\]]+/g, (matchedUrl) => {
        if (hasSignedUrlParams(matchedUrl)) {
            return matchedUrl;
        }

        const blobPath = extractManagedBlobPathFromUrl(matchedUrl);
        if (!blobPath) {
            return matchedUrl;
        }

        return signedUrlsByBlobPath.get(blobPath) || matchedUrl;
    });
}

function repairManagedMediaUrlsInResponse(response, resolver, messages = []) {
    const repairedStreamedContent = repairManagedMediaUrlsInText(
        resolver?.streamedContent || '',
        messages,
    );

    if (resolver && repairedStreamedContent !== (resolver.streamedContent || '')) {
        resolver.streamedContent = repairedStreamedContent;
    }

    const originalText = extractResponseText(response);
    const repairedText = repairManagedMediaUrlsInText(originalText, messages);

    if (!originalText || repairedText === originalText) {
        return response;
    }

    if (response instanceof CortexResponse) {
        response.output_text = repairedText;
        if (typeof response.content === 'string') {
            response.content = repairedText;
        }
        return response;
    }

    if (typeof response === 'string') {
        return repairedText;
    }

    if (response && typeof response === 'object') {
        if (typeof response.output_text === 'string') {
            response.output_text = repairedText;
        } else if (typeof response.content === 'string') {
            response.content = repairedText;
        }
    }

    return response;
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

function consumeInjectedAgentMessages(args, resolver) {
    const requestId = getRequestId(resolver);
    const state = requestState[requestId];
    const queuedMessages = Array.isArray(state?.injectedMessages)
        ? state.injectedMessages.splice(0)
        : [];

    if (queuedMessages.length === 0) {
        return false;
    }

    if (!Array.isArray(args.chatHistory)) {
        args.chatHistory = [];
    }

    for (const queued of queuedMessages) {
        const content = typeof queued?.message === 'string'
            ? queued.message.trim()
            : '';
        if (!content) continue;

        args.chatHistory.push({ role: 'user', content });
        publishRequestProgress({
            requestId,
            info: JSON.stringify({
                toolMessage: {
                    type: 'finish',
                    callId: queued.id || `inject:${Date.now()}`,
                    icon: '💬',
                    userMessage: content,
                    success: true,
                    presentation: 'inline_user',
                },
            }),
        });
    }

    return true;
}

function hasOnlyToolCallsByName(toolCalls = [], toolName = '') {
    const needle = String(toolName || '').trim().toLowerCase();
    if (!needle) return false;
    return Array.isArray(toolCalls)
        && toolCalls.length > 0
        && toolCalls.every(tc => tc.function?.name?.toLowerCase() === needle);
}

function hasOnlySetGoalsToolCalls(toolCalls = []) {
    return hasOnlyToolCallsByName(toolCalls, SET_GOALS_TOOL_NAME);
}

function extractDelegateResearchPlan(toolCall) {
    if (toolCall?.function?.name?.toLowerCase() !== DELEGATE_RESEARCH_TOOL_NAME) return null;
    const planArgs = safeParse(toolCall.function.arguments);
    if (!planArgs?.goal || !Array.isArray(planArgs.tasks)) return null;
    return {
        goal: String(planArgs.goal).trim(),
        steps: planArgs.tasks.map(step => String(step).trim()).filter(Boolean),
    };
}

function extractDelegateTaskPlan(toolCall) {
    if (toolCall?.function?.name?.toLowerCase() !== DELEGATE_TASK_TOOL_NAME) return null;
    const planArgs = safeParse(toolCall.function.arguments);
    if (!planArgs?.goal || !planArgs?.task) return null;
    return {
        goal: String(planArgs.goal).trim(),
        steps: [String(planArgs.task).trim()].filter(Boolean),
    };
}

function extractPlanFromToolCall(toolCall) {
    return extractSetGoalsPlan(toolCall) || extractDelegateResearchPlan(toolCall) || extractDelegateTaskPlan(toolCall);
}

function getResearchTaskRecords(state = null) {
    if (!state) return [];
    if (!Array.isArray(state.researchTasks)) {
        state.researchTasks = [];
    }
    return state.researchTasks;
}

function getResearchTaskBriefs(state = null, { includeCompleted = false } = {}) {
    return getResearchTaskRecords(state)
        .filter((task) => task && (includeCompleted || task.status !== 'completed'))
        .map((task) => task.brief)
        .filter(Boolean);
}

function getDelegatedResearchGoal(resolver = {}, args = {}) {
    return resolver?.entityRuntimeState?.researchGoal
        || resolver?.toolPlan?.goal
        || args.runGoal
        || extractUserMessage(args)
        || 'Complete the active request.';
}

function getDelegatedResearchTasks(resolver = {}) {
    const state = resolver?.entityRuntimeState;
    if (state) {
        const tasks = getResearchTaskBriefs(state);
        if (tasks.length > 0) return tasks;
    }
    return dedupePlanTasks(resolver?.toolPlan?.steps || []);
}

function getTrackedResearchPlan(resolver = {}, args = {}, { includeCompleted = false } = {}) {
    const state = resolver?.entityRuntimeState;
    const trackedSteps = state ? getResearchTaskBriefs(state, { includeCompleted }) : [];
    return {
        goal: getDelegatedResearchGoal(resolver, args),
        steps: trackedSteps.length > 0
            ? dedupePlanTasks(trackedSteps)
            : dedupePlanTasks(resolver?.toolPlan?.steps || []),
    };
}

function updateResearchTaskStatus(resolver = {}, taskBrief = '', status = 'pending') {
    const state = resolver?.entityRuntimeState;
    if (!state || !taskBrief) return;
    const signature = getResearchTaskSignature(taskBrief);
    for (const task of getResearchTaskRecords(state)) {
        if (getResearchTaskSignature(task?.brief) !== signature) continue;
        task.status = status;
        task.updatedAt = new Date().toISOString();
    }
    syncRuntimeResultData(resolver, resolver.args || {});
}

function buildToolPlanFromToolCalls(toolCalls = [], args = {}) {
    if (!toolCalls || toolCalls.length === 0) return null;
    const goal = args.runGoal || extractUserMessage(args) || 'Complete the active request.';
    const steps = [];
    const seen = new Set();
    for (const toolCall of toolCalls) {
        const step = describeToolIntent(toolCall);
        if (!step || seen.has(step)) continue;
        seen.add(step);
        steps.push(step);
        if (steps.length >= 5) break;
    }
    return {
        goal,
        steps: steps.length > 0 ? steps : ['Finish the request using the evidence gathered so far.'],
    };
}

function applyToolPlan(plan, resolver, { source = 'runtime_synthesized' } = {}) {
    if (!plan?.goal || !Array.isArray(plan.steps)) return null;
    const dedupedSteps = dedupePlanTasks(plan.steps);
    resolver.toolPlan = {
        goal: String(plan.goal).trim(),
        steps: dedupedSteps,
    };
    if (resolver?.entityRuntimeState) {
        resolver.entityRuntimeState.researchGoal = resolver.toolPlan.goal;
        resolver.entityRuntimeState.researchTasks = dedupedSteps.map((step, index) => ({
            id: `${index + 1}:${getResearchTaskSignature(step) || step}`,
            brief: step,
            status: 'pending',
            updatedAt: new Date().toISOString(),
        }));
        syncRuntimeResultData(resolver, resolver.args || {});
    }
    logEvent(getRequestId(resolver), 'plan.created', {
        goal: resolver.toolPlan.goal,
        steps: resolver.toolPlan.steps.length,
        stepList: resolver.toolPlan.steps,
        source,
    });
    return resolver.toolPlan;
}

function synthesizeServerPlan(toolCalls, args, resolver, { force = false, source = 'runtime_synthesized' } = {}) {
    if (!force && resolver.toolPlan) return resolver.toolPlan;
    const plan = buildToolPlanFromToolCalls(toolCalls, args);
    return applyToolPlan(plan, resolver, { source });
}

function extractSetGoalsPlan(toolCall) {
    if (toolCall?.function?.name?.toLowerCase() !== SET_GOALS_TOOL_NAME) return null;
    const planArgs = safeParse(toolCall.function.arguments);
    if (!planArgs?.goal || !Array.isArray(planArgs.steps)) return null;
    return {
        goal: String(planArgs.goal).trim(),
        steps: planArgs.steps.map(step => String(step).trim()).filter(Boolean),
    };
}

function buildPlanSignature(plan) {
    if (!plan?.goal || !Array.isArray(plan.steps)) return null;
    return JSON.stringify({
        goal: String(plan.goal).trim().toLowerCase(),
        steps: plan.steps.map(step => String(step).trim().toLowerCase()).filter(Boolean),
    });
}

function getDelegatedResearchSignature(resolver = {}, args = {}) {
    return buildPlanSignature(getTrackedResearchPlan(resolver, args, { includeCompleted: true }));
}

function dedupePlanTasks(tasks = []) {
    const seen = new Set();
    const deduped = [];

    for (const task of tasks) {
        const normalized = String(task || '').trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(normalized);
    }

    return deduped;
}

function normalizeResearchTaskToken(token = '') {
    let normalized = String(token || '')
        .trim()
        .toLowerCase()
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!normalized) return '';
    if (normalized.endsWith('ies') && normalized.length > 4) {
        normalized = `${normalized.slice(0, -3)}y`;
    } else if (normalized.endsWith('s') && normalized.length > 4 && !normalized.endsWith('ss')) {
        normalized = normalized.slice(0, -1);
    }
    if (!normalized || TASK_NOVELTY_STOP_WORDS.has(normalized)) return '';
    return normalized;
}

function getResearchTaskSignature(task = '') {
    const tokens = new Set(
        String(task || '')
            .split(/[^a-z0-9]+/i)
            .map(normalizeResearchTaskToken)
            .filter(Boolean),
    );
    const signature = [...tokens].sort().join(' ');
    return signature || String(task || '').trim().toLowerCase();
}

function areResearchTaskSignaturesSimilar(left = '', right = '') {
    const lhs = String(left || '').trim();
    const rhs = String(right || '').trim();
    if (!lhs || !rhs) return false;
    if (lhs === rhs) return true;

    const lhsTokens = lhs.split(/\s+/).filter(Boolean);
    const rhsTokens = rhs.split(/\s+/).filter(Boolean);
    if (lhsTokens.length === 0 || rhsTokens.length === 0) return false;

    const rhsSet = new Set(rhsTokens);
    const intersection = lhsTokens.filter((token) => rhsSet.has(token)).length;
    const minOverlap = intersection / Math.min(lhsTokens.length, rhsTokens.length);
    const maxOverlap = intersection / Math.max(lhsTokens.length, rhsTokens.length);
    return minOverlap >= 0.8 || maxOverlap >= 0.67;
}

function getAttemptedTaskSignatures(state = null) {
    if (!state) return [];
    if (!Array.isArray(state.attemptedTaskSignatures)) {
        state.attemptedTaskSignatures = [];
    }
    return state.attemptedTaskSignatures;
}

function hasNovelPlanTasks(plan = null, resolver = {}) {
    const steps = dedupePlanTasks(plan?.steps || getDelegatedResearchTasks(resolver));
    if (steps.length === 0) return false;

    const attempted = getAttemptedTaskSignatures(resolver?.entityRuntimeState);
    if (attempted.length === 0) return true;

    return steps.some((task) => {
        const signature = getResearchTaskSignature(task);
        return !attempted.some((prior) => areResearchTaskSignaturesSimilar(signature, prior));
    });
}

function rememberAttemptedTasks(resolver, tasks = []) {
    const state = resolver?.entityRuntimeState;
    if (!state) return;

    const attempted = getAttemptedTaskSignatures(state);
    for (const task of dedupePlanTasks(tasks)) {
        const signature = getResearchTaskSignature(task);
        if (!signature) continue;
        if (attempted.some((prior) => areResearchTaskSignaturesSimilar(signature, prior))) continue;
        attempted.push(signature);
    }
    syncRuntimeResultData(resolver, resolver.args || {});
}

function getRemainingChildRunBudget(state = null) {
    if (!state?.authorityEnvelope) return Number.POSITIVE_INFINITY;
    const maxChildRuns = Math.max(1, Number(state.authorityEnvelope.maxChildRuns || 1));
    const usedChildRuns = Math.max(0, Number(state.childRuns || 0));
    return Math.max(0, maxChildRuns - usedChildRuns);
}

function getMaxFanoutWidth(state = null) {
    if (!state?.authorityEnvelope) return Number.POSITIVE_INFINITY;
    const maxChildRuns = Math.max(1, Number(state.authorityEnvelope.maxChildRuns || 1));
    const configuredWidth = Math.max(1, Number(state.authorityEnvelope.maxFanoutWidth || maxChildRuns));
    return Math.min(configuredWidth, maxChildRuns);
}

function getFanoutIdleReason(resolver = {}) {
    const steps = dedupePlanTasks(getDelegatedResearchTasks(resolver));
    if (steps.length === 0) return 'no_tasks';

    const state = resolver?.entityRuntimeState;
    if (!state?.authorityEnvelope) return 'no_tasks';
    if (getRemainingChildRunBudget(state) <= 0) return 'child_cap';
    if (!hasNovelPlanTasks({ steps }, resolver)) return 'no_novel_tasks';
    return 'no_tasks';
}

function dedupeToolCallsBySignature(toolCalls = []) {
    const seen = new Set();
    const deduped = [];

    for (const toolCall of toolCalls) {
        const toolName = String(toolCall?.function?.name || '').trim();
        if (!toolName) continue;
        const args = typeof toolCall?.function?.arguments === 'string'
            ? toolCall.function.arguments
            : JSON.stringify(toolCall?.function?.arguments || {});
        const signature = `${toolName}:${args}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        deduped.push(toolCall);
    }

    return deduped;
}

function getToolCallSignature(toolCall) {
    const toolName = String(toolCall?.function?.name || '').trim();
    if (!toolName) return '';
    const args = typeof toolCall?.function?.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall?.function?.arguments || {});
    return `${toolName}:${args}`;
}

function selectFanoutTasks(resolver) {
    const steps = dedupePlanTasks(getDelegatedResearchTasks(resolver));
    if (steps.length === 0) return [];

    const state = resolver?.entityRuntimeState;
    if (!state?.authorityEnvelope) return steps;

    const remainingSlots = getRemainingChildRunBudget(state);
    if (remainingSlots <= 0) return [];

    const fanoutWidth = Math.min(getMaxFanoutWidth(state), remainingSlots);
    return steps
        .filter((task) => {
            const signature = getResearchTaskSignature(task);
            return !getAttemptedTaskSignatures(state).some((attempted) => areResearchTaskSignaturesSimilar(signature, attempted));
        })
        .slice(0, fanoutWidth);
}

function extractWorkerMessages(messages = [], baseLength = 0) {
    return (messages || [])
        .slice(baseLength)
        .filter((message) => {
            if (!message) return false;
            if (message.role === 'tool') return true;
            if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
            if (message.role === 'user' && Array.isArray(message.content)) {
                return message.content.some((item) => item?.type === 'image_url' || item?.image_url?.url);
            }
            return false;
        });
}

async function queueResolverToolWork(resolver, work) {
    const prior = resolver._workerToolQueue || Promise.resolve();
    const next = prior.then(() => work());
    resolver._workerToolQueue = next.catch(() => {});
    return next;
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
    const executionState = resolver._executionState
        ? {
            routeMode: resolver._executionState.routeMode || null,
            executedTools: !!resolver._executionState.executedTools,
            toolExecutions: resolver._executionState.toolExecutions || 0,
            enteredSupervisor: !!resolver._executionState.enteredSupervisor,
            producedUserFacingAnswer: !!resolver._executionState.producedUserFacingAnswer,
            answerMode: resolver._executionState.answerMode || null,
        }
        : null;
    const runtimeBudget = resolver.entityRuntimeState
        ? {
            searchCalls: resolver.entityRuntimeState.searchCalls,
            fetchCalls: resolver.entityRuntimeState.fetchCalls,
            childRuns: resolver.entityRuntimeState.childRuns,
            evidenceItems: resolver.entityRuntimeState.evidenceItems,
            stopReason: resolver.entityRuntimeState.stopReason || null,
        }
        : null;
    logEvent(getRequestId(resolver), 'request.end', {
        durationMs: Date.now() - (resolver.requestStartTime || 0),
        toolRounds: resolver.toolCallRound || 0,
        budgetUsed: resolver.toolBudgetUsed || 0,
        ...(usage && { tokens: usage }),
        ...(executionState && { execution: executionState }),
        ...(runtimeBudget && { runtimeBudget }),
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

function insertTaggedSystemTurn(messages, text, { requestId = null, marker = SYNTHESIS_REVIEW_MARKER } = {}) {
    const prefix = requestId ? `${marker} ${requestId}` : marker;
    const filtered = (messages || []).filter((msg) => {
        if (msg.role !== 'system') return true;
        const content = typeof msg.content === 'string' ? msg.content : '';
        return !content.startsWith(prefix);
    });
    filtered.push({ role: 'system', content: `${prefix}\n${text}` });
    return filtered;
}

export function buildStepInstruction(pathwayResolver) {
    const explicitGoal = pathwayResolver?.entityRuntimeState?.researchGoal || pathwayResolver?.toolPlan?.goal || '';
    const goal = explicitGoal || getDelegatedResearchGoal(pathwayResolver);
    const steps = dedupePlanTasks(getDelegatedResearchTasks(pathwayResolver));
    if (steps.length === 0) {
        if (explicitGoal) {
            return `Current goal: ${explicitGoal}

Use tools directly if they advance the task.
If you need more information gathering, call DelegateResearch with concrete parallel tasks.
Respond with SYNTHESIZE when your assigned work is complete.`;
        }
        return "Use tools only when they advance the task. Respond with SYNTHESIZE when your assigned work is complete.";
    }
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
    let inputTokens = 0, outputTokens = 0, cachedTokens = 0, cacheWriteTokens = 0;
    for (const u of entries) {
        if (!u) continue;
        inputTokens += u.prompt_tokens || u.input_tokens || u.promptTokenCount || 0;
        outputTokens += u.completion_tokens || u.output_tokens || u.candidatesTokenCount || 0;
        cachedTokens += u.prompt_tokens_details?.cached_tokens || u.input_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0;
        cacheWriteTokens += u.cache_creation_input_tokens || 0;
    }
    if (inputTokens === 0 && outputTokens === 0) return undefined;
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cachedTokens > 0 && { cachedTokens }),
        ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
    };
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

function applyStyleNeutralization(callArgs, purpose) {
    const styleBlock = getStyleNeutralizationBlock(callArgs, purpose);
    if (!styleBlock.enabled) {
        return {
            ...callArgs,
            styleNeutralizationInstructions: '',
            styleNeutralizationPatch: 'none',
            styleNeutralizationKey: 'none',
        };
    }

    return {
        ...callArgs,
        styleNeutralizationInstructions: styleBlock.instructions,
        styleNeutralizationPatch: styleBlock.patchName,
        styleNeutralizationKey: styleBlock.key,
    };
}

function getStyleNeutralizationBlock(callArgs, purpose) {
    if (!FINAL_RESPONSE_NEUTRALIZATION_PURPOSES.has(purpose)) {
        return { enabled: false, instructions: '', patchName: 'none', key: 'none' };
    }

    const model = callArgs.modelOverride || callArgs.model || '';
    const styleBlock = buildNeutralizationInstructionBlock({
        model,
        purpose,
        patchName: callArgs.styleNeutralizationPatch,
        patchText: callArgs.styleNeutralizationText,
        profile: callArgs.styleNeutralizationProfile,
    });

    return {
        ...styleBlock,
        enabled: !!styleBlock.instructions,
    };
}

function applyPromptCacheOptions(callArgs, purpose, model) {
    if (!model || callArgs.promptCache) {
        return callArgs;
    }

    const toolNames = summarizeToolNames(callArgs.tools) || [];
    const promptCache = buildPromptCacheHint({
        entityId: callArgs.entityId,
        contextId: callArgs.contextId,
        invocationType: callArgs.runtimeOrigin || callArgs.invocationType,
        purpose,
        model,
        routeMode: callArgs.latencyRouteMode || '',
        toolNames,
        styleNeutralizationKey: callArgs.styleNeutralizationKey || 'none',
    });

    if (!promptCache?.key) return callArgs;

    return {
        ...callArgs,
        promptCache,
    };
}

function normalizeReasoningEffort(value, fallback = 'medium') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
    return fallback;
}

function normalizeRouterConfidence(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['low', 'medium', 'high'].includes(normalized)) return normalized;
    return 'low';
}

function normalizeRouterMode(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    return ROUTER_ALLOWED_MODES.has(normalized) ? normalized : 'plan';
}

function normalizeRouterToolCategory(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    return ROUTER_ALLOWED_TOOL_CATEGORIES.has(normalized) ? normalized : 'general';
}

function normalizeRouterModeAction(value = '') {
    return String(value || '').trim().toLowerCase() === 'switch' ? 'switch' : 'stay';
}

function normalizeRouterReason(value = '', fallback = 'model_route') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) return fallback;
    if (normalized.length > 32) return fallback;
    if (normalized.split('_').filter(Boolean).length > 4) return fallback;
    return normalized;
}

function stripJsonCodeFence(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith('```')) return trimmed;
    return trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function shouldUseModelRouter({ text = '', invocationType = '', initialRoute = null } = {}) {
    if (!text || invocationType === 'pulse') return false;
    if (!initialRoute) return false;
    if (text.length > ROUTER_MAX_INPUT_CHARS) return false;
    if (text.includes('\n') || text.includes('```')) return false;
    return true;
}

function buildRoutingPrompt({ text = '', recentFiles = [], availableToolNames = [], initialRoute = null, currentMode = 'chat' } = {}) {
    return [
        {
            role: 'system',
            content: `You are a latency router for an agent runtime. Maintain sticky conversation mode unless the user's intent clearly changed.

Current sticky conversation modes:
- "chat": casual back-and-forth, acknowledgements, personal conversation
- "agentic": requests that imply tools, files, code execution, actions, or stepwise work
- "creative": ideation, prose, expressive generation
- "research": fact gathering, current info, reading/synthesis
- "nsfw": explicitly sexual or erotic conversation

Execution routes:
- "direct_reply": casual chat or a simple acknowledgement that needs no tools
- "direct_search": a simple, deterministic current-info/news/search turn that can be handled with one bundled search round and one answer
- "plan": anything that may require tools, file/workspace handling, ambiguity resolution, or iterative multi-step work

Tool categories:
- "workspace": workspace/files inspection, local files, shell checks
- "images": image inspection, avatar/image-specific work, choosing or applying image assets
- "web": current info, search, news, web reading
- "memory": narrative memory recall/store
- "media": image/video/slides generation or editing
- "chart": charts/graphs/diagrams
- "general": no strong category

Rules:
- Keep the current conversationMode unless the user intent clearly shifts.
- Prefer "direct_reply" only when you can answer confidently from the existing conversation, entity context, and stable knowledge alone.
- If the user is asking for intel, identification, verification, or any real-world referent that may require lookup or disambiguation, do not choose "direct_reply".
- If a direct reply would require guessing, choose "direct_search" or "plan" instead.
- Prefer "direct_search" only for simple, deterministic current-info questions where one bundled search round should be enough to answer confidently.
- Use "plan" if the turn has real ambiguity, entity-identification uncertainty, multiple plausible targets, broad or comparative scope, likely follow-on searches/fetches, likely iterative research, action-taking, or file/workspace handling.
- If you suspect the model may need a second research round to be reliable, choose "plan", not "direct_search".
- planningEffort: "low" for straightforward inspection/reporting/tool-routing turns, "medium" for normal tasks, "high" for broad research or complex problem-solving.
- synthesisEffort: "low" for short direct answers or simple summaries, otherwise "medium" unless nuanced synthesis clearly needs "high".
- modeAction: "stay" if the current sticky mode still fits, otherwise "switch".
- reason and modeReason must be short snake_case codes, 1-4 words max. Good examples: casual_chat, current_info, workspace_task, image_task, mode_stay, research_request.
- Call the "${ROUTER_DECISION_TOOL_NAME}" function exactly once.
- Do not reply with plain text.`,
        },
        {
            role: 'user',
            content: JSON.stringify({
                userText: text,
                currentMode,
                recentFiles: recentFiles.slice(0, ROUTER_MAX_RECENT_FILES),
                availableTools: availableToolNames,
                heuristic: {
                    mode: initialRoute?.mode || 'plan',
                    reason: initialRoute?.reason || 'default',
                    initialToolNames: initialRoute?.initialToolNames || [],
                },
            }),
        },
    ];
}

function extractJsonObjectCandidate(text = '') {
    const trimmed = stripJsonCodeFence(text);
    if (!trimmed) return '';
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1);
    }
    return trimmed;
}

function extractRoutingDecisionPayload(response) {
    const toolCalls = extractToolCalls(response);
    const routeToolCall = toolCalls.find((toolCall) => (
        String(toolCall?.function?.name || '').trim() === ROUTER_DECISION_TOOL_NAME
    ));
    const toolArgs = routeToolCall?.function?.arguments;
    const parsedToolArgs = toolArgs ? safeParse(toolArgs) : null;
    if (parsedToolArgs && typeof parsedToolArgs === 'object' && !Array.isArray(parsedToolArgs)) {
        return parsedToolArgs;
    }

    const raw = extractJsonObjectCandidate(extractResponseText(response));
    const parsedText = raw ? safeParse(raw) : null;
    if (parsedText && typeof parsedText === 'object' && !Array.isArray(parsedText)) {
        return parsedText;
    }

    return null;
}

function parseRoutingDecision(response) {
    const parsed = extractRoutingDecisionPayload(response);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const mode = normalizeRouterMode(parsed.mode);
    const toolCategory = normalizeRouterToolCategory(parsed.toolCategory);
    const conversationMode = normalizeConversationMode(parsed.conversationMode || 'chat');
    const modeAction = normalizeRouterModeAction(parsed.modeAction);
    const defaultReason = (
        mode === 'direct_reply' ? 'casual_chat' :
        toolCategory === 'web' ? 'current_info' :
        toolCategory === 'workspace' ? 'workspace_task' :
        toolCategory === 'images' ? 'image_task' :
        toolCategory === 'memory' ? 'memory_task' :
        toolCategory === 'media' ? 'media_task' :
        toolCategory === 'chart' ? 'chart_task' :
        'agentic_task'
    );
    const defaultModeReason = modeAction === 'switch'
        ? `${conversationMode}_request`
        : 'mode_stay';
    return {
        mode,
        confidence: normalizeRouterConfidence(parsed.confidence),
        toolCategory,
        planningEffort: normalizeReasoningEffort(parsed.planningEffort, 'medium'),
        synthesisEffort: normalizeReasoningEffort(parsed.synthesisEffort, 'medium'),
        conversationMode,
        modeAction,
        reason: normalizeRouterReason(parsed.reason, defaultReason),
        modeReason: normalizeRouterReason(parsed.modeReason || parsed.reason, defaultModeReason),
    };
}

function trimFastPathHistory(messages = [], maxTurns = FAST_CHAT_MAX_TURNS, maxMessages = null) {
    const sliced = sliceByTurns(cloneMessages(messages || []), maxTurns) || [];
    if (!maxMessages || sliced.length <= maxMessages) return sliced;
    return sliced.slice(-maxMessages);
}

function getFastPathModel(args = {}) {
    return args.modelPolicyResolved?.researchModel
        || args.modelPolicyResolved?.routingModel
        || args.modelPolicy?.researchModel
        || args.modelPolicy?.routingModel
        || args.synthesisModel
        || args.primaryModel;
}

function getFastFinalizeModel(args = {}) {
    if (args.useMemory === false) {
        return getFastPathModel(args);
    }
    return args.modelPolicyResolved?.synthesisModel
        || args.modelPolicyResolved?.primaryModel
        || args.synthesisModel
        || args.primaryModel
        || getFastPathModel(args);
}

function hasUsableFastPathResult(result) {
    if (result === null || result === undefined) return false;
    if (typeof result === 'string') return result.trim().length > 0;
    const extracted = extractResponseText(result);
    if (typeof extracted === 'string') return extracted.trim().length > 0;
    if (result instanceof CortexResponse) {
        return typeof result.output_text === 'string' && result.output_text.trim().length > 0;
    }
    return true;
}

function buildDirectRouteFromDecision(decision, { text = '', chatHistory = [], availableToolNames = [] } = {}) {
    if (decision.mode === 'direct_reply') {
        return {
            mode: 'direct_reply',
            reason: decision.reason || 'casual_chat',
            initialToolNames: [],
        };
    }

    if (decision.mode === 'direct_search') {
        const webTools = shortlistToolsForCategory('web', availableToolNames);
        if (webTools.length > 0) {
            return {
                mode: 'direct_search',
                reason: decision.reason || 'current_info',
                initialToolNames: webTools,
            };
        }
    }

    return null;
}

async function classifyRouteWithModel({
    initialRoute,
    text = '',
    chatHistory = [],
    availableToolNames = [],
    args,
    resolver,
    modelPolicy = {},
    currentMode = 'chat',
}) {
    if (!shouldUseModelRouter({ text, invocationType: args.invocationType, initialRoute })) return null;

    const routingModel = modelPolicy.routingModel;
    if (!routingModel) return null;

    const recentFiles = extractRecentFileReferences(chatHistory);
    const shadowResolver = createShadowResolver(resolver, {
        pathwayPrompt: [new Prompt({
            messages: buildRoutingPrompt({
                text,
                recentFiles,
                availableToolNames,
                initialRoute,
                currentMode,
            }),
        })],
    });

    try {
        const routeResponse = await callModelLogged(shadowResolver, withVisibleModel({
            ...args,
            chatHistory: [],
            stream: false,
            useMemory: false,
            skipMemoryLoad: true,
            tools: [ROUTER_DECISION_OPENAI_DEF],
            tool_choice: {
                type: 'function',
                function: {
                    name: ROUTER_DECISION_TOOL_NAME,
                },
            },
            max_output_tokens: 180,
            reasoningEffort: 'none',
            latencyRouteMode: 'route_classifier',
        }, routingModel), 'route', {
            model: routingModel,
        });

        const decision = parseRoutingDecision(routeResponse);
        if (!decision) return { status: 'invalid', model: routingModel, contentChars: extractResponseText(routeResponse)?.length || 0 };

        const confidence = normalizeRouterConfidence(decision.confidence);
        const nextConversationMode = normalizeConversationMode(
            decision.modeAction === 'switch'
                ? decision.conversationMode
                : currentMode
        );
        const nextRoute = {
            ...initialRoute,
            mode: ['direct_reply', 'direct_search'].includes(decision.mode) ? decision.mode : 'plan',
            routeSource: 'model',
            toolCategory: decision.toolCategory,
            reason: ['default', 'chat_mode', 'agentic_mode', 'creative_mode', 'research_mode', 'nsfw_mode'].includes(initialRoute.reason)
                ? decision.reason
                : initialRoute.reason,
            planningReasoningEffort: decision.planningEffort,
            synthesisReasoningEffort: decision.synthesisEffort,
        };

        const categoryTools = shortlistToolsForCategory(decision.toolCategory, availableToolNames);
        if (categoryTools.length > 0) {
            nextRoute.initialToolNames = categoryTools;
        }

        let selectedRoute = confidence === 'low' ? initialRoute : nextRoute;
        if (confidence === 'high') {
            const directRoute = buildDirectRouteFromDecision(decision, {
                text,
                chatHistory,
                availableToolNames,
            });
            if (directRoute) {
                selectedRoute = {
                    ...directRoute,
                    routeSource: 'model',
                    planningReasoningEffort: 'low',
                    synthesisReasoningEffort: decision.synthesisEffort,
                };
            }
        }

        return {
            status: 'ok',
            model: routingModel,
            decision,
            confidence,
            nextConversationMode,
            selectedRoute,
            currentMode,
        };
    } catch (error) {
        return { status: 'error', model: routingModel, error };
    }
}

function applyRouteClassificationOutcome({
    classification,
    initialRoute,
    args,
    resolver,
}) {
    const rid = getRequestId(resolver);
    if (!classification || classification.status !== 'ok') {
        if (classification?.status === 'invalid') {
            logEvent(rid, 'route.classifier_invalid', {
                model: classification.model,
                contentChars: classification.contentChars || 0,
            });
        } else if (classification?.status === 'error') {
            logEventError(rid, 'route.classifier_error', { model: classification.model, error: classification.error?.message || String(classification.error) });
        }
        if (resolver.entityRuntimeState) {
            resolver.entityRuntimeState.conversationModeConfidence = 'low';
        }
        args.runtimeConversationModeConfidence = 'low';
        if (['direct_reply', 'direct_search'].includes(initialRoute?.mode)) {
            return {
                ...initialRoute,
                mode: 'plan',
                reason: 'router_invalid',
                routeSource: 'router_fallback',
            };
        }
        return initialRoute;
    }

    const {
        model,
        confidence,
        nextConversationMode,
        selectedRoute,
        currentMode,
        decision,
    } = classification;
    const normalizedConfidence = confidence === 'high' ? 'high' : 'low';
    const lowConfidenceFastPath = (
        normalizedConfidence !== 'high'
        && ['direct_reply', 'direct_search'].includes(initialRoute?.mode)
    );
    const effectiveRoute = lowConfidenceFastPath
        ? {
            ...initialRoute,
            mode: 'plan',
            reason: 'router_low_confidence',
            routeSource: 'router_fallback',
            planningReasoningEffort: decision.planningEffort,
            synthesisReasoningEffort: decision.synthesisEffort,
        }
        : selectedRoute;

    logEvent(rid, 'route.classifier_selected', {
        model,
        mode: effectiveRoute.mode,
        reason: effectiveRoute.reason,
        confidence,
        conversationMode: nextConversationMode,
        modeAction: decision.modeAction,
        modeReason: decision.modeReason,
        toolCategory: decision.toolCategory,
        planningEffort: effectiveRoute.planningReasoningEffort,
        synthesisEffort: effectiveRoute.synthesisReasoningEffort,
    });

    if (resolver.entityRuntimeState) {
        resolver.entityRuntimeState.conversationModeConfidence = normalizedConfidence;
    }
    args.runtimeConversationModeConfidence = normalizedConfidence;

    if (normalizedConfidence === 'high' && nextConversationMode !== currentMode) {
        args.runtimeConversationMode = nextConversationMode;
        if (resolver.entityRuntimeState) {
            resolver.entityRuntimeState.conversationMode = nextConversationMode;
            resolver.entityRuntimeState.modeUpdatedAt = new Date().toISOString();
            resolver.entityRuntimeState.conversationModeConfidence = 'high';
        }
        publishConversationModeMessage({
            resolver,
            previousMode: currentMode,
            nextMode: nextConversationMode,
            reason: decision.modeReason,
            source: 'router',
        });
    }

    return effectiveRoute;
}

async function maybeRefineRouteWithModel({
    initialRoute,
    text = '',
    chatHistory = [],
    availableToolNames = [],
    args,
    resolver,
    modelPolicy = {},
    currentMode = 'chat',
}) {
    const classification = await classifyRouteWithModel({
        initialRoute,
        text,
        chatHistory,
        availableToolNames,
        args,
        resolver,
        modelPolicy,
        currentMode,
    });
    return applyRouteClassificationOutcome({ classification, initialRoute, args, resolver });
}

// ─── Model Calling ───────────────────────────────────────────────────────────

async function callModelLogged(resolver, callArgs, purpose, overrides = {}) {
    const rid = getRequestId(resolver);
    const neutralizedCallArgs = applyStyleNeutralization(callArgs, purpose);
    const model = neutralizedCallArgs.modelOverride || neutralizedCallArgs.model || overrides.model;
    const optimizedCallArgs = applyPromptCacheOptions(neutralizedCallArgs, purpose, model);
    const promptOverride = buildPurposePromptOverride(optimizedCallArgs, purpose);
    const activeResolver = promptOverride
        ? createShadowResolver(resolver, {
            pathwayPrompt: [new Prompt({ messages: promptOverride })],
        })
        : resolver;
    const activeToolNames = new Set(
        summarizeToolNames(optimizedCallArgs.tools)
            .map((name) => String(name || '').trim().toLowerCase())
            .filter(Boolean),
    );
    activeResolver._activeToolNames = activeToolNames;
    resolver._activeToolNames = new Set(activeToolNames);
    logEvent(rid, 'model.call', {
        model,
        purpose,
        stream: optimizedCallArgs.stream,
        reasoningEffort: optimizedCallArgs.reasoningEffort,
        toolNames: summarizeToolNames(optimizedCallArgs.tools),
        toolChoice: optimizedCallArgs.tool_choice || 'auto',
        messageCount: optimizedCallArgs.chatHistory?.length || 0,
        styleNeutralizationPatch: optimizedCallArgs.styleNeutralizationPatch || 'none',
        ...(optimizedCallArgs.promptCache?.key && { promptCacheKey: optimizedCallArgs.promptCache.key }),
        ...overrides,
    });
    const start = Date.now();
    const result = await activeResolver.promptAndParse(optimizedCallArgs);
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

async function maybeFinalizeInitialResponse({
    response,
    args,
    resolver,
    initialCallModel,
}) {
    if (!response || typeof response?.on === 'function') return response;
    if (!canRewriteInitialResponse(resolver)) return response;

    const draftText = extractResponseText(response).trim();
    if (!draftText) return response;

    const finalModel = args.synthesisModel || args.primaryModel || initialCallModel;
    const styleBlock = getStyleNeutralizationBlock({
        ...args,
        model: finalModel,
    }, 'initial_finalize');
    if (!styleBlock.enabled) return response;

    await markRuntimeStage(resolver, 'synthesize', 'Finalizing direct answer for user-facing style', {
        model: finalModel,
    });

    const rid = getRequestId(resolver);
    const forcedHistory = [
        ...(args.chatHistory || []),
        { role: 'assistant', content: draftText },
        {
            role: 'user',
            content: `[system message: ${rid}:initial-finalize] The draft answer above is the current best answer. Rewrite it as the final user-facing response. Preserve the factual content and intent. Do not add new facts, new caveats, or new offers unless they were already present. Do not call tools.`,
        },
    ];

    const finalized = await callModelLogged(resolver, withVisibleModel({
        ...args,
        chatHistory: forcedHistory,
        // Keep the rewrite pass non-streaming so we never expose the draft answer first.
        stream: false,
        tools: [],
        reasoningEffort: args.synthesisReasoningEffort || args.configuredReasoningEffort || 'low',
        skipMemoryLoad: true,
    }, finalModel), 'initial_finalize', {
        model: finalModel,
    });

    if (!finalized) return response;

    const holder = { value: finalized };
    await drainStreamingCallbacks(resolver)(holder);
    const finalizedResponse = holder.value || response;
    markAnswerProduced(resolver, 'rewrite_only');
    return finalizedResponse;
}

async function runDirectSearchFastPath(route, args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    const rid = getRequestId(resolver);
    const fastPathModel = getFastPathModel(args);
    const finalizeModel = getFastFinalizeModel(args);
    const searchTools = (entityToolsOpenAiFormat || []).filter((tool) => (
        (route.initialToolNames || []).includes(tool.function?.name)
    ));

    await markRuntimeStage(resolver, 'direct_search', 'Executing direct search fast path', {
        model: fastPathModel,
        route: route.reason,
    });

    try {
        const searchStep = await callModelLogged(resolver, withVisibleModel({
            ...args,
            chatHistory: trimFastPathHistory(args.chatHistory || [], FAST_TOOL_MAX_TURNS, FAST_TOOL_MAX_MESSAGES),
            stream: false,
            tools: searchTools,
            tool_choice: 'auto',
            reasoningEffort: 'low',
            skipMemoryLoad: shouldSkipRuntimeMemoryLoad(resolver),
            latencyRouteMode: route.reason,
        }, fastPathModel), 'fast_search', {
            model: fastPathModel,
            route: route.reason,
        });

        if (!searchStep) return await handlePromptError(null);

        const searchToolCalls = extractToolCalls(searchStep);
        if (searchToolCalls.length > 0) {
            await processToolCallRound(searchToolCalls, args, resolver, entityTools);
        } else if (hasUsableFastPathResult(searchStep)) {
            const finalizedSearchStep = await maybeFinalizeInitialResponse({
                response: searchStep,
                args,
                resolver,
                initialCallModel: fastPathModel,
            });
            markAnswerProduced(resolver, 'direct_search');
            return finalizedSearchStep;
        }

        const forcedHistory = [
            ...trimFastPathHistory(args.chatHistory || [], FAST_TOOL_MAX_TURNS, FAST_TOOL_MAX_MESSAGES),
            {
                role: 'user',
                content: `[system message: ${rid}:fast-search-finalize] The search results above are authoritative enough for a direct answer. Answer the user now in your normal voice. Start with the answer itself. Do not call tools again.`,
            },
        ];

        const finalized = await callModelLogged(resolver, withVisibleModel({
            ...args,
            chatHistory: forcedHistory,
            stream: args.stream,
            tools: [],
            reasoningEffort: 'low',
            skipMemoryLoad: shouldSkipRuntimeMemoryLoad(resolver),
            latencyRouteMode: route.reason,
        }, finalizeModel), 'fast_finalize', {
            model: finalizeModel,
            route: route.reason,
        });

        if (!finalized) return await handlePromptError(null);

        const holder = { value: finalized };
        await drainStreamingCallbacks(resolver)(holder);
        markAnswerProduced(resolver, 'direct_search');
        return holder.value;
    } catch (error) {
        return await handlePromptError(error);
    }
}

async function runDirectReplyFastPath(route, args, resolver, handlePromptError) {
    const rid = getRequestId(resolver);
    const fastPathModel = getFastFinalizeModel(args);
    const replySettings = getDirectReplySettings(route);

    await markRuntimeStage(resolver, 'direct_reply', 'Executing conversational fast path', {
        model: fastPathModel,
        route: route.reason,
    });

    const forcedHistory = [
        ...trimFastPathHistory(args.chatHistory || [], replySettings.maxTurns, replySettings.maxMessages),
        {
            role: 'user',
            content: `[system message: ${rid}:fast-reply] This turn is purely conversational and does not require tools. Respond directly to the user in your normal voice. Keep it concise unless the user asked for depth.`,
        },
    ];

    try {
        const finalized = await callModelLogged(resolver, withVisibleModel({
            ...args,
            chatHistory: forcedHistory,
            stream: args.stream,
            tools: [],
            reasoningEffort: replySettings.reasoningEffort,
            skipMemoryLoad: shouldSkipRuntimeMemoryLoad(resolver),
            latencyRouteMode: route.reason,
        }, fastPathModel), 'fast_chat', {
            model: fastPathModel,
            route: route.reason,
        });

        if (!finalized) return await handlePromptError(null);

        const holder = { value: finalized };
        await drainStreamingCallbacks(resolver)(holder);
        markAnswerProduced(resolver, 'direct_reply');
        return holder.value;
    } catch (error) {
        return await handlePromptError(error);
    }
}

async function warmDirectSearchFastPath(route, args, resolver, entityToolsOpenAiFormat = []) {
    const fastPathModel = getFastPathModel(args);
    const searchTools = (entityToolsOpenAiFormat || []).filter((tool) => (
        (route.initialToolNames || []).includes(tool.function?.name)
    ));

    if (searchTools.length === 0) {
        return null;
    }

    await callModelLogged(resolver, withVisibleModel(withLatencyWarmOptions({
        ...args,
        chatHistory: trimFastPathHistory(args.chatHistory || [], FAST_TOOL_MAX_TURNS, FAST_TOOL_MAX_MESSAGES),
        tools: searchTools,
        tool_choice: 'auto',
        reasoningEffort: 'low',
        skipMemoryLoad: true,
        latencyRouteMode: route.reason,
    }), fastPathModel), 'fast_search', {
        model: fastPathModel,
        route: route.reason,
        warmOnly: true,
    });

    return 'fast_search';
}

async function warmDirectReplyFastPath(route, args, resolver) {
    const rid = getRequestId(resolver);
    const fastPathModel = getFastFinalizeModel(args);
    const replySettings = getDirectReplySettings(route);
    const forcedHistory = [
        ...trimFastPathHistory(args.chatHistory || [], replySettings.maxTurns, replySettings.maxMessages),
        {
            role: 'user',
            content: `[system message: ${rid}:fast-reply] This turn is purely conversational and does not require tools. Respond directly to the user in your normal voice. Keep it concise unless the user asked for depth.`,
        },
    ];

    await callModelLogged(resolver, withVisibleModel(withLatencyWarmOptions({
        ...args,
        chatHistory: forcedHistory,
        tools: [],
        reasoningEffort: replySettings.reasoningEffort,
        skipMemoryLoad: true,
        latencyRouteMode: route.reason,
    }), fastPathModel), 'fast_chat', {
        model: fastPathModel,
        route: route.reason,
        warmOnly: true,
    });

    return 'fast_chat';
}

async function warmInitialPlanPrompt(args, resolver, planningToolsOpenAiFormat, entityToolsOpenAiFormat) {
    const runtimeEnabled = isEntityRuntimeEnabled(args) && !!args.toolLoopModel;
    const delegateOnly = shouldForceInitialResearchDelegation({
        mode: args.runtimeRouteMode || 'plan',
        reason: args.runtimeRouteReason || args.latencyRouteReason || '',
        initialToolNames: args.initialPlanningToolNames || [],
    }, args);
    const firstCallTools = buildInitialPlanningTools({
        planningToolsOpenAiFormat,
        entityToolsOpenAiFormat,
        runtimeEnabled,
        delegateOnly,
    });
    const initialCallModel = args.planningModel || args.primaryModel;

    await callModelLogged(resolver, withVisibleModel(withLatencyWarmOptions({
        ...args,
        promptContext: {
            ...(args.promptContext || {}),
            runtimeInitialDelegateOnly: delegateOnly,
            runtimeAgenticLoop: runtimeEnabled,
        },
        chatHistory: delegateOnly
            ? buildDelegateOnlyPlanningHistory(args.chatHistory || [], resolver, {
                mode: args.runtimeRouteMode || 'plan',
                reason: args.runtimeRouteReason || args.latencyRouteReason || '',
                initialToolNames: args.initialPlanningToolNames || [],
            })
            : cloneMessages(args.chatHistory || []),
        availableFiles: [],
        tools: firstCallTools,
        tool_choice: delegateOnly
            ? {
                type: 'function',
                function: {
                    name: 'DelegateResearch',
                },
            }
            : 'auto',
        reasoningEffort: delegateOnly
            ? 'low'
            : (args.planningReasoningEffort || args.configuredReasoningEffort || 'low'),
        skipMemoryLoad: true,
    }), initialCallModel), 'initial', {
        model: initialCallModel,
        warmOnly: true,
    });

    return 'initial';
}

function logFastPathRouteSelection({
    resolver,
    args,
    entityId,
    invocationType,
    toolLoopModel,
    reasoningEffort,
    modelPolicy,
    authorityEnvelope,
    route,
    conversationMode,
}) {
    const rid = getRequestId(resolver);
    const responseModel = route.mode === 'direct_reply' || route.mode === 'direct_search'
        ? getFastFinalizeModel(args)
        : args.primaryModel;
    updateRuntimeRouteState(resolver, args, route);
    logEvent(rid, 'request.start', {
        entity: entityId,
        model: responseModel,
        stream: args.stream,
        invocationType,
        ...(toolLoopModel && { toolLoopModel }),
        reasoningEffort,
        routingModel: modelPolicy.routingModel,
        conversationMode,
        planningReasoningEffort: args.planningReasoningEffort || 'low',
        synthesisReasoningEffort: args.synthesisReasoningEffort || 'low',
        entityToolCount: args.entityToolsOpenAiFormat?.length || 0,
        entityToolNames: summarizeToolNames(args.entityToolsOpenAiFormat),
        planningToolCount: 0,
        planningToolNames: [],
        ...(isEntityRuntimeEnabled(args) && {
            runtimeRunId: args.runtimeRunId,
            runtimeStage: args.runtimeStage || 'plan',
            modelPolicy: args.modelPolicyResolved || modelPolicy,
            authorityEnvelope,
        }),
    });
    logEvent(rid, 'route.selected', {
        mode: route.mode,
        reason: route.reason,
        routeSource: route.routeSource || 'direct',
        conversationMode,
        planningToolNames: [],
        planningReasoningEffort: args.planningReasoningEffort || 'low',
        synthesisReasoningEffort: args.synthesisReasoningEffort || 'low',
    });
    logEvent(rid, 'route.preflight_skipped', {
        mode: route.mode,
        reason: route.reason,
        skipped: ['file_sync', 'context_compression'],
    });
    publishRuntimeModeStatus({ resolver, args });
}

function makeErrorHandler(args, resolver) {
    return async (error) => {
        const errorMessage = error?.message || (resolver.errors.length > 0
            ? resolver.errors.join(', ')
            : 'Model request failed - no response received');

        // User-initiated cancel — log cleanly and close the stream without generating an error response
        if (errorMessage === 'Request canceled') {
            const rid = getRequestId(resolver);
            logEvent(rid, 'request.cancel', { phase: 'tool_loop', budgetUsed: resolver.toolBudgetUsed || 0, toolRounds: resolver.toolCallRound || 0 });
            resolver.errors = [];
            publishRequestProgress({
                requestId: rid,
                progress: 1,
                data: '',
                info: JSON.stringify(resolver.pathwayResultData || {}),
                error: ''
            });
            return '';
        }

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

function getToolBudgetLimit(args, resolver) {
    return Math.min(
        TOOL_BUDGET,
        resolver.entityRuntimeState?.authorityEnvelope?.maxToolBudget || TOOL_BUDGET
    );
}

function getResearchRoundLimit(resolver) {
    return resolver.entityRuntimeState?.authorityEnvelope?.maxResearchRounds || Number.POSITIVE_INFINITY;
}

function getRuntimeBudgetState(resolver) {
    const state = resolver.entityRuntimeState;
    if (!state) return null;
    return {
        toolBudgetUsed: resolver.toolBudgetUsed || 0,
        researchRounds: resolver.toolCallRound || 0,
        searchCalls: state.searchCalls || 0,
        fetchCalls: state.fetchCalls || 0,
        childRuns: state.childRuns || 0,
        remainingChildRuns: getRemainingChildRunBudget(state),
        maxFanoutWidth: getMaxFanoutWidth(state),
        evidenceItems: state.evidenceItems || 0,
    };
}

function syncRuntimeResultData(resolver, args = {}) {
    const state = resolver.entityRuntimeState;
    if (!state) return null;
    const researchTasks = getResearchTaskRecords(state).map((task) => ({
        id: task.id,
        brief: task.brief,
        status: task.status,
    }));

    const entityRuntime = {
        ...(resolver.pathwayResultData?.entityRuntime || {}),
        runId: state.runId,
        conversationMode: normalizeConversationMode(state.conversationMode || args.runtimeConversationMode || 'chat'),
        conversationModeConfidence: normalizeModeConfidence(state.conversationModeConfidence || args.runtimeConversationModeConfidence || 'low'),
        routeMode: state.routeMode || args.runtimeRouteMode || '',
        routeReason: state.routeReason || args.runtimeRouteReason || '',
        routeSource: state.routeSource || args.runtimeRouteSource || '',
        ...(state.directTool || args.runtimeDirectTool ? { directTool: state.directTool || args.runtimeDirectTool } : {}),
        stopReason: state.stopReason,
        budgetState: getRuntimeBudgetState(resolver),
        ...(state.researchGoal || researchTasks.length > 0
            ? {
                research: {
                    goal: state.researchGoal || '',
                    tasks: researchTasks,
                },
            }
            : {}),
    };

    resolver.pathwayResultData = {
        ...(resolver.pathwayResultData || {}),
        entityRuntime,
    };

    return entityRuntime;
}

function publishRuntimeModeStatus({ resolver, args = {}, progress = 0.15 } = {}) {
    if (!resolver || !args.stream) return;
    const entityRuntime = syncRuntimeResultData(resolver, args);
    if (!entityRuntime) return;

    publishRequestProgress({
        requestId: getRequestId(resolver),
        progress,
        data: '',
        error: '',
        info: JSON.stringify(resolver.pathwayResultData || {}),
    });
}

function updateRuntimeRouteState(resolver, args = {}, route = {}) {
    if (!resolver?.entityRuntimeState) return;
    resolver.entityRuntimeState.routeMode = route.mode || args.runtimeRouteMode || '';
    resolver.entityRuntimeState.routeReason = route.reason || args.runtimeRouteReason || '';
    resolver.entityRuntimeState.routeSource = route.routeSource || args.runtimeRouteSource || '';
    resolver.entityRuntimeState.directTool = route.toolName || route.directTool || args.runtimeDirectTool || '';
    markExecutionRoute(resolver, resolver.entityRuntimeState.routeMode);
    syncRuntimeResultData(resolver, args);
}

function registerRuntimeStop(resolver, reason) {
    if (!resolver.entityRuntimeState || resolver.entityRuntimeState.stopReason) return;
    resolver.entityRuntimeState.stopReason = reason;
    syncRuntimeResultData(resolver, resolver.args || {});
}

function buildRuntimeInstructionBlock(runtimeContext) {
    if (!runtimeContext?.enabled) return '';
    const orientationBlock = runtimeContext.orientationSummary
        ? `\n\nOrientation:\n${runtimeContext.orientationSummary}`
        : '';
    return `## Current Run

You are operating inside a durable entity runtime.
Run goal: ${runtimeContext.goal || 'No goal provided.'}
Origin: ${runtimeContext.origin || 'chat'}
Stage: ${runtimeContext.stage || 'plan'}
Requested output: ${runtimeContext.requestedOutput || 'No special output constraint.'}
Energy envelope: ${runtimeContext.envelopeSummary}

You control tactics, pacing, and whether to keep researching, synthesize now, narrow the scope, or ask for more budget. Respect the visible envelope above; do not hide extra work inside repeated low-yield searches.
${orientationBlock}

If the evidence is sufficient, synthesize. If it is not, use tools deliberately and avoid repeating the same search in slightly different wording.`;
}

function extractMarkdownSection(text = '', heading = '') {
    if (!text || !heading) return { body: '', remainder: String(text || '') };
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\n)## ${escapedHeading}\\n([\\s\\S]*?)(?=\\n## [^\\n]+\\n|$)`);
    const match = String(text).match(pattern);
    if (!match) return { body: '', remainder: String(text || '') };

    const fullMatch = match[0];
    const body = match[1].trim();
    const remainder = String(text).replace(fullMatch, '').trim();
    return { body, remainder };
}

function normalizeEntityIdentityForPrompt(entityInstructions = '') {
    let working = String(entityInstructions || '').trim();
    if (!working) return { identity: '', relationshipContext: '' };

    const expressionBodies = [];
    const relationshipBodies = [];

    const explicitExpression = extractMarkdownSection(working, 'Expression Profile');
    if (explicitExpression.body) {
        expressionBodies.push(explicitExpression.body);
        working = explicitExpression.remainder;
    }

    const explicitRelationship = extractMarkdownSection(working, 'Relationship Context');
    if (explicitRelationship.body) {
        relationshipBodies.push(explicitRelationship.body);
        working = explicitRelationship.remainder;
    }

    const explicitUserContext = extractMarkdownSection(working, 'User Context');
    if (explicitUserContext.body) {
        relationshipBodies.push(explicitUserContext.body);
        working = explicitUserContext.remainder;
    }

    const legacyUserPreferences = extractMarkdownSection(working, 'User Preferences');
    if (legacyUserPreferences.body) {
        const expressionLines = [];
        const relationshipLines = [];
        const lines = legacyUserPreferences.body
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        for (const line of lines) {
            if (line.startsWith('Personality Traits:') || line.startsWith('Communication Style:')) {
                expressionLines.push(line);
                continue;
            }
            relationshipLines.push(line);
        }

        if (expressionLines.length > 0) expressionBodies.push(expressionLines.join('\n'));
        if (relationshipLines.length > 0) relationshipBodies.push(relationshipLines.join('\n'));
        working = legacyUserPreferences.remainder;
    }

    const identityParts = [working.trim()];
    if (expressionBodies.length > 0) {
        identityParts.push(`## Expression Profile\n${expressionBodies.join('\n')}`);
    }

    return {
        identity: identityParts.filter(Boolean).join('\n\n').trim(),
        relationshipContext: relationshipBodies.length > 0
            ? `## Relationship Context\n${relationshipBodies.join('\n')}`.trim()
            : '',
    };
}

function buildStaticEntityDefaultsBlock(entityInstructions = '') {
    const normalized = normalizeEntityIdentityForPrompt(entityInstructions);
    const identity = normalized.identity;
    const sections = [];

    if (identity) {
        sections.push(`## Entity DNA\n\n${identity}`);
    }

    if (normalized.relationshipContext) {
        sections.push(normalized.relationshipContext);
    }

    return sections.join('\n\n').trim();
}

function buildEntityContextBlock({
    entityInstructions = '',
    useContinuityMemory = false,
    resolvedContinuityContext = '',
    promptContext = {},
} = {}) {
    if (useContinuityMemory) {
        return adaptContinuityContextForPromptContext(String(resolvedContinuityContext || '').trim(), promptContext);
    }
    return buildStaticEntityDefaultsBlock(entityInstructions);
}

export function adaptContinuityContextForPromptContext(context = '', promptContext = {}) {
    const text = String(context || '').trim();
    if (!text || !promptContext?.runtimeInitialDelegateOnly) return text;
    const sanitized = text.replace(
        /If a user asks about something not covered here,\s*use SearchMemory to check before claiming to remember or not remember\./g,
        "If a user asks about something not covered here, treat it as missing evidence instead of claiming to remember it.",
    );
    const sections = sanitized.split(/\n(?=##\s)/).filter(Boolean);
    const preferredSections = sections.filter((section) => /##\s*(entity dna|relationship|relational|resonance|memory boundaries)/i.test(section));
    const compact = (preferredSections.length > 0 ? preferredSections : sections).join('\n\n').trim();
    return compact.length > 1800 ? `${compact.slice(0, 1800).trim()}\n\n[Context truncated for delegation.]` : compact;
}

function refreshRuntimeInitialPrompt(resolver, {
    promptTemplateMeta = {},
    entityToolsOpenAiFormat = [],
    voiceResponse = false,
    isPulse = false,
    runtimeContext = null,
    promptContext = {},
} = {}) {
    const promptMessages = buildPromptTemplate(
        { isSystem: !!promptTemplateMeta?.isSystem },
        entityToolsOpenAiFormat,
        promptTemplateMeta?.entityInstructions || '',
        promptTemplateMeta?.useContinuityMemory !== false,
        voiceResponse,
        isPulse,
        runtimeContext,
        promptContext,
    );
    resolver.pathwayPrompt = [new Prompt({ messages: promptMessages })];
}

function hasInlineContinuityContext(_args = {}, resolver = null) {
    if (typeof resolver?.continuityContext === 'string' && resolver.continuityContext.trim()) return true;
    return false;
}

function shouldSkipRuntimeMemoryLoad(resolver = null) {
    return resolver?._continuityPreloaded === true || hasInlineContinuityContext({}, resolver);
}

async function preloadRuntimeContinuity(resolver, args = {}) {
    if (args.useMemory === false) {
        return { enabled: false, attempted: false, loaded: false, skipped: true };
    }
    if (!resolver || typeof resolver.ensureMemoryLoaded !== 'function') {
        return {
            enabled: true,
            attempted: false,
            loaded: hasInlineContinuityContext({}, resolver),
            skipped: true,
        };
    }
    return resolver.ensureMemoryLoaded({
        ...args,
        skipMemoryLoad: false,
    });
}

function shouldIncludeAvailableFilesInPrompt({ route = null, planningToolNames = [] } = {}) {
    const fileCentricTools = new Set(['AnalyzePDF', 'AnalyzeVideo', 'CreateMedia', 'SetBaseAvatar', 'ViewImages', 'WorkspaceSSH']);
    return planningToolNames.some(toolName => fileCentricTools.has(toolName));
}

function shouldIncludeDateTimeInPrompt() {
    return true;
}

function withVisibleModel(callArgs, model) {
    return {
        ...callArgs,
        modelOverride: model,
        model,
    };
}

function getRuntimeStage(resolver, fallback = 'research_batch') {
    return resolver.entityRuntimeState?.currentStage || fallback;
}

function isLatencyPrepareRequest(args = {}) {
    return String(args.requestedOutput || '')
        .trim()
        .toLowerCase() === LATENCY_PREPARE_REQUESTED_OUTPUT;
}

function withLatencyWarmOptions(callArgs = {}) {
    return {
        ...callArgs,
        stream: false,
        max_tokens: 1,
        max_output_tokens: 1,
    };
}

function stripToolTranscriptMessages(history = []) {
    return (history || []).filter((message) => {
        if (!message || typeof message !== 'object') return false;
        if (message.role === 'tool') return false;
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
        const content = typeof message.content === 'string'
            ? message.content.trim()
            : String(extractPlainTextFromMessageContent(message.content) || '').trim();
        if (!content) return false;
        if (content.startsWith('[Prior tool result:')) return false;
        return true;
    });
}

export function buildDelegateOnlyPlanningHistory(chatHistory = [], resolver = null, route = {}) {
    const history = stripToolTranscriptMessages(cloneMessages(chatHistory || []));
    const lastUserIdx = findLastConversationalUserIndex(history);
    const focusedHistory = lastUserIdx >= 0 ? history.slice(lastUserIdx) : trimFastPathHistory(history, 1, 3);
    const sourceFamilies = Array.from(new Set(
        (Array.isArray(route?.initialToolNames) ? route.initialToolNames : [])
            .map((toolName) => normalizeToolFamily(String(toolName || '').trim()))
            .filter((family) => family && family !== 'other')
    ));
    const briefParts = [
        'Delegate the research only.',
        'Return one DelegateResearch call with 2-3 short, non-overlapping tasks.',
        sourceFamilies.length > 0 ? `Prefer these source families first: ${sourceFamilies.join(', ')}.` : '',
        'Do not explain the plan or answer the user.',
    ].filter(Boolean);
    return insertSystemMessage(focusedHistory, briefParts.join(' '), getRequestId(resolver));
}

export function buildWorkerStartingHistory(chatHistory = [], resolver = null) {
    const history = stripToolTranscriptMessages(buildRunScopedSynthesisHistory(chatHistory, resolver));
    const conversationalTail = trimFastPathHistory(
        history.filter((message) => {
            const role = String(message?.role || '').toLowerCase();
            if (role !== 'user' && role !== 'human' && role !== 'assistant') return false;
            const content = String(extractPlainTextFromMessageContent(message?.content) || '').trim();
            if ((role === 'user' || role === 'human') && content.startsWith('[system message:')) return false;
            return true;
        }),
        2,
        4,
    );
    const preservedSystemMessages = history.filter((message) => {
        const role = String(message?.role || '').toLowerCase();
        if (role === 'system') return true;
        if (role !== 'user' && role !== 'human') return false;
        const content = String(extractPlainTextFromMessageContent(message?.content) || '').trim();
        return content.startsWith('[system message:');
    });
    return [...preservedSystemMessages, ...conversationalTail];
}

function buildEvidenceLedgerEntriesFromChatHistory(chatHistory = [], resolver = {}) {
    const history = Array.isArray(chatHistory) ? chatHistory : [];
    const startIdx = Math.max(0, Number(resolver?._preToolHistoryLength || 0));
    const entries = [];
    for (const message of history.slice(startIdx)) {
        if (message?.role !== 'tool' || !message?.name) continue;
        const content = String(message.content || '').trim();
        if (!content) continue;
        entries.push({
            toolName: String(message.name || ''),
            family: normalizeToolFamily(String(message.name || '')),
            content,
            metadata: {},
        });
    }
    return entries.slice(-12);
}

async function buildRuntimeEvidenceLedgerEntries(args, resolver, { limit = 12 } = {}) {
    const state = resolver?.entityRuntimeState;
    if (state?.store?.isConfigured?.() && state?.runId) {
        try {
            const docs = await state.store.listEvidence(state.runId, { limit });
            if (docs.length > 0) {
                return docs.reverse().map((doc) => ({
                    toolName: doc.toolName || 'Tool',
                    family: doc.family || 'other',
                    content: String(doc.content || doc.summary || doc.snippet || '').trim(),
                    metadata: doc.metadata || {},
                }));
            }
        } catch (error) {
            logEventError(getRequestId(resolver), 'runtime.evidence.error', { error: error.message, phase: 'list' });
        }
    }
    return buildEvidenceLedgerEntriesFromChatHistory(args.chatHistory, resolver);
}

export function buildRuntimeEvidenceLedgerText(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const lines = entries.map((entry) => {
        const toolName = String(entry.toolName || 'Tool').trim() || 'Tool';
        const toolArgs = entry.metadata?.toolArgs || {};
        const query = String(toolArgs.query || '').trim();
        const command = String(toolArgs.command || '').trim();
        const focus = query || command;
        const focusText = focus ? ` (${focus.slice(0, 90)})` : '';
        const body = String(entry.content || entry.summary || '').trim();
        if (!body) return `- ${toolName}${focusText}`;
        return `- ${toolName}${focusText}\n${body}`;
    });
    return `Runtime evidence ledger:\n${lines.join('\n\n')}`;
}

function getDirectReplySettings(route = {}) {
    if (route.reason === 'casual_reaction') {
        return {
            maxTurns: FAST_REACTION_MAX_TURNS,
            maxMessages: FAST_REACTION_MAX_MESSAGES,
            reasoningEffort: 'low',
        };
    }
    return {
        maxTurns: FAST_CHAT_MAX_TURNS,
        maxMessages: null,
        reasoningEffort: FAST_CHAT_REASONING_EFFORT,
    };
}

function extractLatestUsableAssistantDraft(history = [], response = null) {
    const directText = extractResponseText(response).trim();
    if (directText) return directText;

    let lastConversationalUserIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i];
        if (message?.role !== 'user' && message?.role !== 'human') continue;
        const content = typeof message.content === 'string'
            ? message.content
            : extractResponseText(message);
        const text = String(content || '').trim();
        if (!text) continue;
        if (text.startsWith('[system message:')) continue;
        if (text.startsWith('[Prior tool result:')) continue;
        lastConversationalUserIndex = i;
        break;
    }

    for (let i = history.length - 1; i >= 0; i--) {
        if (lastConversationalUserIndex >= 0 && i <= lastConversationalUserIndex) break;
        const message = history[i];
        if (message?.role !== 'assistant') continue;
        const content = typeof message.content === 'string'
            ? message.content
            : extractResponseText(message);
        const text = String(content || '').trim();
        if (!text) continue;
        if (text.startsWith('[Prior tool call:')) continue;
        if (text.startsWith('[Prior tool result:')) continue;
        if (text) return text;
    }

    return '';
}

async function markRuntimeStage(resolver, stage, note = '', meta = {}) {
    const state = resolver.entityRuntimeState;
    if (!state) return;
    state.currentStage = stage;
    syncRuntimeResultData(resolver, resolver.args || {});
    logEvent(getRequestId(resolver), 'runtime.stage', {
        runId: state.runId,
        stage,
        model: meta.model || null,
        stopReason: state.stopReason || null,
        budgetState: getRuntimeBudgetState(resolver) || {},
    });
    try {
        await getEntityRuntime().markStage(state.runId, stage, note, meta);
    } catch (error) {
        logEventError(getRequestId(resolver), 'runtime.stage.error', { runId: state.runId, stage, error: error.message });
    }
}

// Tools the cheap research model should never see or call.
// These are creative, mutation, or side-effect tools — the synthesis model
// can invoke them after reviewing evidence.
const EXECUTOR_BLOCKED_TOOLS = new Set([
    'createmedia', 'showoverlay', 'createchart',
    'generateslides', 'sendpushnotification', 'storecontinuitymemory',
]);

function isToolAllowedForRuntimeStage(toolName = '', stage = '') {
    return true;
}

function filterToolsForExecutor(toolsOpenAiFormat) {
    return toolsOpenAiFormat.filter(t => !EXECUTOR_BLOCKED_TOOLS.has(t.function?.name?.toLowerCase()));
}

function describeToolIntent(toolCall) {
    const toolName = toolCall?.function?.name || 'Tool';
    const args = safeParse(toolCall?.function?.arguments) || {};
    if (toolName === 'SearchInternet' || toolName === 'SearchXPlatform') {
        const query = args.q || args.text || args.query || '';
        return query
            ? `Gather external evidence for "${String(query).slice(0, 140)}".`
            : `Gather external evidence with ${toolName}.`;
    }
    if (toolName === 'FetchWebPageContentJina') {
        return args.url
            ? `Read and extract the cited source ${String(args.url).slice(0, 140)}.`
            : 'Read the cited source material.';
    }
    if (toolName === 'SearchMemory') return 'Check continuity memory for relevant prior context.';
    if (toolName === 'WorkspaceSSH') return 'Use the workspace to complete the task safely.';
    return `Use ${toolName} to progress the request.`;
}

async function finalizeRuntimeRun(args, resolver, response) {
    const state = resolver.entityRuntimeState;
    if (!state?.runId || state._finalized) return;
    state._finalized = true;

    const runtime = getEntityRuntime();
    const budgetState = getRuntimeBudgetState(resolver) || {};
    const resultText = getFinalAssistantText(resolver, response);
    const stopReason = state.stopReason || 'completed';
    const resultData = resolver.pathwayResultData || null;
    const conversationMode = normalizeConversationMode(state.conversationMode || args.runtimeConversationMode || 'chat');
    const conversationModeConfidence = normalizeModeConfidence(state.conversationModeConfidence || args.runtimeConversationModeConfidence || 'low');
    const isPulse = args.invocationType === 'pulse';
    const shouldPause = isPulse && stopReason !== 'completed';
    const finalStage = shouldPause ? 'rest' : 'done';

    await markRuntimeStage(
        resolver,
        finalStage,
        shouldPause ? 'Runtime paused run for later continuation' : 'Runtime completed run',
        {
            model: finalStage === 'rest' ? args.toolLoopModel : (args.synthesisModel || args.primaryModel),
            stopReason,
        }
    );

    if (shouldPause) {
        await runtime.pauseRun({
            runId: state.runId,
            reason: stopReason,
            budgetState,
            reflection: resultText.slice(0, 2000),
            resultData,
            conversationMode,
            conversationModeConfidence,
            modeUpdatedAt: state.modeUpdatedAt || new Date().toISOString(),
        });
        return;
    }

    await runtime.completeRun({
        runId: state.runId,
        result: resultText,
        stopReason,
        budgetState,
        resultData,
        conversationMode,
        conversationModeConfidence,
        modeUpdatedAt: state.modeUpdatedAt || new Date().toISOString(),
    });
}

function applyRuntimeToolEnvelope(toolCalls, resolver) {
    const state = resolver.entityRuntimeState;
    if (!state) {
        return { allowedToolCalls: toolCalls, skippedToolCalls: [], stopReason: null };
    }

    const allowedToolCalls = [];
    const skippedToolCalls = [];
    const perRoundLimit = state.authorityEnvelope.maxToolCallsPerRound || toolCalls.length;
    const stage = getRuntimeStage(resolver);
    let stopReason = null;

    for (const toolCall of toolCalls) {
        if (allowedToolCalls.length >= perRoundLimit) {
            skippedToolCalls.push(toolCall);
            stopReason = stopReason || 'per_round_tool_cap';
            continue;
        }

        const toolName = toolCall?.function?.name || '';
        if (!isToolAllowedForRuntimeStage(toolName, stage)) {
            skippedToolCalls.push(toolCall);
            stopReason = stopReason || 'stage_tool_block';
            continue;
        }
        const toolArgs = safeParse(toolCall?.function?.arguments) || {};
        const family = normalizeToolFamily(toolName);
        const semanticKey = buildSemanticToolKey(toolName, toolArgs);
        const repeatedCount = semanticKey ? (state.semanticToolCounts.get(semanticKey) || 0) : 0;

        if (family === 'search' && state.searchCalls >= state.authorityEnvelope.maxSearchCalls) {
            skippedToolCalls.push(toolCall);
            stopReason = stopReason || 'search_cap';
            continue;
        }

        if (family === 'fetch' && state.fetchCalls >= state.authorityEnvelope.maxFetchCalls) {
            skippedToolCalls.push(toolCall);
            stopReason = stopReason || 'fetch_cap';
            continue;
        }

        if (family === 'child' && state.childRuns >= state.authorityEnvelope.maxChildRuns) {
            skippedToolCalls.push(toolCall);
            stopReason = stopReason || 'child_cap';
            continue;
        }

        if (family === 'search' && semanticKey && repeatedCount >= state.authorityEnvelope.maxRepeatedSearches) {
            skippedToolCalls.push(toolCall);
            stopReason = stopReason || 'repeated_search_cap';
            continue;
        }

        allowedToolCalls.push(toolCall);

        if (family === 'search') state.searchCalls++;
        if (family === 'fetch') state.fetchCalls++;
        if (family === 'child') state.childRuns++;
        if (semanticKey) state.semanticToolCounts.set(semanticKey, repeatedCount + 1);
    }

    return { allowedToolCalls, skippedToolCalls, stopReason };
}

async function recordRuntimeEvidence(result, resolver, args) {
    const state = resolver.entityRuntimeState;
    if (!state || !result?.toolCall?.function?.name) return 0;

    const toolName = result.toolCall.function.name;
    const family = normalizeToolFamily(toolName);
    const semanticKey = buildSemanticToolKey(toolName, result.toolArgs || {});
    const isNewEvidence = semanticKey ? !state.semanticEvidenceKeys.has(semanticKey) : true;

    if (semanticKey && isNewEvidence) state.semanticEvidenceKeys.add(semanticKey);
    if (!isNewEvidence) return 0;

    state.evidenceItems++;

    const content = result.error
        ? `Error: ${result.error}`
        : typeof result.result?.result === 'string'
            ? result.result.result
            : JSON.stringify(result.result?.result ?? result.result ?? '');

    if (state.store?.isConfigured()) {
        try {
            await state.store.appendEvidence(state.runId, {
                entityId: args.entityId,
                toolName,
                family,
                semanticKey,
                content,
                summary: content,
                snippet: content,
                metadata: { toolArgs: result.toolArgs || {} },
            });
        } catch (error) {
            logEventError(getRequestId(resolver), 'runtime.evidence.error', { error: error.message });
        }
    }

    return 1;
}

function updateRuntimeNovelty(resolver, newEvidenceCount) {
    const state = resolver.entityRuntimeState;
    if (!state) return false;

    state.noveltyHistory.push(newEvidenceCount);
    if (state.noveltyHistory.length > state.authorityEnvelope.noveltyWindow) {
        state.noveltyHistory.shift();
    }

    const hasEnoughRounds = state.noveltyHistory.length >= state.authorityEnvelope.noveltyWindow;
    const noveltyTotal = state.noveltyHistory.reduce((sum, value) => sum + value, 0);
    const lowNovelty = hasEnoughRounds && noveltyTotal < state.authorityEnvelope.minNewEvidencePerWindow;
    const evidenceCapReached = state.evidenceItems >= state.authorityEnvelope.maxEvidenceItems;
    const insufficientGrounding = shouldBreakForInsufficientGrounding(resolver);

    if (lowNovelty) registerRuntimeStop(resolver, 'low_novelty');
    if (insufficientGrounding) registerRuntimeStop(resolver, 'insufficient_grounding');
    if (evidenceCapReached) registerRuntimeStop(resolver, 'evidence_cap');
    return lowNovelty || insufficientGrounding || evidenceCapReached;
}

export function shouldBreakForInsufficientGrounding(resolver = null) {
    const state = resolver?.entityRuntimeState;
    if (!state || state.stopReason) return false;

    const noveltyHistory = Array.isArray(state.noveltyHistory)
        ? state.noveltyHistory.map((value) => Math.max(0, Number(value) || 0))
        : [];
    const recentWindowSize = Math.max(2, Math.min(3, Number(state.authorityEnvelope?.noveltyWindow || 2)));
    const recentNovelty = noveltyHistory.slice(-recentWindowSize);
    const thinNovelty = recentNovelty.length >= 2
        && recentNovelty.every((value) => value <= 1)
        && recentNovelty.reduce((sum, value) => sum + value, 0) <= recentNovelty.length;
    const idleWorkerRounds = Math.max(0, Number(state.idleWorkerRounds || 0));

    const replanCount = Math.max(0, Number(resolver?.replanCount || 0));
    const evidenceItems = Math.max(0, Number(state.evidenceItems || 0));
    const childRuns = Math.max(0, Number(state.childRuns || 0));
    const toolBudgetUsed = Math.max(0, Number(resolver?.toolBudgetUsed || 0));
    const remainingNovelTasks = dedupePlanTasks(getDelegatedResearchTasks(resolver)).filter((task) => {
        const signature = getResearchTaskSignature(task);
        return !getAttemptedTaskSignatures(state).some((prior) => areResearchTaskSignaturesSimilar(signature, prior));
    }).length;
    const enoughEffort = replanCount >= 1
        && (evidenceItems >= 4 || childRuns >= Math.min(4, getMaxFanoutWidth(state)) || toolBudgetUsed >= 30);
    const weakFollowUpWave = replanCount >= 1 && idleWorkerRounds >= 1 && remainingNovelTasks === 0;
    const thinNoveltyPlateau = enoughEffort && thinNovelty && (replanCount >= 2 || remainingNovelTasks === 0);

    return weakFollowUpWave || thinNoveltyPlateau;
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

function interceptDelegateResearch(delegateCalls, preToolCallMessages, resolver) {
    return delegateCalls.map((delegateCall) => {
        const plan = extractDelegateResearchPlan(delegateCall);
        const appliedPlan = plan
            ? applyToolPlan(plan, resolver, { source: 'supervisor_delegate_stream' })
            : null;
        const delegateMessages = cloneMessages(preToolCallMessages);
        delegateMessages.push({
            role: "assistant",
            content: "",
            tool_calls: [buildToolCallEntry(delegateCall, delegateCall.function.arguments)],
        });
        delegateMessages.push({
            role: "tool",
            tool_call_id: delegateCall.id,
            name: delegateCall.function.name,
            content: JSON.stringify({
                success: !!appliedPlan,
                message: appliedPlan ? 'Worker delegation acknowledged.' : 'Worker delegation could not be parsed.',
            }),
        });
        return {
            success: !!appliedPlan,
            toolCall: delegateCall,
            toolArgs: plan || {},
            toolFunction: DELEGATE_RESEARCH_TOOL_NAME,
            messages: delegateMessages,
            skipBudget: true,
        };
    });
}

function interceptDelegateTask(delegateCalls, preToolCallMessages, resolver) {
    return delegateCalls.map((delegateCall) => {
        const plan = extractDelegateTaskPlan(delegateCall);
        const appliedPlan = plan
            ? applyToolPlan(plan, resolver, { source: 'supervisor_delegate_task_stream' })
            : null;
        const delegateMessages = cloneMessages(preToolCallMessages);
        delegateMessages.push({
            role: "assistant",
            content: "",
            tool_calls: [buildToolCallEntry(delegateCall, delegateCall.function.arguments)],
        });
        delegateMessages.push({
            role: "tool",
            tool_call_id: delegateCall.id,
            name: delegateCall.function.name,
            content: JSON.stringify({
                success: !!appliedPlan,
                message: appliedPlan ? 'Task delegation acknowledged.' : 'Task delegation could not be parsed.',
            }),
        });
        return {
            success: !!appliedPlan,
            toolCall: delegateCall,
            toolArgs: plan || {},
            toolFunction: DELEGATE_TASK_TOOL_NAME,
            messages: delegateMessages,
            skipBudget: true,
        };
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
        const semanticCacheKey = resolver.entityRuntimeState
            ? buildSemanticToolKey(toolCall.function.name, toolArgs)
            : null;
        const cachedResult = resolver.toolCallCache?.get(cacheKey)
            || (semanticCacheKey ? resolver.semanticToolCache?.get(semanticCacheKey) : null);
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
        let toolUserMessage = toolArgs.userMessage || buildDefaultToolUserMessage(toolName, toolArgs);
        const emojiMatch = typeof toolUserMessage === 'string'
            ? toolUserMessage.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u)
            : null;
        const toolIcon = emojiMatch
            ? emojiMatch[1]
            : (toolArgs.icon || toolDef?.icon || '🛠️');
        if (emojiMatch) {
            toolUserMessage = toolUserMessage.slice(emojiMatch[0].length);
        }

        if (!hideExecution) {
            try { await sendToolStart(rid, toolCallId, toolIcon, toolUserMessage, toolName, toolArgs); } catch { /* non-fatal */ }
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
        if (semanticCacheKey) resolver.semanticToolCache?.set(semanticCacheKey, toolResultContent);

        const errorMessage = detectToolError(toolResult, toolName);
        const hasError = errorMessage !== null;
        const newEvidenceCount = await recordRuntimeEvidence(
            { result: toolResult, error: errorMessage, toolCall, toolArgs },
            resolver,
            args
        );

        if (!hideExecution) {
            try { await sendToolFinish(rid, toolCallId, !hasError, errorMessage, toolName); } catch { /* non-fatal */ }
        }

        logEvent(rid, 'tool.exec', {
            tool: toolName, round: (resolver.toolCallRound || 0) + 1, durationMs: Date.now() - toolStart,
            success: !hasError, ...(hasError && { error: errorMessage }),
            resultChars: toolResultContent?.length || 0, ...(toolResultContent?.length > MAX_TOOL_RESULT_LENGTH && { truncated: true }),
            toolArgs: summarizeReturnedCalls([toolCall])?.[0]?.args,
        });

        return {
            success: !hasError,
            result: toolResult,
            error: errorMessage,
            toolCall,
            toolArgs,
            toolFunction,
            messages: toolMessages,
            toolImages: toolResult?.toolImages || [],
            newEvidenceCount,
        };
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
    const toolBudgetLimit = getToolBudgetLimit(args, resolver);

    if (!toolCalls || toolCalls.length === 0) return { messages: finalMessages, budgetExhausted: false };

    if (resolver.toolBudgetUsed >= toolBudgetLimit) {
        registerRuntimeStop(resolver, 'tool_budget_cap');
        finalMessages = insertSystemMessage(finalMessages, "Tool budget exhausted - no more tool calls will be executed. Provide your response based on the information gathered so far.", rid);
        args.chatHistory = finalMessages;
        return { messages: finalMessages, budgetExhausted: true };
    }

    const invalidToolCalls = toolCalls.filter(tc => !tc || !tc.function || !tc.function.name);
    if (invalidToolCalls.length > 0) {
        logEvent(rid, 'tool.round', { round: (resolver.toolCallRound || 0) + 1, invalidCount: invalidToolCalls.length, budgetExhausted: true });
        resolver.toolBudgetUsed = toolBudgetLimit;
        args.chatHistory = finalMessages;
        return { messages: finalMessages, budgetExhausted: true };
    }

    const validToolCalls = toolCalls.filter(tc => tc && tc.function && tc.function.name);
    const activeToolNames = resolver?._activeToolNames instanceof Set
        ? resolver._activeToolNames
        : new Set(
            (Array.isArray(resolver?._activeToolNames) ? resolver._activeToolNames : [])
                .map((name) => String(name || '').trim().toLowerCase())
                .filter(Boolean),
        );
    const undeclaredToolCalls = activeToolNames.size > 0
        ? validToolCalls.filter((tc) => !activeToolNames.has(String(tc.function.name || '').trim().toLowerCase()))
        : [];
    const declaredToolCalls = undeclaredToolCalls.length > 0
        ? validToolCalls.filter((tc) => activeToolNames.has(String(tc.function.name || '').trim().toLowerCase()))
        : validToolCalls;
    if (undeclaredToolCalls.length > 0) {
        finalMessages = insertSystemMessage(
            finalMessages,
            `The runtime ignored ${undeclaredToolCalls.length} tool call(s) because they were not exposed for this model step. Continue with the tools you actually have available.`,
            rid,
        );
    }
    const setGoalsCalls = declaredToolCalls.filter(tc => tc.function.name.toLowerCase() === SET_GOALS_TOOL_NAME);
    const delegateResearchCalls = declaredToolCalls.filter(tc => tc.function.name.toLowerCase() === DELEGATE_RESEARCH_TOOL_NAME);
    const delegateTaskCalls = declaredToolCalls.filter(tc => tc.function.name.toLowerCase() === DELEGATE_TASK_TOOL_NAME);
    const proposedToolCalls = declaredToolCalls.filter(tc => ![SET_GOALS_TOOL_NAME, DELEGATE_RESEARCH_TOOL_NAME, DELEGATE_TASK_TOOL_NAME].includes(tc.function.name.toLowerCase()));
    const { allowedToolCalls, skippedToolCalls, stopReason } = applyRuntimeToolEnvelope(proposedToolCalls, resolver);
    const realToolCalls = allowedToolCalls;
    const benignSynthesisReplanBlock = (
        stopReason === 'stage_tool_block'
        && getRuntimeStage(resolver) === 'synthesize'
        && (setGoalsCalls.length > 0 || delegateResearchCalls.length > 0 || delegateTaskCalls.length > 0)
    );
    resolver._cycleExecutedToolCount = (resolver._cycleExecutedToolCount || 0) + realToolCalls.length;
    markToolExecution(resolver, realToolCalls.length);

    const setGoalsResults = interceptSetGoals(setGoalsCalls, preToolCallMessages, resolver);
    const delegateResearchResults = interceptDelegateResearch(delegateResearchCalls, preToolCallMessages, resolver);
    const delegateTaskResults = interceptDelegateTask(delegateTaskCalls, preToolCallMessages, resolver);
    const toolResults = await Promise.all(realToolCalls.map(tc => executeSingleTool(tc, preToolCallMessages, args, resolver, entityTools)));
    const allToolResults = [...setGoalsResults, ...delegateResearchResults, ...delegateTaskResults, ...toolResults];

    finalMessages.push(...mergeParallelToolResults(allToolResults, preToolCallMessages));
    if (skippedToolCalls.length > 0 && !benignSynthesisReplanBlock) {
        if (stopReason !== 'stage_tool_block') {
            registerRuntimeStop(resolver, stopReason || 'tool_envelope_cap');
        }
        finalMessages = insertSystemMessage(
            finalMessages,
            stopReason === 'stage_tool_block'
                ? `The runtime held back ${skippedToolCalls.length} tool call(s) because they are not available in this stage. Synthesize from the evidence you have or change strategy.`
                : `The runtime held back ${skippedToolCalls.length} tool call(s) because the current energy envelope was reached. Synthesize from the evidence you have, narrow the scope, or explicitly say you need more budget.`,
            rid
        );
    }

    // Inject tool images into chat history so subsequent model calls can see them
    const allToolImages = allToolResults.flatMap(r => r.toolImages || []);
    if (allToolImages.length > 0) {
        finalMessages.push({
            role: "user",
            content: allToolImages.map(img => ({
                type: "image_url",
                url: img.url,
                gcs: img.gcs,
                image_url: { url: img.url },
            }))
        });
    }

    // Budget & round accounting
    const budgetCost = allToolResults.reduce((sum, r) => {
        if (r.skipBudget) return sum;
        const def = entityTools[r.toolFunction]?.definition;
        return sum + Math.max(1, def?.toolCost ?? DEFAULT_TOOL_COST);
    }, 0);
    resolver.toolBudgetUsed = (resolver.toolBudgetUsed || 0) + budgetCost;
    resolver.toolCallRound = (resolver.toolCallRound || 0) + 1;
    syncRuntimeResultData(resolver, args);

    logEvent(rid, 'tool.round', {
        round: resolver.toolCallRound,
        toolCount: validToolCalls.length,
        executedToolCount: realToolCalls.length,
        failed: allToolResults.filter(r => r && !r.success).length,
        budgetUsed: resolver.toolBudgetUsed,
        budgetTotal: toolBudgetLimit,
        ...(skippedToolCalls.length > 0 && {
            skippedToolCalls: skippedToolCalls.length,
            stopReason,
            ...(benignSynthesisReplanBlock && { blockedDuringSynthesisReplan: true }),
        }),
    });

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

    // Signal if EndPulse was called — executor loop should stop immediately
    const endPulseCalled = realToolCalls.some(tc => tc.function.name === 'EndPulse');
    const newEvidenceCount = allToolResults.reduce((sum, result) => sum + (result?.newEvidenceCount || 0), 0);
    const lowNovelty = updateRuntimeNovelty(resolver, newEvidenceCount);
    if (lowNovelty) {
        args.chatHistory = insertSystemMessage(
            args.chatHistory,
            'Recent tool rounds are yielding little new evidence. Synthesize from what you have or explicitly ask for more budget if the remaining uncertainty matters.',
            rid
        );
    }

    if (endPulseCalled) {
        registerRuntimeStop(resolver, 'rest');
    }

    return {
        messages: args.chatHistory,
        delegatedResearch: delegateResearchCalls.length > 0 || delegateTaskCalls.length > 0,
        budgetExhausted: resolver.toolBudgetUsed >= toolBudgetLimit || (skippedToolCalls.length > 0 && !benignSynthesisReplanBlock) || lowNovelty,
        endPulseCalled,
    };
}

// ─── Context Management ──────────────────────────────────────────────────────

function estimateTokens(messages) {
    if (!messages || !Array.isArray(messages)) return 0;

    const estimateStringTokens = (text = '') => {
        if (!text) return 0;
        // Full tokenization is unnecessarily expensive for very large blobs.
        // This is a budgeting heuristic, so use a fast approximation once the
        // string is large enough that exact precision no longer matters.
        if (text.length > 8000) return Math.ceil(text.length / 4);
        return encode(text).length;
    };

    let total = 0;
    for (const msg of messages) {
        total += 4;
        if (typeof msg.content === 'string') {
            total += estimateStringTokens(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (typeof part === 'string') total += estimateStringTokens(part);
                else if (part?.text) total += estimateStringTokens(part.text);
                else if (part?.type === 'image_url') total += 85;
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += 10;
                if (tc.function?.name) total += estimateStringTokens(tc.function.name);
                if (tc.function?.arguments) total += estimateStringTokens(tc.function.arguments);
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

function isClaudeModel(model = '') {
    return String(model || '').toLowerCase().includes('claude');
}

function stringifyToolHistoryContent(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (Array.isArray(content)) {
        return content.map((item) => {
            if (typeof item === 'string') return item;
            if (item?.type === 'text' && typeof item.text === 'string') return item.text;
            try {
                return JSON.stringify(item);
            } catch {
                return String(item);
            }
        }).filter(Boolean).join('\n');
    }
    try {
        return JSON.stringify(content);
    } catch {
        return String(content);
    }
}

function appendSanitizedMessage(messages, role, content) {
    const text = String(content || '').trim();
    if (!text) return;
    const prior = messages[messages.length - 1];
    if (prior && prior.role === role && typeof prior.content === 'string' && !prior.tool_calls) {
        prior.content = `${prior.content}\n${text}`;
        return;
    }
    messages.push({ role, content: text });
}

function summarizePriorToolCall(toolCall) {
    const name = toolCall?.function?.name || 'UnknownTool';
    const rawArgs = toolCall?.function?.arguments;
    const parsedArgs = typeof rawArgs === 'string' ? safeParse(rawArgs) : rawArgs;
    const argsText = stringifyToolHistoryContent(parsedArgs ?? rawArgs);
    return argsText
        ? `[Prior tool call: ${name}] ${argsText}`
        : `[Prior tool call: ${name}]`;
}

function summarizePriorToolResult(toolName, content) {
    const body = stringifyToolHistoryContent(content);
    return body
        ? `[Prior tool result: ${toolName}]\n${body}`
        : `[Prior tool result: ${toolName}]`;
}

function sanitizeToolHistoryForRestrictedTools(chatHistory, activeToolNames = []) {
    const allowedNames = new Set(
        (activeToolNames || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean)
    );
    const toolNameById = new Map();

    for (const msg of chatHistory || []) {
        if (!Array.isArray(msg?.tool_calls)) continue;
        for (const toolCall of msg.tool_calls) {
            if (!toolCall?.id) continue;
            toolNameById.set(toolCall.id, String(toolCall?.function?.name || '').trim().toLowerCase());
        }
    }

    const sanitized = [];
    for (const msg of chatHistory || []) {
        if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
            const allowedCalls = [];
            const blockedSummaries = [];

            for (const toolCall of msg.tool_calls) {
                const toolName = String(toolCall?.function?.name || '').trim().toLowerCase();
                if (allowedNames.has(toolName)) {
                    allowedCalls.push(toolCall);
                } else {
                    blockedSummaries.push(summarizePriorToolCall(toolCall));
                }
            }

            if (allowedCalls.length > 0 || msg.content) {
                sanitized.push({
                    ...msg,
                    ...(allowedCalls.length > 0 ? { tool_calls: allowedCalls } : {}),
                    ...(allowedCalls.length === 0 ? { tool_calls: undefined } : {}),
                });
            }

            if (blockedSummaries.length > 0) {
                appendSanitizedMessage(sanitized, 'assistant', blockedSummaries.join('\n'));
            }
            continue;
        }

        if (msg?.role === 'tool') {
            const toolName = String(
                msg.name
                || toolNameById.get(msg.tool_call_id)
                || 'UnknownTool'
            ).trim();
            if (allowedNames.has(toolName.toLowerCase())) {
                sanitized.push(msg);
            } else {
                appendSanitizedMessage(sanitized, 'user', summarizePriorToolResult(toolName, msg.content));
            }
            continue;
        }

        sanitized.push(msg);
    }

    return sanitized;
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
    const priorText = message instanceof CortexResponse
        ? message.output_text
        : (typeof message?.content === 'string' ? message.content : '');
    if (priorText?.trim()) {
        args.chatHistory = [...(args.chatHistory || []), { role: 'assistant', content: priorText }];
    }
}

async function runFallbackPath(currentToolCalls, args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    consumeInjectedAgentMessages(args, resolver);
    await markRuntimeStage(resolver, 'plan', 'Running fallback single-model path', {
        model: args.planningModel || args.primaryModel,
    });
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

        let fallbackResult = await callModelLogged(resolver, withVisibleModel({
            ...args, stream: args.stream, tools: entityToolsOpenAiFormat,
            tool_choice: "auto", reasoningEffort: args.planningReasoningEffort || args.configuredReasoningEffort || 'low', skipMemoryLoad: true,
        }, args.planningModel || args.primaryModel), 'fallback', { model: args.planningModel || args.primaryModel });

        if (!fallbackResult) return await handlePromptError(null);

        const holder = { value: fallbackResult };
        await drainStreamingCallbacks(resolver)(holder);
        return holder.value;
    } catch (e) {
        return await handlePromptError(e);
    }
}

async function enforceGate(currentToolCalls, args, resolver, entityToolsOpenAiFormat, callbackDepth, handlePromptError) {
    if (currentToolCalls.length > 0 && !passesGate(currentToolCalls)) {
        logEvent(getRequestId(resolver), 'plan.skipped', {
            reason: 'missing_setgoals',
            callbackDepth,
            synthesizedServerSide: true,
            availableTools: entityToolsOpenAiFormat.length,
        });
        synthesizeServerPlan(currentToolCalls, args, resolver);
    }
    return { toolCalls: currentToolCalls, error: null };
}

async function executorLoop(args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    const researchTools = filterToolsForExecutor(entityToolsOpenAiFormat);
    while (resolver.toolBudgetUsed < getToolBudgetLimit(args, resolver) && (resolver.toolCallRound || 0) < getResearchRoundLimit(resolver)) {
        consumeInjectedAgentMessages(args, resolver);
        const rid = getRequestId(resolver);
        await markRuntimeStage(resolver, 'research_batch', 'Running bounded research loop', {
            model: args.toolLoopModel,
            round: (resolver.toolCallRound || 0) + 1,
        });
        if (resolver.toolPlan) logEvent(rid, 'plan.step', { round: resolver.toolCallRound || 0, steps: resolver.toolPlan.steps.length });
        args.chatHistory = insertSystemMessage(args.chatHistory, buildStepInstruction(resolver), rid);

        try {
            const result = await callModelLogged(resolver, withVisibleModel({
                ...args, stream: false, tools: researchTools,
                tool_choice: "auto", reasoningEffort: args.researchReasoningEffort || args.configuredReasoningEffort || 'low', skipMemoryLoad: true,
            }, args.toolLoopModel), 'tool_loop', { model: args.toolLoopModel, round: resolver.toolCallRound, hasPlan: !!resolver.toolPlan });

            if (!result) return await handlePromptError(null);
            const calls = extractToolCalls(result);
            if (calls.length === 0) break; // SYNTHESIZE

            const { budgetExhausted, endPulseCalled } = await processToolCallRound(calls, args, resolver, entityTools);
            if (budgetExhausted || endPulseCalled) break;
        } catch (e) {
            return await handlePromptError(e);
        }
    }
    if ((resolver.toolCallRound || 0) >= getResearchRoundLimit(resolver)) {
        registerRuntimeStop(resolver, 'research_round_cap');
    }
    if (resolver.toolBudgetUsed >= getToolBudgetLimit(args, resolver)) {
        registerRuntimeStop(resolver, 'tool_budget_cap');
    }
    return null;
}

async function runAutonomousWorkerTask({
    task,
    args,
    resolver,
    entityTools,
    researchTools,
    childModel,
    childReasoningEffort,
    workerGoal,
    workerTaskIndex,
    workerTaskCount,
    handlePromptError,
}) {
    const workerArgs = {
        ...args,
        stream: false,
        tools: researchTools,
        tool_choice: 'auto',
        reasoningEffort: childReasoningEffort,
        skipMemoryLoad: true,
        chatHistory: buildWorkerStartingHistory(args.chatHistory || [], resolver),
        workerGoal,
        workerTaskBrief: task,
        workerTaskIndex,
        workerTaskCount,
    };
    const baseMessageCount = workerArgs.chatHistory.length;
    const seenToolCallSignatures = new Set();
    let rounds = 0;

    while (
        rounds < MAX_CHILD_WORKER_ROUNDS
        && resolver.toolBudgetUsed < getToolBudgetLimit(args, resolver)
        && !resolver.entityRuntimeState?.stopReason
    ) {
        const result = await callModelLogged(resolver, withVisibleModel(workerArgs, childModel), 'child_fanout', {
            model: childModel,
            round: resolver.toolCallRound,
            fanoutIndex: workerTaskIndex,
            fanoutTask: task.slice(0, 160),
            workerRound: rounds + 1,
        });

        if (!result) {
            return { error: await handlePromptError(null) };
        }

        const calls = dedupeToolCallsBySignature(extractToolCalls(result));
        if (calls.length === 0) {
            return {
                status: rounds > 0 ? 'complete' : 'idle',
                rounds,
                task,
                messages: extractWorkerMessages(workerArgs.chatHistory, baseMessageCount),
            };
        }

        const novelCalls = calls.filter((toolCall) => {
            const signature = getToolCallSignature(toolCall);
            if (!signature || seenToolCallSignatures.has(signature)) return false;
            seenToolCallSignatures.add(signature);
            return true;
        });

        if (novelCalls.length === 0) {
            return {
                status: rounds > 0 ? 'stalled' : 'idle',
                rounds,
                task,
                messages: extractWorkerMessages(workerArgs.chatHistory, baseMessageCount),
            };
        }

        const toolRoundResult = await queueResolverToolWork(
            resolver,
            () => processToolCallRound(novelCalls, workerArgs, resolver, entityTools),
        );
        rounds++;

        if (toolRoundResult.budgetExhausted || toolRoundResult.endPulseCalled) {
            return {
                status: toolRoundResult.endPulseCalled ? 'rest' : 'budget_exhausted',
                rounds,
                task,
                messages: extractWorkerMessages(workerArgs.chatHistory, baseMessageCount),
            };
        }
    }

    return {
        status: resolver.entityRuntimeState?.stopReason ? 'stopped' : 'round_cap',
        rounds,
        task,
        messages: extractWorkerMessages(workerArgs.chatHistory, baseMessageCount),
    };
}

async function runDelegatedWorkerRound(args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    const researchTools = filterToolsForExecutor(entityToolsOpenAiFormat);
    const rid = getRequestId(resolver);

    consumeInjectedAgentMessages(args, resolver);
    await markRuntimeStage(resolver, 'research_batch', 'Running delegated autonomous worker round', {
        model: args.childModel || args.toolLoopModel,
        round: (resolver.toolCallRound || 0) + 1,
        fanout: true,
    });
    if (resolver.toolPlan) {
        logEvent(rid, 'plan.step', {
            round: resolver.toolCallRound || 0,
            steps: resolver.toolPlan.steps.length,
            fanout: true,
        });
    }
    args.chatHistory = insertSystemMessage(args.chatHistory, buildStepInstruction(resolver), rid);

    const tasks = selectFanoutTasks(resolver);
    if (tasks.length === 0) {
        if (resolver.entityRuntimeState) {
            resolver.entityRuntimeState.idleWorkerRounds = (resolver.entityRuntimeState.idleWorkerRounds || 0) + 1;
            syncRuntimeResultData(resolver, args);
        }
        logEvent(rid, 'plan.worker_idle', {
            round: (resolver.toolCallRound || 0) + 1,
            hasPlan: !!resolver.toolPlan,
            reason: getFanoutIdleReason(resolver),
            fanout: true,
        });
        return {
            done: false,
            budgetExhausted: false,
            endPulseCalled: false,
            workerYieldedNoTools: true,
        };
    }

    const childModel = args.childModel || args.toolLoopModel;
    const childReasoningEffort = args.childReasoningEffort || args.researchReasoningEffort || args.configuredReasoningEffort || 'low';
    const workerGoal = getDelegatedResearchGoal(resolver, args);
    rememberAttemptedTasks(resolver, tasks);
    for (const task of tasks) {
        updateResearchTaskStatus(resolver, task, 'running');
    }

    if (resolver.entityRuntimeState) {
        resolver.entityRuntimeState.childRuns = (resolver.entityRuntimeState.childRuns || 0) + tasks.length;
        syncRuntimeResultData(resolver, args);
    }

    logEvent(rid, 'plan.fanout.start', {
        round: (resolver.toolCallRound || 0) + 1,
        childRuns: tasks.length,
        model: childModel,
        taskCount: tasks.length,
        taskList: tasks,
    });

    const workerSettled = await Promise.allSettled(tasks.map((task, index) => (
        runAutonomousWorkerTask({
            task,
            args,
            resolver,
            entityTools,
            researchTools,
            childModel,
            childReasoningEffort,
            workerGoal,
            workerTaskIndex: index + 1,
            workerTaskCount: tasks.length,
            handlePromptError,
        })
    )));

    const workerErrors = workerSettled.filter((result) => result.status === 'rejected');
    if (workerErrors.length === workerSettled.length) {
        return { response: await handlePromptError(workerErrors[0].reason), done: true };
    }

    const mergedMessages = [];
    let idleWorkers = 0;
    let activeWorkers = 0;
    for (const result of workerSettled) {
        if (result.status === 'rejected') {
            logEventError(rid, 'plan.fanout.worker_error', {
                error: result.reason?.message || String(result.reason || 'unknown child worker error'),
            });
            continue;
        }
        if (result.value?.error) {
            return { response: result.value.error, done: true };
        }
        updateResearchTaskStatus(
            resolver,
            result.value?.task || '',
            ['budget_exhausted', 'stopped'].includes(result.value?.status) ? 'blocked' : 'completed',
        );
        if (!result.value?.messages?.length) {
            idleWorkers++;
            continue;
        }
        activeWorkers++;
        mergedMessages.push(...result.value.messages);
    }
    logEvent(rid, 'plan.fanout.complete', {
        round: (resolver.toolCallRound || 0) + 1,
        childRuns: tasks.length,
        idleWorkers,
        failedWorkers: workerErrors.length,
        activeWorkers,
        mergedMessages: mergedMessages.length,
    });

    if (mergedMessages.length === 0) {
        if (resolver.entityRuntimeState) {
            resolver.entityRuntimeState.idleWorkerRounds = (resolver.entityRuntimeState.idleWorkerRounds || 0) + 1;
            syncRuntimeResultData(resolver, args);
        }
        logEvent(rid, 'plan.worker_idle', {
            round: (resolver.toolCallRound || 0) + 1,
            hasPlan: !!resolver.toolPlan,
            fanout: true,
            idleWorkers,
            failedWorkers: workerErrors.length,
        });
        return {
            done: false,
            budgetExhausted: false,
            endPulseCalled: false,
            workerYieldedNoTools: true,
        };
    }

    if (resolver.entityRuntimeState) {
        resolver.entityRuntimeState.idleWorkerRounds = 0;
        syncRuntimeResultData(resolver, args);
    }
    args.chatHistory = [...(args.chatHistory || []), ...mergedMessages];
    syncRuntimeResultData(resolver, args);
    return {
        done: false,
        budgetExhausted: !!resolver.entityRuntimeState?.stopReason,
        endPulseCalled: resolver.entityRuntimeState?.stopReason === 'rest',
        workerYieldedNoTools: false,
    };
}

async function finalizeSynthesisFromEvidence(args, resolver, handlePromptError, effectiveChatHistory, guardReason, callbackDepth = 0, fallbackResponse = null) {
    if (guardReason === 'no_executable_work') {
        const draftText = extractLatestUsableAssistantDraft(effectiveChatHistory, fallbackResponse);
        if (draftText) {
            logEvent(getRequestId(resolver), 'plan.finalize_short_circuit', {
                reason: guardReason,
                callbackDepth,
                contentChars: draftText.length,
            });
            markAnswerProduced(resolver, 'agentic_synthesis');
            return { result: draftText, done: true };
        }
    }

    const uncertaintyForwardReasons = new Set([
        'low_novelty',
        'insufficient_grounding',
        'same_plan',
        'no_novel_tasks',
        'replan_cap',
    ]);
    const finalizeInstruction = uncertaintyForwardReasons.has(String(guardReason || '').trim())
        ? `[system message: ${getRequestId(resolver)}:finalize] Research is complete for this run. Do not call DelegateResearch or any tools again. Answer the user now with the best response you can from the evidence gathered so far. Any factual answer you give must appear explicitly in the evidence already gathered. Do not infer or guess missing facts. If the evidence is sparse, indirect, or incomplete, say clearly what you do know, what you could not confirm yet, and that you may not know much about this topic yet. Be direct, grounded, and positive rather than apologetic. Start with the answer itself in your normal voice. If grounded in search, place :cd_source[searchResultId] immediately after the supported sentence. Do not restate instructions, citation rules, tool rules, or process notes.`
        : `[system message: ${getRequestId(resolver)}:finalize] Research is complete for this run. Do not call DelegateResearch or any tools again. Answer the user now with the best response you can from the evidence gathered so far. Any factual answer you give must appear explicitly in the evidence already gathered. Do not infer or guess missing facts. If you could not complete the requested action, say what blocked completion. Start with the answer itself in your normal voice. If grounded in search, place :cd_source[searchResultId] immediately after the supported sentence. Do not restate instructions, citation rules, tool rules, or process notes.`;

    const finalized = await callModelLogged(resolver, withVisibleModel({
        ...args,
        chatHistory: [
            ...(effectiveChatHistory || []),
            {
                role: 'user',
                content: finalizeInstruction,
            },
        ],
        stream: args.stream,
        tools: [],
        reasoningEffort: args.synthesisReasoningEffort || args.configuredReasoningEffort || 'medium',
        skipMemoryLoad: true,
    }, args.synthesisModel || args.primaryModel), 'synthesis_finalize', {
        model: args.synthesisModel || args.primaryModel,
        callbackDepth,
        guardReason,
    });

    if (!finalized) {
        return { result: await handlePromptError(null), done: true };
    }

    const finalizedHolder = { value: finalized };
    await drainStreamingCallbacks(resolver)(finalizedHolder);
    markAnswerProduced(resolver, 'agentic_synthesis');
    return { result: finalizedHolder.value, done: true };
}

function findLastConversationalUserIndex(history = [], endExclusive = history.length) {
    for (let i = Math.min(endExclusive, history.length) - 1; i >= 0; i--) {
        const message = history[i];
        if (message?.role !== 'user' && message?.role !== 'human') continue;
        const text = String(extractPlainTextFromMessageContent(message?.content) || '').trim();
        if (!text) continue;
        if (text.startsWith('[system message:')) continue;
        if (text.startsWith('[Prior tool result:')) continue;
        return i;
    }
    return -1;
}

function buildRunScopedSynthesisHistory(chatHistory = [], resolver = {}) {
    const history = Array.isArray(chatHistory)
        ? chatHistory.map((msg) => ({ ...msg }))
        : [];
    const startIdx = Math.max(0, Number(resolver?._preToolHistoryLength || 0));
    if (startIdx <= 0 || startIdx >= history.length) return history;

    const currentTurnStart = findLastConversationalUserIndex(history, startIdx);
    if (currentTurnStart < 0) {
        return history.slice(startIdx);
    }

    return [
        ...history.slice(currentTurnStart, startIdx),
        ...history.slice(startIdx),
    ];
}

async function prepareForSynthesis(args, resolver) {
    const rid = getRequestId(resolver);
    let synthesisHistory = isEntityRuntimeEnabled(args)
        ? buildRunScopedSynthesisHistory(args.chatHistory, resolver)
        : (Array.isArray(args.chatHistory)
            ? args.chatHistory.map((msg) => ({ ...msg }))
            : []);
    // Strip SYNTHESIZE hints
    synthesisHistory = synthesisHistory.filter(msg => {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (msg.role === 'user') {
            return !content.startsWith(`[system message: ${rid}]`);
        }
        if (msg.role === 'system') {
            return !content.startsWith(`${SYNTHESIS_REVIEW_MARKER} ${rid}`);
        }
        return true;
    });
    synthesisHistory = stripSetGoalsFromHistory(synthesisHistory);
    const synthesisModel = args.synthesisModel || args.primaryModel || '';
    if (isEntityRuntimeEnabled(args)) {
        synthesisHistory = stripToolTranscriptMessages(synthesisHistory);
        synthesisHistory = sanitizeToolHistoryForRestrictedTools(synthesisHistory, []);
        const evidenceEntries = await buildRuntimeEvidenceLedgerEntries(args, resolver);
        const evidenceLedgerText = buildRuntimeEvidenceLedgerText(evidenceEntries);
        if (evidenceLedgerText) {
            synthesisHistory = insertTaggedSystemTurn(synthesisHistory, evidenceLedgerText, {
                requestId: rid,
                marker: EVIDENCE_LEDGER_MARKER,
            });
            resolver.pathwayResultData = {
                ...(resolver.pathwayResultData || {}),
                evidenceLedger: evidenceEntries,
            };
        }
        const reviewGoal = getDelegatedResearchGoal(resolver, args);
        const reviewInstruction = isGeminiModel(synthesisModel)
            ? `Look at the evidence above against the active request (Goal: ${reviewGoal}).\nIf you can answer now, answer in your normal voice using only grounded facts.\nIf the evidence is sparse or indirect, it is good to say clearly what you do know and what you still do not know yet.\nIf one bounded follow-up task remains, call DelegateTask with that single task.\nIf more information gathering is needed in parallel, call DelegateResearch with concrete missing findings split into parallel tasks.\nDo not infer or guess missing facts.`
            : `Look at the evidence above against the active request (Goal: ${reviewGoal}).\nIf you can answer now, answer directly in your normal voice.\nIf the evidence is sparse or indirect, say clearly what you do know and what you still do not know yet.\nIf one bounded follow-up task remains, call DelegateTask with that single task.\nIf more information gathering is needed in parallel, call DelegateResearch with concrete missing findings split into parallel tasks.\nAny factual answer you give must appear explicitly in the evidence above. Do not infer or guess missing facts.\nStart with the answer itself.\nDo not restate instructions, citation rules, tool rules, or process notes.`;
        synthesisHistory = isClaudeModel(synthesisModel)
            ? insertTaggedSystemTurn(synthesisHistory, reviewInstruction, { requestId: rid })
            : insertSystemMessage(synthesisHistory, reviewInstruction, rid);
        return synthesisHistory;
    }
    if (resolver.toolPlan) {
        const reviewInstruction = isGeminiModel(synthesisModel)
            ? `Look at the tool results above against your todo list (Goal: ${resolver.toolPlan.goal}).\nIf they are sufficient, answer the user now in your normal voice using the strongest grounded signal.\nAny factual answer you give from the tool results must appear explicitly in the evidence above. Do not infer or guess missing facts.\nIf they are not sufficient, call DelegateResearch only with the missing outcomes. Do not call search/fetch or any other tools directly in this step. The worker loop will execute the next round.`
            : `Look at the tool results above against your todo list (Goal: ${resolver.toolPlan.goal}).\nIf the approach failed or you need a different strategy, call DelegateResearch with a new worker brief for the missing outcomes.\nOtherwise, answer the user now.\nAny factual answer you give from the tool results must appear explicitly in the evidence above. Do not infer or guess missing facts.\nStart with the answer itself in your normal voice.\nUse one short paragraph unless the user asked for more structure or the evidence truly requires it.\nIf grounded in search, place :cd_source[searchResultId] immediately after the supported sentence and continue.\nDo not restate instructions, citation rules, tool rules, or process notes.`;
        synthesisHistory = isClaudeModel(synthesisModel)
            ? insertTaggedSystemTurn(synthesisHistory, reviewInstruction, { requestId: rid })
            : insertSystemMessage(synthesisHistory, reviewInstruction, rid);
    }
    return synthesisHistory;
}

async function callSynthesis(args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError, synthesisHistory = null) {
    consumeInjectedAgentMessages(args, resolver);
    await say(getRequestId(resolver), `\n`, 1000, false, false);
    markSupervisorEntry(resolver, 'agentic_synthesis');
    await markRuntimeStage(resolver, 'synthesize', 'Synthesizing response from gathered evidence', {
        model: args.synthesisModel || args.primaryModel,
    });
    const runtimeSupervisorMode = isEntityRuntimeEnabled(args);
    const synthesisTools = runtimeSupervisorMode
        ? buildRuntimeLoopTools()
        : [...entityToolsOpenAiFormat, SET_GOALS_OPENAI_DEF];
    const effectiveChatHistory = Array.isArray(synthesisHistory) ? synthesisHistory : args.chatHistory;

    try {
        let synthesisResult = await callModelLogged(resolver, withVisibleModel({
            ...args, chatHistory: effectiveChatHistory, stream: args.stream, tools: synthesisTools,
            tool_choice: "auto", reasoningEffort: args.synthesisReasoningEffort || args.configuredReasoningEffort || 'medium', skipMemoryLoad: true,
        }, args.synthesisModel || args.primaryModel), 'synthesis', { model: args.synthesisModel || args.primaryModel, replanCount: resolver.replanCount || 0, callbackDepth });

        if (!synthesisResult) return { result: await handlePromptError(null), done: true };

        const holder = { value: synthesisResult };
        const hadStreamingCallback = await drainStreamingCallbacks(resolver)(holder);
        synthesisResult = holder.value;

        const synthToolCalls = extractToolCalls(synthesisResult);
        // Update model.result log with streaming info
        if (hadStreamingCallback) {
            logEvent(getRequestId(resolver), 'model.result', {
                model: args.synthesisModel || args.primaryModel, purpose: 'synthesis', streamingCallback: true, hasPlan: !!resolver.toolPlan, callbackDepth,
            });
        }

        if (synthToolCalls.length === 0 || hadStreamingCallback) {
            markAnswerProduced(resolver, 'agentic_synthesis');
            return { result: synthesisResult, done: true };
        }

        if (runtimeSupervisorMode) {
            const delegationCalls = synthToolCalls.filter((toolCall) => {
                const name = toolCall?.function?.name?.toLowerCase() || '';
                return name === DELEGATE_RESEARCH_TOOL_NAME || name === DELEGATE_TASK_TOOL_NAME;
            });
            const proposedPlan = delegationCalls.length > 0 ? extractPlanFromToolCall(delegationCalls[0]) : null;
            const samePlan = proposedPlan
                && buildPlanSignature(proposedPlan) === getDelegatedResearchSignature(resolver, args);
            const stopReason = resolver.entityRuntimeState?.stopReason || null;
            const researchExhausted = !!(stopReason && TERMINAL_REPLAN_STOP_REASONS.has(stopReason));
            const noExecutableWorkInCycle = (resolver._cycleExecutedToolCount || 0) === 0;
            const stalledAfterReplan = noExecutableWorkInCycle && (resolver.replanCount || 0) > 0;
            const replanCapReached = (resolver.replanCount || 0) >= MAX_REPLAN_SAFETY_CAP;
            const proposedPlanHasNovelTasks = proposedPlan && hasNovelPlanTasks(proposedPlan, resolver);

            if (delegationCalls.length > 0) {
                if (!proposedPlan || ((samePlan || !proposedPlanHasNovelTasks) && !proposedPlanHasNovelTasks) || researchExhausted || stalledAfterReplan || replanCapReached) {
                    const guardReason = !proposedPlan
                        ? 'invalid_delegate'
                        : ((!proposedPlanHasNovelTasks && samePlan)
                            ? 'same_plan'
                            : (!proposedPlanHasNovelTasks
                                ? 'no_novel_tasks'
                            : (researchExhausted
                                ? stopReason
                                : (replanCapReached ? 'replan_cap' : 'no_executable_work'))));
                    logEvent(getRequestId(resolver), 'plan.replan_blocked', {
                        reason: guardReason,
                        stopReason,
                        callbackDepth,
                        currentCycleExecutedToolCount: resolver._cycleExecutedToolCount || 0,
                        proposedPlan,
                        tools: summarizeReturnedCalls(synthToolCalls),
                    });
                    return await finalizeSynthesisFromEvidence(
                        args,
                        resolver,
                        handlePromptError,
                        effectiveChatHistory,
                        guardReason,
                        callbackDepth,
                        synthesisResult,
                    );
                }

                resolver.replanCount = (resolver.replanCount || 0) + 1;
                applyToolPlan(proposedPlan, resolver, { source: 'supervisor_delegate' });
                logEvent(getRequestId(resolver), 'plan.replan', {
                    replanCount: resolver.replanCount,
                    source: 'supervisor_delegate',
                    tools: summarizeReturnedCalls(synthToolCalls),
                });
                return { result: null, done: false, toolCalls: [], needsWorkerRound: true };
            }

            return await finalizeSynthesisFromEvidence(
                args,
                resolver,
                handlePromptError,
                effectiveChatHistory,
                'no_action',
                callbackDepth,
                synthesisResult,
            );
        }

        // Non-streaming tool_calls from synthesis
        const isReplan = passesGate(synthToolCalls);
        const onlySetGoalsReplan = isEntityRuntimeEnabled(args) && hasOnlySetGoalsToolCalls(synthToolCalls);
        if (isReplan && onlySetGoalsReplan) {
            const proposedPlan = extractSetGoalsPlan(synthToolCalls[0]);
            const samePlan = proposedPlan
                && buildPlanSignature(proposedPlan) === buildPlanSignature(resolver.toolPlan);
            const stopReason = resolver.entityRuntimeState?.stopReason || null;
            const researchExhausted = !!(stopReason && TERMINAL_REPLAN_STOP_REASONS.has(stopReason));
            const noExecutableWorkInCycle = (resolver._cycleExecutedToolCount || 0) === 0;

            if (samePlan || researchExhausted || noExecutableWorkInCycle) {
                const guardReason = samePlan
                    ? 'same_plan'
                    : (researchExhausted ? stopReason : 'no_executable_work');
                logEvent(getRequestId(resolver), 'plan.replan_blocked', {
                    reason: guardReason,
                    stopReason,
                    callbackDepth,
                    currentCycleExecutedToolCount: resolver._cycleExecutedToolCount || 0,
                    proposedPlan,
                });
                return await finalizeSynthesisFromEvidence(
                    args,
                    resolver,
                    handlePromptError,
                    effectiveChatHistory,
                    guardReason,
                    callbackDepth,
                    synthesisResult,
                );
            }
        }

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

    const runtimeEnabled = isEntityRuntimeEnabled(args);
    const isPulse = args.invocationType === 'pulse';
    if (!runtimeEnabled && callbackDepth <= 1 && !isPulse) {
        const gateResult = await enforceGate(currentToolCalls, args, resolver, entityToolsOpenAiFormat, callbackDepth, handlePromptError);
        if (gateResult.error) return gateResult.error;
        currentToolCalls = gateResult.toolCalls;
    }

    if (!runtimeEnabled) {
        // Preserve the legacy bounded cheap-model loop for non-runtime callers.
        let synthesisResult;
        while (true) {
            resolver._cycleExecutedToolCount = 0;
            if (currentToolCalls.length > 0) {
                const { budgetExhausted } = await processToolCallRound(currentToolCalls, args, resolver, entityTools);
                if (budgetExhausted) currentToolCalls = [];
            }

            for (const msg of args.chatHistory) {
                if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('SetGoals')) {
                    msg.content = msg.content.replace(/IMPORTANT:.*?2-5 items\.\n\n/s, '');
                    break;
                }
            }
            args.chatHistory = stripSetGoalsFromHistory(args.chatHistory);

            const loopErr = await executorLoop(args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError);
            if (loopErr) return loopErr;

            const synthesisHistory = await prepareForSynthesis(args, resolver);

            const startIdx = resolver._preToolHistoryLength || 0;
            const toolHistory = dehydrateToolHistory(args.chatHistory, entityTools, startIdx);
            if (toolHistory.length > 0) {
                resolver.pathwayResultData = { ...(resolver.pathwayResultData || {}), toolHistory };
            }

            const synthResult = await callSynthesis(args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError, synthesisHistory);
            if (synthResult.done) { synthesisResult = synthResult.result; break; }
            currentToolCalls = synthResult.toolCalls;
        }

        return synthesisResult;
    }

    let synthesisResult;
    let needsWorkerRound = false;
    const currentStage = getRuntimeStage(resolver);
    const runtimeStreamingContinuation = currentStage === 'synthesize' && currentToolCalls.length > 0;

    if (runtimeStreamingContinuation) {
        const delegationCalls = currentToolCalls.filter((toolCall) => (
            [DELEGATE_RESEARCH_TOOL_NAME, DELEGATE_TASK_TOOL_NAME].includes(String(toolCall?.function?.name || '').trim().toLowerCase())
        ));
        if (delegationCalls.length > 0) {
            const proposedPlan = extractPlanFromToolCall(delegationCalls[0]);
            const samePlan = proposedPlan
                && buildPlanSignature(proposedPlan) === getDelegatedResearchSignature(resolver, args);
            const stopReason = resolver.entityRuntimeState?.stopReason || null;
            const researchExhausted = !!(stopReason && TERMINAL_REPLAN_STOP_REASONS.has(stopReason));
            const replanCapReached = (resolver.replanCount || 0) >= MAX_REPLAN_SAFETY_CAP;
            const proposedPlanHasNovelTasks = proposedPlan && !samePlan && hasNovelPlanTasks(proposedPlan, resolver);

            if (proposedPlan && !samePlan && proposedPlanHasNovelTasks && !researchExhausted && !replanCapReached) {
                resolver.replanCount = (resolver.replanCount || 0) + 1;
                applyToolPlan(proposedPlan, resolver, { source: 'streaming_supervisor_delegate' });
                logEvent(getRequestId(resolver), 'plan.replan', {
                    replanCount: resolver.replanCount,
                    source: 'streaming_supervisor_delegate',
                    tools: summarizeReturnedCalls(currentToolCalls),
                });
                needsWorkerRound = true;
            } else if (!proposedPlan || samePlan || !proposedPlanHasNovelTasks || researchExhausted || replanCapReached) {
                const blockedReason = !proposedPlan ? 'invalid_delegate' : (samePlan ? 'same_plan' : (!proposedPlanHasNovelTasks ? 'no_novel_tasks' : (researchExhausted ? stopReason : 'replan_cap')));
                logEvent(getRequestId(resolver), 'plan.replan_blocked', {
                    reason: blockedReason,
                    stopReason,
                    callbackDepth,
                    tools: summarizeReturnedCalls(currentToolCalls),
                    source: 'streaming_supervisor_delegate',
                });
                const synthesisHistory = await prepareForSynthesis(args, resolver);
                const finalized = await finalizeSynthesisFromEvidence(
                    args,
                    resolver,
                    handlePromptError,
                    synthesisHistory,
                    blockedReason,
                    callbackDepth,
                    null,
                );
                return finalized.result;
            }
        }
        currentToolCalls = [];
    }

    while (true) {
        resolver._cycleExecutedToolCount = 0;
        if (currentToolCalls.length > 0) {
            const roundResult = await processToolCallRound(currentToolCalls, args, resolver, entityTools);
            needsWorkerRound = needsWorkerRound || !!roundResult.delegatedResearch;
            const { budgetExhausted } = roundResult;
            if (budgetExhausted) currentToolCalls = [];
        }

        if (needsWorkerRound && !resolver.entityRuntimeState?.stopReason && getDelegatedResearchTasks(resolver).length > 0) {
            const workerResult = await runDelegatedWorkerRound(
                args,
                resolver,
                entityTools,
                entityToolsOpenAiFormat,
                handlePromptError,
            );
            needsWorkerRound = false;
            if (workerResult?.done) return workerResult.response;
            if (workerResult?.budgetExhausted || workerResult?.endPulseCalled) {
                currentToolCalls = [];
            }
        }

        args.chatHistory = stripSetGoalsFromHistory(args.chatHistory);

        const synthesisHistory = await prepareForSynthesis(args, resolver);

        // Dehydrate tool history onto pathwayResultData before synthesis streams the final info block
        const startIdx = resolver._preToolHistoryLength || 0;
        const toolHistory = dehydrateToolHistory(args.chatHistory, entityTools, startIdx);
        if (toolHistory.length > 0) {
            resolver.pathwayResultData = { ...(resolver.pathwayResultData || {}), toolHistory };
        }

        const synthResult = await callSynthesis(args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError, synthesisHistory);
        if (synthResult.done) { synthesisResult = synthResult.result; break; }
        currentToolCalls = synthResult.toolCalls;
        needsWorkerRound = synthResult.needsWorkerRound !== false;
    }

    return synthesisResult;
}

// ─── Execute Pathway ─────────────────────────────────────────────────────────

export async function prepareEntityLatencyCore({ args, resolver }) {
    const { entityId, voiceResponse, chatId } = { ...resolver.pathway.inputParameters, ...args };
    const invocationType = args.invocationType === 'anticipate' ? 'chat' : (args.invocationType || '');
    const isPulse = invocationType === 'pulse';

    if (isPulse && (!args.agentContext || !args.agentContext.length || !args.agentContext.some(ctx => ctx?.contextId))) {
        args.agentContext = [{ contextId: entityId, contextKey: null, default: true }];
    }

    const entityConfig = await loadEntityConfig(entityId);
    const { entityToolsOpenAiFormat } = getToolsForEntity(entityConfig, { invocationType });
    const {
        entityName,
        entityInstructions,
        useContinuityMemory,
        toolLoopModel,
        modelPolicy,
        authorityEnvelope,
    } = loadEntityContext(entityConfig, { ...args, invocationType }, resolver);

    args.aiName = entityName || args.aiName || 'Entity';

    if (!args.chatHistory || args.chatHistory.length === 0) args.chatHistory = [];

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
            image_url: { url: resource?.url }, originalFilename: resource?.name,
        })));
    }

    const userInfo = args.userInfo || '';
    const contextId = args.agentContext?.find(ctx => ctx?.default)?.contextId
        || args.agentContext?.[0]?.contextId
        || chatId || entityId;
    args = {
        ...args,
        ...config.get('entityConstants'),
        invocationType,
        runtimeOrigin: 'chat',
        runtimeMode: args.runtimeMode || ENTITY_RUNTIME_MODE,
        entityId,
        contextId,
        entityInstructions,
        voiceResponse,
        chatId,
        userInfo,
        entityToolsOpenAiFormat,
        styleNeutralizationProfile: args.styleNeutralizationProfile || entityConfig?.styleNeutralizationProfile || null,
        styleNeutralizationPatch: args.styleNeutralizationPatch || '',
        styleNeutralizationText: args.styleNeutralizationText || '',
    };
    resolver.args = { ...args };

    const currentConversationMode = normalizeConversationMode(args.runtimeConversationMode || 'chat');
    const currentConversationModeConfidence = normalizeModeConfidence(args.runtimeConversationModeConfidence || 'low');
    const currentModeAffiliationPolicy = await getConversationModeAffiliationPolicy(currentConversationMode);
    const currentModeModelPolicy = applyConversationModeAffiliation(
        modelPolicy,
        currentConversationMode,
        currentModeAffiliationPolicy,
    );
    const reasoningEffort = entityConfig?.reasoningEffort || 'low';
    args.configuredReasoningEffort = reasoningEffort;
    args.modelPolicyResolved = currentModeModelPolicy;
    args.authorityEnvelopeResolved = authorityEnvelope;
    args.runtimeConversationMode = currentConversationMode;
    args.runtimeConversationModeConfidence = currentConversationModeConfidence;
    args.primaryModel = currentModeModelPolicy.primaryModel;
    args.planningModel = currentModeModelPolicy.planningModel;
    args.synthesisModel = currentModeModelPolicy.synthesisModel;
    args.verificationModel = currentModeModelPolicy.verificationModel;
    resolver.args = { ...args };

    let runtimeRoute = routeEntityTurn({
        text: extractUserMessage(args),
        chatHistory: args.chatHistory || [],
        availableToolNames: entityToolsOpenAiFormat.map(tool => tool.function?.name || ''),
        invocationType,
        conversationMode: currentConversationMode,
        conversationModeConfidence: currentConversationModeConfidence,
    });
    const userText = extractUserMessage(args);
    const availableToolNames = entityToolsOpenAiFormat.map(tool => tool.function?.name || '');
    runtimeRoute = await maybeRefineRouteWithModel({
        initialRoute: runtimeRoute,
        text: userText,
        chatHistory: args.chatHistory || [],
        availableToolNames,
        args,
        resolver,
        modelPolicy,
        currentMode: currentConversationMode,
    });

    const effectiveConversationMode = normalizeConversationMode(args.runtimeConversationMode || currentConversationMode);
    const effectiveModeAffiliationPolicy = await getConversationModeAffiliationPolicy(effectiveConversationMode);
    const effectiveModelPolicy = applyConversationModeAffiliation(
        modelPolicy,
        effectiveConversationMode,
        effectiveModeAffiliationPolicy,
    );
    const planningToolNames = runtimeRoute.initialToolNames || [];
    const promptPlanningToolNames = runtimeRoute.mode === 'plan' ? planningToolNames : [];
    const planningToolsOpenAiFormat = promptPlanningToolNames.length > 0
        ? entityToolsOpenAiFormat.filter(tool => promptPlanningToolNames.includes(tool.function?.name))
        : (runtimeRoute.mode === 'plan' ? entityToolsOpenAiFormat : []);
    const promptContext = {
        includeAvailableFiles: shouldIncludeAvailableFilesInPrompt({
            route: runtimeRoute,
            planningToolNames,
        }),
        includeDateTime: shouldIncludeDateTimeInPrompt({
            route: runtimeRoute,
            planningToolNames,
        }),
    };
    args.latencyRouteMode = runtimeRoute.mode;
    args.latencyRouteReason = runtimeRoute.reason;
    args.runtimeRouteMode = runtimeRoute.mode;
    args.runtimeRouteReason = runtimeRoute.reason;
    args.runtimeRouteSource = runtimeRoute.routeSource || '';
    args.runtimeDirectTool = runtimeRoute.toolName || '';
    args.initialPlanningToolNames = planningToolsOpenAiFormat.map(tool => tool.function?.name || '').filter(Boolean);
    args.promptContext = promptContext;
    resolver.args = { ...args };

    const continuityPreload = await preloadRuntimeContinuity(resolver, {
        ...args,
        entityId,
        text: userText,
        chatHistory: args.chatHistory || [],
        contextId,
        useMemory: useContinuityMemory,
    });
    const routeRuntimeStage = runtimeRoute.mode === 'direct_reply'
        ? 'direct_reply'
        : (runtimeRoute.mode === 'direct_search' ? 'direct_search' : (args.runtimeStage || 'plan'));
    args.runtimeStage = routeRuntimeStage;

    const runtimeContext = {
        enabled: true,
        goal: args.runGoal || args.text || '',
        origin: 'chat',
        stage: routeRuntimeStage,
        requestedOutput: args.requestedOutput || '',
        envelopeSummary: summarizeAuthorityEnvelope(authorityEnvelope),
        continuityContext: typeof resolver.continuityContext === 'string'
            ? resolver.continuityContext
            : '',
        orientationSummary: '',
    };
    args.runtimeContext = runtimeContext;
    args.promptTemplateMeta = {
        isSystem: !!entityConfig?.isSystem,
        entityInstructions,
        useContinuityMemory,
        promptContext,
        resolvedContinuityContext: typeof resolver.continuityContext === 'string'
            ? resolver.continuityContext
            : '',
    };

    const promptMessages = buildPromptTemplate(
        entityConfig,
        entityToolsOpenAiFormat,
        entityInstructions,
        useContinuityMemory,
        voiceResponse,
        isPulse,
        runtimeContext,
        promptContext,
    );
    resolver.pathwayPrompt = [new Prompt({ messages: promptMessages })];

    args.primaryReasoningEffort = effectiveModelPolicy.primaryReasoningEffort || reasoningEffort;
    args.orientationReasoningEffort = effectiveModelPolicy.orientationReasoningEffort || args.primaryReasoningEffort;
    args.planningReasoningEffort =
        effectiveModelPolicy.planningReasoningEffort
        || runtimeRoute.planningReasoningEffort
        || args.primaryReasoningEffort
        || 'medium';
    args.researchReasoningEffort =
        effectiveModelPolicy.researchReasoningEffort
        || args.primaryReasoningEffort
        || 'low';
    args.childReasoningEffort =
        effectiveModelPolicy.childReasoningEffort
        || args.researchReasoningEffort;
    args.synthesisReasoningEffort =
        runtimeRoute.synthesisReasoningEffort
        || effectiveModelPolicy.synthesisReasoningEffort
        || args.primaryReasoningEffort
        || 'medium';
    args.verificationReasoningEffort =
        effectiveModelPolicy.verificationReasoningEffort
        || args.synthesisReasoningEffort;
    args.compressionReasoningEffort =
        effectiveModelPolicy.compressionReasoningEffort
        || args.researchReasoningEffort;
    args.routingReasoningEffort =
        effectiveModelPolicy.routingReasoningEffort
        || 'none';
    if (runtimeRoute.mode === 'direct_reply') {
        args.synthesisReasoningEffort = getDirectReplySettings(runtimeRoute).reasoningEffort;
    }
    args.toolLoopModel = toolLoopModel;
    args.childModel = effectiveModelPolicy.childModel || toolLoopModel || effectiveModelPolicy.researchModel || args.primaryModel;
    args.modelPolicyResolved = effectiveModelPolicy;
    args.authorityEnvelopeResolved = authorityEnvelope;
    args.runtimeConversationMode = effectiveConversationMode;
    args.primaryModel = effectiveModelPolicy.primaryModel;
    args.planningModel = effectiveModelPolicy.planningModel;
    args.synthesisModel = effectiveModelPolicy.synthesisModel;
    args.verificationModel = effectiveModelPolicy.verificationModel;
    args.chatHistory = sliceByTurns(args.messages && args.messages.length > 0 ? args.messages : args.chatHistory);
    resolver.args = { ...args };

    const warmedPurposes = [];
    let speculationSkipped = false;
    if (runtimeRoute.mode === 'direct_reply') {
        warmedPurposes.push(await warmDirectReplyFastPath(runtimeRoute, args, resolver));
    } else if (runtimeRoute.mode === 'direct_search') {
        const warmedPurpose = await warmDirectSearchFastPath(runtimeRoute, args, resolver, entityToolsOpenAiFormat);
        if (warmedPurpose) warmedPurposes.push(warmedPurpose);
    } else {
        speculationSkipped = true;
    }

    const preparation = {
        prepared: true,
        routeMode: runtimeRoute.mode,
        routeReason: runtimeRoute.reason,
        routeSource: runtimeRoute.routeSource || 'heuristic',
        continuityPreload,
        warmedPurposes,
        speculationSkipped,
        models: {
            routingModel: modelPolicy.routingModel || null,
            primaryModel: args.primaryModel || null,
            planningModel: args.planningModel || null,
            synthesisModel: args.synthesisModel || null,
        },
    };

    resolver.pathwayResultData = {
        ...(resolver.pathwayResultData || {}),
        latencyPrepare: preparation,
    };

    return preparation;
}

function loadEntityContext(entityConfig, args, resolver) {
    const entityName = entityConfig?.name;
    const entityInstructions = entityConfig?.identity || entityConfig?.instructions || '';
    const entityAllowsMemory = entityConfig?.useMemory !== false;
    const inputAllowsMemory = args.useMemory !== false;
    const useContinuityMemory = entityAllowsMemory && inputAllowsMemory;
    const modelPolicy = resolveEntityModelPolicy({ entityConfig, args, resolver });
    const authorityEnvelope = resolveAuthorityEnvelope({ entityConfig, args, origin: args.invocationType || args.runtimeOrigin });
    const toolLoopModel = isEntityRuntimeEnabled(args)
        ? modelPolicy.researchModel
        : (config.get('models')?.[TOOL_LOOP_MODEL] ? TOOL_LOOP_MODEL : null);
    return { entityName, entityInstructions, useContinuityMemory, toolLoopModel, modelPolicy, authorityEnvelope };
}

function buildPromptTemplate(entityConfig, entityToolsOpenAiFormat, entityInstructions, useContinuityMemory, voiceResponse, isPulse, runtimeContext = null, promptContext = {}) {
    const entityContext = buildEntityContextBlock({
        entityInstructions,
        useContinuityMemory,
        resolvedContinuityContext: runtimeContext?.continuityContext || '',
        promptContext,
    });

    const commonInstructionsTemplate = entityConfig?.isSystem
        ? `{{renderTemplate AI_COMMON_INSTRUCTIONS_TEXT}}`
        : `{{renderTemplate AI_COMMON_INSTRUCTIONS}}`;
    const instructionTemplates = `${commonInstructionsTemplate}\n{{renderTemplate AI_WORKSPACE}}\n{{renderTemplate AI_EXPERTISE}}`;
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
        ? (promptContext.runtimeInitialDelegateOnly
            ? `IMPORTANT: This first pass is for delegating research only. Do not run search or fetch tools yourself yet. Call DelegateResearch with concrete parallel research tasks that cover the missing findings.\n\n`
            : (promptContext.runtimeAgenticLoop
                ? `IMPORTANT: Use one clean agentic loop. Call tools directly when they advance the main task. If you need parallel information gathering, call DelegateResearch with concrete parallel research tasks. Do not call SetGoals.\n\n`
            : `IMPORTANT: If you call ANY tools, you MUST include SetGoals in the same response. Tool calls without SetGoals will be discarded. SetGoals is your todo list — not sequential steps but everything that needs to happen before you're done. Each item should be a specific outcome to achieve, not a procedure to follow. 2-5 items.\n\n`)
            )
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
    const runtimeInstructions = buildRuntimeInstructionBlock(runtimeContext);
    const stableInstructionBlock = `${instructionTemplates}\n\n${toolsTemplate}${planInstruction}${searchRulesTemplate}${voiceInstructions}${pulseInstructions}{{renderTemplate AI_GROUNDING_INSTRUCTIONS}}`.trim();
    const dynamicInstructionBlock = [
        entityContext.trim(),
        runtimeInstructions.trim(),
        '{{renderTemplate AI_STYLE_NEUTRALIZATION}}',
    ].filter(Boolean).join('\n\n').trim();
    const volatileSections = [];

    if (promptContext.includeAvailableFiles) {
        volatileSections.push('{{renderTemplate AI_AVAILABLE_FILES}}');
    }
    if (promptContext.includeDateTime) {
        volatileSections.push('{{renderTemplate AI_DATETIME}}');
    }

    return [
        {"role": "system", "content": stableInstructionBlock},
        ...(dynamicInstructionBlock ? [{ "role": "system", "content": dynamicInstructionBlock }] : []),
        ...(volatileSections.length > 0 ? [{ "role": "system", "content": volatileSections.join('\n\n') }] : []),
        "{{chatHistory}}",
    ];
}

function extractPlainTextFromMessageContent(content) {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsed = safeParse(trimmed);
            if (parsed && typeof parsed === 'object') {
                if (parsed.success !== undefined && !parsed.text && !parsed.userText && !parsed.content) {
                    return '';
                }
                if (parsed.type === 'text' && typeof parsed.text === 'string') {
                    return parsed.text;
                }
                if (typeof parsed.userText === 'string') {
                    return parsed.userText;
                }
                if (typeof parsed.text === 'string') {
                    return parsed.text;
                }
                if (parsed.content) {
                    return extractPlainTextFromMessageContent(parsed.content);
                }
            }
        }
        return content;
    }
    if (Array.isArray(content)) {
        for (const item of content) {
            const text = extractPlainTextFromMessageContent(item);
            if (text) return text;
        }
        return '';
    }
    if (content && typeof content === 'object') {
        if (content.type === 'text' && typeof content.text === 'string') {
            return content.text;
        }
        if (typeof content.userText === 'string') {
            return content.userText;
        }
        if (typeof content.text === 'string') {
            return content.text;
        }
        if (content.content) {
            return extractPlainTextFromMessageContent(content.content);
        }
    }
    return '';
}

export function extractUserMessage(args) {
    let userMessage = args.text || '';
    if (!userMessage && args.chatHistory?.length > 0) {
        for (let i = args.chatHistory.length - 1; i >= 0; i--) {
            const msg = args.chatHistory[i];
            if (msg?.role === 'user') {
                const textValue = extractPlainTextFromMessageContent(msg.content);
                if (String(textValue || '').trim().startsWith('[system message:')) continue;
                if (textValue) {
                    userMessage = textValue;
                    break;
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

        const assistantResponse = getFinalAssistantText(resolver, response);

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
        const assistantResponse = getFinalAssistantText(resolver, response);

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

async function persistRuntimeMemory({
    resolver,
    args,
    response,
    entityName,
    entityInstructions,
    useContinuityMemory,
    isPulse,
}) {
    if (isPulse && useContinuityMemory && resolver.continuityEntityId) {
        await recordPulseMemory(resolver, args, response, entityName, entityInstructions);
    } else if (useContinuityMemory && resolver.continuityEntityId && resolver.continuityUserId) {
        await recordConversationMemory(resolver, args, response, entityName, entityInstructions);
    }
}

function markFinalResponseProduced(resolver, response, routeMode = '') {
    if (!getFinalAssistantText(resolver, response)) return;
    const executionState = getExecutionState(resolver);
    const fallbackAnswerMode = executionState?.answerMode
        || (routeMode === 'plan' ? 'planning_initial' : routeMode)
        || 'direct_reply';
    markAnswerProduced(resolver, fallbackAnswerMode);
}

async function completeRuntimeResponse({
    args,
    resolver,
    response,
    entityName,
    entityInstructions,
    useContinuityMemory,
    isPulse,
    routeMode = '',
    requestStartTime = 0,
}) {
    let finalResponse = repairManagedMediaUrlsInResponse(
        response,
        resolver,
        args.chatHistory || [],
    );

    const isStreamObject = finalResponse && typeof finalResponse.on === 'function';
    if (!isStreamObject && !extractResponseText(finalResponse).trim()) {
        logEventError(getRequestId(resolver), 'request.error', {
            phase: 'empty_response',
            error: 'All processing completed but no text was produced',
            durationMs: Date.now() - requestStartTime,
        });
        finalResponse = await generateErrorResponse(
            new Error('I processed your request but wasn\'t able to generate a response. Please try again.'),
            args,
            resolver,
        );
    }

    markFinalResponseProduced(resolver, finalResponse, routeMode);
    await persistRuntimeMemory({
        resolver,
        args,
        response: finalResponse,
        entityName,
        entityInstructions,
        useContinuityMemory,
        isPulse,
    });

    syncRuntimeResultData(resolver, args);
    await finalizeRuntimeRun(args, resolver, finalResponse);

    if (args.stream) {
        publishRequestProgress({
            requestId: getRequestId(resolver),
            progress: 1,
            data: JSON.stringify(getFinalAssistantText(resolver, finalResponse)),
            info: JSON.stringify(resolver.pathwayResultData || {}),
            error: resolver.errors?.length > 0 ? resolver.errors.join(', ') : ''
        });
    }

    logRequestEnd(resolver);
    return finalResponse;
}

async function executeDirectRuntimeRoute({
    runtimeRoute,
    args,
    resolver,
    entityTools,
    entityToolsOpenAiFormat,
    entityName,
    entityInstructions,
    useContinuityMemory,
    isPulse,
    requestStartTime,
}) {
    const rid = getRequestId(resolver);
    const handlePromptError = makeErrorHandler(args, resolver);
    const skipped = runtimeRoute.mode === 'direct_search'
        ? ['file_sync', 'context_compression', 'formal_planning']
        : ['file_sync', 'context_compression'];

    logEvent(rid, 'route.preflight_skipped', {
        mode: runtimeRoute.mode,
        reason: runtimeRoute.reason,
        skipped,
    });

    const fastResult = runtimeRoute.mode === 'direct_search'
        ? await runDirectSearchFastPath(
            runtimeRoute,
            args,
            resolver,
            entityTools,
            entityToolsOpenAiFormat,
            handlePromptError,
        )
        : await runDirectReplyFastPath(runtimeRoute, args, resolver, handlePromptError);

    return completeRuntimeResponse({
        args,
        resolver,
        response: fastResult,
        entityName,
        entityInstructions,
        useContinuityMemory,
        isPulse,
        routeMode: runtimeRoute.mode,
        requestStartTime,
    });
}

async function executePlanRuntimeRoute({
    runtimeRoute,
    args,
    resolver,
    runAllPrompts,
    toolCallbackOverride,
    entityId,
    chatId,
    entityTools,
    entityToolsOpenAiFormat,
    planningToolsOpenAiFormat,
    entityName,
    entityInstructions,
    useContinuityMemory,
    isPulse,
    requestStartTime,
}) {
    const rid = getRequestId(resolver);
    const handlePromptError = makeErrorHandler(args, resolver);
    const { chatHistory: strippedHistory, availableFiles } = await syncAndStripFilesFromChatHistory(
        args.chatHistory,
        args.agentContext,
        chatId,
        entityId,
    );
    args.chatHistory = strippedHistory;
    resolver.args = { ...args };

    try {
        args.chatHistory = await compressContextIfNeeded(args.chatHistory, resolver, args);
    } catch (e) {
        logEventError(rid, 'request.error', { phase: 'compression', error: e.message });
    }
    resolver.args = { ...args };

    const runtimeEnabled = isEntityRuntimeEnabled(args) && !!args.toolLoopModel;
    const delegateOnlyInitialPass = shouldForceInitialResearchDelegation(runtimeRoute, args);
    const initialPromptContext = {
        ...(args.promptContext || {}),
        runtimeInitialDelegateOnly: delegateOnlyInitialPass,
        runtimeAgenticLoop: runtimeEnabled,
    };
    refreshRuntimeInitialPrompt(resolver, {
        promptTemplateMeta: args.promptTemplateMeta || {},
        entityToolsOpenAiFormat,
        voiceResponse: args.voiceResponse,
        isPulse,
        runtimeContext: args.runtimeContext || null,
        promptContext: initialPromptContext,
    });
    const firstCallTools = buildInitialPlanningTools({
        planningToolsOpenAiFormat,
        entityToolsOpenAiFormat,
        runtimeEnabled,
        delegateOnly: delegateOnlyInitialPass,
    });

    await markRuntimeStage(resolver, 'plan', 'Running initial planning/model pass', {
        model: args.planningModel || args.primaryModel,
    });

    const initialCallModel = args.planningModel || args.primaryModel;
    const initialChatHistory = delegateOnlyInitialPass
        ? buildDelegateOnlyPlanningHistory(args.chatHistory, resolver, runtimeRoute)
        : cloneMessages(args.chatHistory);
    const initialCallArgs = applyPromptCacheOptions(withVisibleModel({
        ...args,
        promptContext: {
            ...initialPromptContext,
        },
        chatHistory: initialChatHistory,
        availableFiles,
        stream: args.stream,
        reasoningEffort: delegateOnlyInitialPass
            ? 'low'
            : (args.planningReasoningEffort || args.configuredReasoningEffort || 'low'),
        tools: firstCallTools,
        tool_choice: delegateOnlyInitialPass
            ? {
                type: 'function',
                function: {
                    name: 'DelegateResearch',
                },
            }
            : 'auto',
        skipMemoryLoad: shouldSkipRuntimeMemoryLoad(resolver),
    }, initialCallModel), 'initial', initialCallModel);
    resolver._activeToolNames = new Set(
        summarizeToolNames(initialCallArgs.tools)
            .map((name) => String(name || '').trim().toLowerCase())
            .filter(Boolean),
    );

    logEvent(rid, 'model.call', {
        model: initialCallModel,
        purpose: 'initial',
        stream: initialCallArgs.stream,
        reasoningEffort: initialCallArgs.reasoningEffort,
        toolNames: summarizeToolNames(initialCallArgs.tools),
        toolChoice: initialCallArgs.tool_choice || 'auto',
        messageCount: initialCallArgs.chatHistory?.length || 0,
        ...(initialCallArgs.promptCache?.key && { promptCacheKey: initialCallArgs.promptCache.key }),
    });

    let response = await runAllPrompts(initialCallArgs);

    if (!response) {
        const errorDetails = resolver.errors.length > 0 ? `: ${resolver.errors.join(', ')}` : '';
        throw new Error(`Model execution returned null - the model request likely failed${errorDetails}`);
    }

    const holder = { value: response };
    const hadStreamingCallback = await drainStreamingCallbacks(resolver)(holder);
    response = holder.value;

    logEvent(rid, 'model.result', {
        model: args.planningModel || args.primaryModel,
        purpose: 'initial',
        returnedToolCalls: summarizeReturnedCalls(extractToolCalls(response)),
        streamingCallback: hadStreamingCallback,
        contentChars: (response instanceof CortexResponse ? response.output_text?.length : (typeof response === 'string' ? response.length : 0)) || 0,
    });

    const toolCallback = toolCallbackOverride || resolver.pathway.toolCallback || toolCallbackCore;
    resolver._preToolHistoryLength = args.chatHistory.length;
    while (response && (
        (response instanceof CortexResponse && response.hasToolCalls()) ||
        (typeof response === 'object' && response.tool_calls)
    )) {
        try {
            response = await toolCallback(args, response, resolver);
            if (!response) {
                throw new Error('Tool callback returned null - a model request likely failed');
            }
        } catch (toolError) {
            logEventError(rid, 'request.error', {
                phase: 'tool_callback',
                error: toolError.message,
                durationMs: Date.now() - requestStartTime,
            });
            const errorResponse = await generateErrorResponse(toolError, args, resolver);
            resolver.errors = [];
            return completeRuntimeResponse({
                args,
                resolver,
                response: errorResponse,
                entityName,
                entityInstructions,
                useContinuityMemory,
                isPulse,
                routeMode: runtimeRoute.mode,
                requestStartTime,
            });
        }
    }

    if (canRewriteInitialResponse(resolver)) {
        response = await maybeFinalizeInitialResponse({
            response,
            args,
            resolver,
            initialCallModel,
        });
    }

    return completeRuntimeResponse({
        args,
        resolver,
        response,
        entityName,
        entityInstructions,
        useContinuityMemory,
        isPulse,
        routeMode: runtimeRoute.mode,
        requestStartTime,
    });
}

// ─── Default Export ──────────────────────────────────────────────────────────

export async function toolCallbackCore(args, message, resolver) {
    if (!args || !message || !resolver) return;

    const { entityTools, entityToolsOpenAiFormat } = args;
    resolver.toolBudgetUsed = resolver.toolBudgetUsed || 0;
    resolver.toolCallRound = resolver.toolCallRound || 0;
    if (!resolver.toolResultStore) resolver.toolResultStore = new Map();
    if (!resolver.toolCallCache) resolver.toolCallCache = new Map();
    if (!resolver.semanticToolCache) resolver.semanticToolCache = new Map();
    if (typeof resolver._preToolHistoryLength !== 'number') {
        resolver._preToolHistoryLength = Array.isArray(args.chatHistory) ? args.chatHistory.length : 0;
    }

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

    return await runFallbackPath(currentToolCalls, args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError);
}

export async function executeEntityAgentCore({ args, runAllPrompts, resolver, toolCallbackOverride = null }) {
    if (isLatencyPrepareRequest(args)) {
        const preparation = await prepareEntityLatencyCore({ args, resolver });
        return JSON.stringify(preparation);
    }

    const { entityId, voiceResponse, chatId, invocationType } = { ...resolver.pathway.inputParameters, ...args };
    const isPulse = invocationType === 'pulse';

    if (isPulse && (!args.agentContext || !args.agentContext.length || !args.agentContext.some(ctx => ctx?.contextId))) {
        args.agentContext = [{ contextId: entityId, contextKey: null, default: true }];
    }

    const entityConfig = await loadEntityConfig(entityId);
    const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig, { invocationType });
    const {
        entityName,
        entityInstructions,
        useContinuityMemory,
        toolLoopModel,
        modelPolicy,
        authorityEnvelope,
    } = loadEntityContext(entityConfig, args, resolver);

    args.aiName = entityName || args.aiName || 'Entity';

    if (!args.chatHistory || args.chatHistory.length === 0) args.chatHistory = [];

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
    const contextId = args.agentContext?.find(ctx => ctx?.default)?.contextId
        || args.agentContext?.[0]?.contextId
        || chatId || entityId;
    args = {
        ...args, ...config.get('entityConstants'),
        entityId, contextId, entityTools, entityToolsOpenAiFormat, entityInstructions,
        voiceResponse, chatId, userInfo, hasWorkspace: !!entityTools.workspacessh,
        styleNeutralizationProfile: args.styleNeutralizationProfile || entityConfig?.styleNeutralizationProfile || null,
        styleNeutralizationPatch: args.styleNeutralizationPatch || '',
        styleNeutralizationText: args.styleNeutralizationText || '',
    };
    resolver.args = {...args};

    const currentConversationMode = normalizeConversationMode(args.runtimeConversationMode || 'chat');
    const currentConversationModeConfidence = normalizeModeConfidence(args.runtimeConversationModeConfidence || 'low');
    const currentModeAffiliationPolicy = await getConversationModeAffiliationPolicy(currentConversationMode);
    const currentModeModelPolicy = applyConversationModeAffiliation(
        modelPolicy,
        currentConversationMode,
        currentModeAffiliationPolicy,
    );
    const reasoningEffort = entityConfig?.reasoningEffort || 'low';
    args.configuredReasoningEffort = reasoningEffort;
    args.modelPolicyResolved = currentModeModelPolicy;
    args.authorityEnvelopeResolved = authorityEnvelope;
    args.runtimeConversationMode = currentConversationMode;
    args.runtimeConversationModeConfidence = currentConversationModeConfidence;
    args.primaryModel = currentModeModelPolicy.primaryModel;
    args.planningModel = currentModeModelPolicy.planningModel;
    args.synthesisModel = currentModeModelPolicy.synthesisModel;
    args.verificationModel = currentModeModelPolicy.verificationModel;
    resolver.args = {...args};

    const rid = getRequestId(resolver);
    const requestStartTime = Date.now();
    resolver.requestStartTime = requestStartTime;

    if (isEntityRuntimeEnabled(args) && args.runtimeRunId) {
        resolver.entityRuntimeState = {
            runId: args.runtimeRunId,
            authorityEnvelope,
            modelPolicy: currentModeModelPolicy,
            store: getEntityRuntimeStore(),
            conversationMode: currentConversationMode,
            conversationModeConfidence: currentConversationModeConfidence,
            modeUpdatedAt: new Date().toISOString(),
            searchCalls: 0,
            fetchCalls: 0,
            childRuns: 0,
            evidenceItems: 0,
            semanticToolCounts: new Map(),
            semanticEvidenceKeys: new Set(),
            noveltyHistory: [],
            stopReason: null,
            currentStage: args.runtimeStage || 'plan',
            _finalized: false,
        };
    }

    let runtimeRoute = routeEntityTurn({
        text: extractUserMessage(args),
        chatHistory: args.chatHistory || [],
        availableToolNames: entityToolsOpenAiFormat.map(tool => tool.function?.name || ''),
        invocationType,
        conversationMode: currentConversationMode,
        conversationModeConfidence: currentConversationModeConfidence,
    });
    const userText = extractUserMessage(args);
    const availableToolNames = entityToolsOpenAiFormat.map(tool => tool.function?.name || '');
    runtimeRoute = await maybeRefineRouteWithModel({
        initialRoute: runtimeRoute,
        text: userText,
        chatHistory: args.chatHistory || [],
        availableToolNames,
        args,
        resolver,
        modelPolicy,
        currentMode: currentConversationMode,
    });
    initializeExecutionState(resolver, runtimeRoute.mode);
    const effectiveConversationMode = normalizeConversationMode(args.runtimeConversationMode || currentConversationMode);
    const effectiveModeAffiliationPolicy = await getConversationModeAffiliationPolicy(effectiveConversationMode);
    const effectiveModelPolicy = applyConversationModeAffiliation(
        modelPolicy,
        effectiveConversationMode,
        effectiveModeAffiliationPolicy,
    );
    const planningToolNames = runtimeRoute.initialToolNames || [];
    const promptPlanningToolNames = runtimeRoute.mode === 'plan' ? planningToolNames : [];
    const planningToolsOpenAiFormat = promptPlanningToolNames.length > 0
        ? entityToolsOpenAiFormat.filter(tool => promptPlanningToolNames.includes(tool.function?.name))
        : (runtimeRoute.mode === 'plan' ? entityToolsOpenAiFormat : []);
    const promptContext = {
        includeAvailableFiles: shouldIncludeAvailableFilesInPrompt({
            route: runtimeRoute,
            planningToolNames,
        }),
        includeDateTime: shouldIncludeDateTimeInPrompt({
            route: runtimeRoute,
            planningToolNames,
        }),
    };
    args.latencyRouteMode = runtimeRoute.mode;
    args.latencyRouteReason = runtimeRoute.reason;
    args.runtimeRouteMode = runtimeRoute.mode;
    args.runtimeRouteReason = runtimeRoute.reason;
    args.runtimeRouteSource = runtimeRoute.routeSource || '';
    args.runtimeDirectTool = runtimeRoute.toolName || '';
    args.initialPlanningToolNames = planningToolsOpenAiFormat.map(tool => tool.function?.name || '').filter(Boolean);
    args.promptContext = promptContext;
    resolver.args = {...args};

    const continuityPreload = await preloadRuntimeContinuity(resolver, {
        ...args,
        entityId,
        text: userText,
        chatHistory: args.chatHistory || [],
        contextId,
        useMemory: useContinuityMemory,
    });
    const routeRuntimeStage = runtimeRoute.mode === 'direct_reply'
        ? 'direct_reply'
        : (runtimeRoute.mode === 'direct_search' ? 'direct_search' : (args.runtimeStage || 'plan'));
    args.runtimeStage = routeRuntimeStage;
    if (resolver.entityRuntimeState) {
        resolver.entityRuntimeState.currentStage = routeRuntimeStage;
    }

    const runtimeOrientationPacket = safeParseRuntimeValue(args.runtimeOrientationPacket);
    const runtimeContext = isEntityRuntimeEnabled(args)
        ? {
            enabled: true,
            goal: args.runGoal || args.text || '',
            origin: args.runtimeOrigin || invocationType || 'chat',
            stage: routeRuntimeStage,
            requestedOutput: args.requestedOutput || '',
            envelopeSummary: summarizeAuthorityEnvelope(authorityEnvelope),
            continuityContext: typeof resolver.continuityContext === 'string'
                ? resolver.continuityContext
                : '',
            orientationSummary: runtimeOrientationPacket
                ? summarizeOrientationPacket(runtimeOrientationPacket)
                : '',
        }
        : null;
    if (useContinuityMemory && !runtimeContext?.continuityContext?.trim()) {
        logEvent(getRequestId(resolver), 'memory.context_missing', {
            entityId: args.entityId || entityConfig?.id || null,
            routeMode: args.runtimeRouteMode || args.latencyRouteMode || null,
            runtimeStage: routeRuntimeStage,
            preloadAttempted: continuityPreload?.attempted || false,
            preloadLoaded: continuityPreload?.loaded || false,
            preloadError: continuityPreload?.error || null,
        });
    }
    args.runtimeContext = runtimeContext;
    args.promptTemplateMeta = {
        isSystem: !!entityConfig?.isSystem,
        entityInstructions,
        useContinuityMemory,
        promptContext,
        resolvedContinuityContext: typeof resolver.continuityContext === 'string'
            ? resolver.continuityContext
            : '',
    };

    const promptMessages = buildPromptTemplate(
        entityConfig,
        entityToolsOpenAiFormat,
        entityInstructions,
        useContinuityMemory,
        voiceResponse,
        isPulse,
        runtimeContext,
        promptContext
    );
    resolver.pathwayPrompt = [new Prompt({ messages: promptMessages })];

    args.configuredReasoningEffort = reasoningEffort;
    args.primaryReasoningEffort = effectiveModelPolicy.primaryReasoningEffort || reasoningEffort;
    args.orientationReasoningEffort = effectiveModelPolicy.orientationReasoningEffort || args.primaryReasoningEffort;
    args.planningReasoningEffort =
        effectiveModelPolicy.planningReasoningEffort
        || runtimeRoute.planningReasoningEffort
        || args.primaryReasoningEffort
        || 'medium';
    args.researchReasoningEffort =
        effectiveModelPolicy.researchReasoningEffort
        || args.primaryReasoningEffort
        || 'low';
    args.childReasoningEffort =
        effectiveModelPolicy.childReasoningEffort
        || args.researchReasoningEffort;
    args.synthesisReasoningEffort =
        runtimeRoute.synthesisReasoningEffort
        || effectiveModelPolicy.synthesisReasoningEffort
        || args.primaryReasoningEffort
        || 'medium';
    args.verificationReasoningEffort =
        effectiveModelPolicy.verificationReasoningEffort
        || args.synthesisReasoningEffort;
    args.compressionReasoningEffort =
        effectiveModelPolicy.compressionReasoningEffort
        || args.researchReasoningEffort;
    args.routingReasoningEffort =
        effectiveModelPolicy.routingReasoningEffort
        || 'none';
    if (runtimeRoute.mode === 'direct_reply') {
        args.synthesisReasoningEffort = getDirectReplySettings(runtimeRoute).reasoningEffort;
    }
    args.toolLoopModel = toolLoopModel;
    args.childModel = effectiveModelPolicy.childModel || toolLoopModel || effectiveModelPolicy.researchModel || args.primaryModel;
    args.modelPolicyResolved = effectiveModelPolicy;
    args.authorityEnvelopeResolved = authorityEnvelope;
    args.runtimeConversationMode = effectiveConversationMode;
    args.primaryModel = effectiveModelPolicy.primaryModel;
    args.planningModel = effectiveModelPolicy.planningModel;
    args.synthesisModel = effectiveModelPolicy.synthesisModel;
    args.verificationModel = effectiveModelPolicy.verificationModel;
    args.chatHistory = sliceByTurns(args.messages && args.messages.length > 0 ? args.messages : args.chatHistory);
    resolver.args = {...args};

    if (isEntityRuntimeEnabled(args) && args.runtimeRunId) {
        resolver.entityRuntimeState.modelPolicy = effectiveModelPolicy;
        resolver.entityRuntimeState.conversationMode = effectiveConversationMode;
        resolver.entityRuntimeState.conversationModeConfidence = normalizeModeConfidence(args.runtimeConversationModeConfidence || currentConversationModeConfidence);
    }
    updateRuntimeRouteState(resolver, args, runtimeRoute);
    const requestModel = runtimeRoute.mode === 'direct_reply' || runtimeRoute.mode === 'direct_search'
        ? getFastFinalizeModel(args)
        : args.primaryModel;

    logEvent(rid, 'request.start', {
        entity: entityId, model: requestModel, stream: args.stream, invocationType,
        ...(toolLoopModel && { toolLoopModel }), reasoningEffort,
        routingModel: modelPolicy.routingModel,
        conversationMode: effectiveConversationMode,
        planningReasoningEffort: args.planningReasoningEffort,
        synthesisReasoningEffort: args.synthesisReasoningEffort,
        entityToolCount: entityToolsOpenAiFormat.length, entityToolNames: summarizeToolNames(entityToolsOpenAiFormat),
        planningToolCount: planningToolsOpenAiFormat.length,
        planningToolNames: summarizeToolNames(planningToolsOpenAiFormat),
        ...(isEntityRuntimeEnabled(args) && {
            runtimeRunId: args.runtimeRunId,
            runtimeStage: args.runtimeStage || 'plan',
            modelPolicy: effectiveModelPolicy,
            authorityEnvelope,
        }),
    });

    try {
        consumeInjectedAgentMessages(args, resolver);
        logEvent(rid, 'route.selected', {
            mode: runtimeRoute.mode,
            reason: runtimeRoute.reason,
            routeSource: runtimeRoute.routeSource || 'heuristic',
            conversationMode: effectiveConversationMode,
            planningToolNames: summarizeToolNames(planningToolsOpenAiFormat),
            planningReasoningEffort: args.planningReasoningEffort,
            synthesisReasoningEffort: args.synthesisReasoningEffort,
        });
        publishRuntimeModeStatus({ resolver, args });

        if (runtimeRoute.mode === 'direct_search' || runtimeRoute.mode === 'direct_reply') {
            return await executeDirectRuntimeRoute({
                runtimeRoute,
                args,
                resolver,
                entityTools,
                entityToolsOpenAiFormat,
                entityName,
                entityInstructions,
                useContinuityMemory,
                isPulse,
                requestStartTime,
            });
        }

        return await executePlanRuntimeRoute({
            runtimeRoute,
            args,
            resolver,
            runAllPrompts,
            toolCallbackOverride,
            entityId,
            chatId,
            entityTools,
            entityToolsOpenAiFormat,
            planningToolsOpenAiFormat,
            entityName,
            entityInstructions,
            useContinuityMemory,
            isPulse,
            requestStartTime,
        });
    } catch (e) {
        if (e.message === 'Request canceled') {
            registerRuntimeStop(resolver, 'canceled');
            logEvent(rid, 'request.cancel', { durationMs: Date.now() - requestStartTime, budgetUsed: resolver.toolBudgetUsed || 0, toolRounds: resolver.toolCallRound || 0 });
            resolver.errors = [];
            await finalizeRuntimeRun(args, resolver, '');
            if (args.stream) {
                publishRequestProgress({
                    requestId: rid, progress: 1, data: '', info: JSON.stringify(resolver.pathwayResultData || {}), error: ''
                });
            }
            logRequestEnd(resolver);
            return '';
        }

        const usage = summarizeUsage(resolver.pathwayResultData?.usage);
        logEventError(rid, 'request.error', { phase: 'executePathway', error: e.message, durationMs: Date.now() - requestStartTime, ...(usage && { tokens: usage }) });
        const errorResponse = await generateErrorResponse(e, args, resolver);
        resolver.errors = [];
        registerRuntimeStop(resolver, resolver.entityRuntimeState?.stopReason || 'error');
        await finalizeRuntimeRun(args, resolver, errorResponse);

        if (args.stream) {
            publishRequestProgress({
                requestId: rid,
                progress: 1,
                data: JSON.stringify(errorResponse),
                info: JSON.stringify(resolver.pathwayResultData || {}),
                error: e.message || ''
            });
        }

        logRequestEnd(resolver);

        return errorResponse;
    }
}

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
        aiName: "",
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
        runtimeMode: '',
        runtimeRunId: '',
        runtimeStage: '',
        runtimeOrigin: '',
        runGoal: '',
        requestedOutput: '',
        modelPolicy: undefined,
        authorityEnvelope: undefined,
        runtimeOrientationPacket: undefined,
        styleNeutralizationProfile: undefined,
        styleNeutralizationPatch: '',
        styleNeutralizationText: '',
    },
    timeout: 600,

    toolCallback: toolCallbackCore,
    executePathway: executeEntityAgentCore,
};
