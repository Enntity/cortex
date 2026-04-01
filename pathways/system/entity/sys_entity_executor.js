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
const FAST_TOOL_MAX_TURNS = 2;
const FAST_TOOL_MAX_MESSAGES = 8;
const FAST_CHAT_REASONING_EFFORT = 'high';
const SYNTHESIS_REVIEW_MARKER = '[runtime review]';
const TERMINAL_REPLAN_STOP_REASONS = new Set([
    'low_novelty',
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
        description: "Request another bounded worker research pass when the current evidence is not enough to answer yet.",
        parameters: {
            type: "object",
            properties: {
                goal: { type: "string", description: "What the worker pass must resolve before the supervisor can answer" },
                tasks: { type: "array", items: { type: "string" }, description: "2-5 concrete missing findings or checks for the worker pass" },
            },
            required: ["goal", "tasks"]
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

export function buildPurposePromptOverride(callArgs = {}, purpose = '') {
    const promptMeta = callArgs.promptTemplateMeta || {};
    if (!promptMeta || typeof promptMeta !== 'object') return null;
    const delegateToolName = hasToolName(callArgs.tools, 'DelegateResearch')
        ? 'DelegateResearch'
        : (hasToolName(callArgs.tools, 'SetGoals') ? 'SetGoals' : '');

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

function extractPlanFromToolCall(toolCall) {
    return extractSetGoalsPlan(toolCall) || extractDelegateResearchPlan(toolCall);
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
    resolver.toolPlan = plan;
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
    return holder.value || response;
}

async function runDirectSearchFastPath(route, args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    const rid = getRequestId(resolver);
    const fastPathModel = getFastPathModel(args);
    const finalizeModel = getFastFinalizeModel(args);
    const searchTools = (entityToolsOpenAiFormat || []).filter((tool) => (
        (route.initialToolNames || []).includes(tool.function?.name)
    ));

    await markRuntimeStage(resolver, 'research_batch', 'Executing direct search fast path', {
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
            skipMemoryLoad: hasInlineContinuityContext(args, resolver),
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
            return await maybeFinalizeInitialResponse({
                response: searchStep,
                args,
                resolver,
                initialCallModel: fastPathModel,
            });
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
            skipMemoryLoad: hasInlineContinuityContext(args, resolver),
            latencyRouteMode: route.reason,
        }, finalizeModel), 'fast_finalize', {
            model: finalizeModel,
            route: route.reason,
        });

        if (!finalized) return await handlePromptError(null);

        const holder = { value: finalized };
        await drainStreamingCallbacks(resolver)(holder);
        return holder.value;
    } catch (error) {
        return await handlePromptError(error);
    }
}

async function runDirectReplyFastPath(route, args, resolver, handlePromptError) {
    const rid = getRequestId(resolver);
    const fastPathModel = getFastFinalizeModel(args);

    await markRuntimeStage(resolver, 'synthesize', 'Executing conversational fast path', {
        model: fastPathModel,
        route: route.reason,
    });

    const forcedHistory = [
        ...trimFastPathHistory(args.chatHistory || [], FAST_CHAT_MAX_TURNS),
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
            reasoningEffort: FAST_CHAT_REASONING_EFFORT,
            skipMemoryLoad: hasInlineContinuityContext(args, resolver),
            latencyRouteMode: route.reason,
        }, fastPathModel), 'fast_chat', {
            model: fastPathModel,
            route: route.reason,
        });

        if (!finalized) return await handlePromptError(null);

        const holder = { value: finalized };
        await drainStreamingCallbacks(resolver)(holder);
        return holder.value;
    } catch (error) {
        return await handlePromptError(error);
    }
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
        evidenceItems: state.evidenceItems || 0,
    };
}

function syncRuntimeResultData(resolver, args = {}) {
    const state = resolver.entityRuntimeState;
    if (!state) return null;

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
} = {}) {
    if (useContinuityMemory) {
        return String(resolvedContinuityContext || '').trim();
    }
    return buildStaticEntityDefaultsBlock(entityInstructions);
}

function hasInlineContinuityContext(_args = {}, resolver = null) {
    if (typeof resolver?.continuityContext === 'string' && resolver.continuityContext.trim()) return true;
    return false;
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
    if (!stage) return true;
    // During supervisor/finalize review, worker tools are not executed directly.
    // All other stages allow any tool — the executor loop's filtered tool list
    // (filterToolsForExecutor) is what keeps creative tools away from the cheap model.
    if (stage === 'synthesize') {
        const normalizedToolName = toolName.toLowerCase();
        return normalizedToolName === SET_GOALS_TOOL_NAME || normalizedToolName === DELEGATE_RESEARCH_TOOL_NAME;
    }
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
    const resultText = (resolver.streamedContent || extractResponseText(response) || '').trim();
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
                summary: content.slice(0, 1200),
                snippet: content.slice(0, 400),
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

    if (lowNovelty) registerRuntimeStop(resolver, 'low_novelty');
    if (evidenceCapReached) registerRuntimeStop(resolver, 'evidence_cap');
    return lowNovelty || evidenceCapReached;
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
    const setGoalsCalls = validToolCalls.filter(tc => tc.function.name.toLowerCase() === SET_GOALS_TOOL_NAME);
    const delegateResearchCalls = validToolCalls.filter(tc => tc.function.name.toLowerCase() === DELEGATE_RESEARCH_TOOL_NAME);
    const proposedToolCalls = validToolCalls.filter(tc => ![SET_GOALS_TOOL_NAME, DELEGATE_RESEARCH_TOOL_NAME].includes(tc.function.name.toLowerCase()));
    const { allowedToolCalls, skippedToolCalls, stopReason } = applyRuntimeToolEnvelope(proposedToolCalls, resolver);
    const realToolCalls = allowedToolCalls;
    const benignSynthesisReplanBlock = (
        stopReason === 'stage_tool_block'
        && getRuntimeStage(resolver) === 'synthesize'
        && (setGoalsCalls.length > 0 || delegateResearchCalls.length > 0)
    );
    resolver._cycleExecutedToolCount = (resolver._cycleExecutedToolCount || 0) + realToolCalls.length;

    const setGoalsResults = interceptSetGoals(setGoalsCalls, preToolCallMessages, resolver);
    const delegateResearchResults = interceptDelegateResearch(delegateResearchCalls, preToolCallMessages, resolver);
    const toolResults = await Promise.all(realToolCalls.map(tc => executeSingleTool(tc, preToolCallMessages, args, resolver, entityTools)));
    const allToolResults = [...setGoalsResults, ...delegateResearchResults, ...toolResults];

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

async function runSingleWorkerRound(args, resolver, entityTools, entityToolsOpenAiFormat, handlePromptError) {
    const researchTools = filterToolsForExecutor(entityToolsOpenAiFormat);
    const rid = getRequestId(resolver);

    consumeInjectedAgentMessages(args, resolver);
    await markRuntimeStage(resolver, 'research_batch', 'Running delegated worker pass', {
        model: args.toolLoopModel,
        round: (resolver.toolCallRound || 0) + 1,
    });
    if (resolver.toolPlan) {
        logEvent(rid, 'plan.step', { round: resolver.toolCallRound || 0, steps: resolver.toolPlan.steps.length });
    }
    args.chatHistory = insertSystemMessage(args.chatHistory, buildStepInstruction(resolver), rid);

    try {
        const result = await callModelLogged(resolver, withVisibleModel({
            ...args,
            stream: false,
            tools: researchTools,
            tool_choice: "auto",
            reasoningEffort: args.researchReasoningEffort || args.configuredReasoningEffort || 'low',
            skipMemoryLoad: true,
        }, args.toolLoopModel), 'tool_loop', {
            model: args.toolLoopModel,
            round: resolver.toolCallRound,
            hasPlan: !!resolver.toolPlan,
        });

        if (!result) return { response: await handlePromptError(null), done: true };

        const calls = extractToolCalls(result);
        if (calls.length === 0) {
            logEvent(rid, 'plan.worker_idle', {
                round: (resolver.toolCallRound || 0) + 1,
                hasPlan: !!resolver.toolPlan,
            });
            return {
                done: false,
                budgetExhausted: false,
                endPulseCalled: false,
                workerYieldedNoTools: true,
            };
        }

        const { budgetExhausted, endPulseCalled } = await processToolCallRound(calls, args, resolver, entityTools);
        return {
            done: false,
            budgetExhausted,
            endPulseCalled,
            workerYieldedNoTools: false,
        };
    } catch (error) {
        return { response: await handlePromptError(error), done: true };
    }
}

async function finalizeSynthesisFromEvidence(args, resolver, handlePromptError, effectiveChatHistory, guardReason, callbackDepth = 0) {
    const finalized = await callModelLogged(resolver, withVisibleModel({
        ...args,
        chatHistory: [
            ...(effectiveChatHistory || []),
            {
                role: 'user',
                content: `[system message: ${getRequestId(resolver)}:finalize] Research is complete for this run. Do not call DelegateResearch or any tools again. Answer the user now with the best response you can from the evidence gathered so far. Any factual answer you give must appear explicitly in the evidence already gathered. Do not infer or guess missing facts. If you could not complete the requested action, say what blocked completion. Start with the answer itself in your normal voice. If grounded in search, place :cd_source[searchResultId] immediately after the supported sentence. Do not restate instructions, citation rules, tool rules, or process notes.`,
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
    return { result: finalizedHolder.value, done: true };
}

function prepareForSynthesis(args, resolver) {
    const rid = getRequestId(resolver);
    let synthesisHistory = Array.isArray(args.chatHistory)
        ? args.chatHistory.map((msg) => ({ ...msg }))
        : [];
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
        synthesisHistory = sanitizeToolHistoryForRestrictedTools(synthesisHistory, ['DelegateResearch']);
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
    await markRuntimeStage(resolver, 'synthesize', 'Synthesizing response from gathered evidence', {
        model: args.synthesisModel || args.primaryModel,
    });
    const runtimeSupervisorMode = isEntityRuntimeEnabled(args);
    const synthesisTools = runtimeSupervisorMode
        ? [DELEGATE_RESEARCH_OPENAI_DEF]
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

        if (synthToolCalls.length === 0 || hadStreamingCallback) return { result: synthesisResult, done: true };

        if (runtimeSupervisorMode) {
            const delegationCalls = synthToolCalls.filter((toolCall) => {
                const name = toolCall?.function?.name?.toLowerCase() || '';
                return name === DELEGATE_RESEARCH_TOOL_NAME || name === SET_GOALS_TOOL_NAME;
            });
            const proposedPlan = delegationCalls.length > 0 ? extractPlanFromToolCall(delegationCalls[0]) : null;
            const stopReason = resolver.entityRuntimeState?.stopReason || null;
            const researchExhausted = !!(stopReason && TERMINAL_REPLAN_STOP_REASONS.has(stopReason));
            const noExecutableWorkInCycle = (resolver._cycleExecutedToolCount || 0) === 0;
            const stalledAfterReplan = noExecutableWorkInCycle && (resolver.replanCount || 0) > 0;
            const replanCapReached = (resolver.replanCount || 0) >= MAX_REPLAN_SAFETY_CAP;

            if (delegationCalls.length > 0) {
                const samePlan = proposedPlan
                    && buildPlanSignature(proposedPlan) === buildPlanSignature(resolver.toolPlan);
                if (!proposedPlan || samePlan || researchExhausted || stalledAfterReplan || replanCapReached) {
                    const guardReason = !proposedPlan
                        ? 'invalid_delegate'
                        : (samePlan
                            ? 'same_plan'
                            : (researchExhausted
                                ? stopReason
                                : (replanCapReached ? 'replan_cap' : 'no_executable_work')));
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

            const implicitPlan = buildToolPlanFromToolCalls(synthToolCalls, args);
            const samePlan = implicitPlan
                && buildPlanSignature(implicitPlan) === buildPlanSignature(resolver.toolPlan);
            if (!implicitPlan || samePlan || researchExhausted || stalledAfterReplan || replanCapReached) {
                const guardReason = !implicitPlan
                    ? 'invalid_supervisor_tool_call'
                    : (samePlan
                        ? 'same_plan'
                        : (researchExhausted
                            ? stopReason
                            : (replanCapReached ? 'replan_cap' : 'no_executable_work')));
                logEvent(getRequestId(resolver), 'plan.replan_blocked', {
                    reason: guardReason,
                    stopReason,
                    callbackDepth,
                    currentCycleExecutedToolCount: resolver._cycleExecutedToolCount || 0,
                    proposedPlan: implicitPlan,
                    tools: summarizeReturnedCalls(synthToolCalls),
                });
                return await finalizeSynthesisFromEvidence(
                    args,
                    resolver,
                    handlePromptError,
                    effectiveChatHistory,
                    guardReason,
                    callbackDepth,
                );
            }

            resolver.replanCount = (resolver.replanCount || 0) + 1;
            applyToolPlan(implicitPlan, resolver, { source: 'supervisor_implicit_delegate' });
            logEvent(getRequestId(resolver), 'plan.replan', {
                replanCount: resolver.replanCount,
                source: 'supervisor_implicit_delegate',
                tools: summarizeReturnedCalls(synthToolCalls),
            });
            return { result: null, done: false, toolCalls: [], needsWorkerRound: true };
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

    // No depth cap: the tool budget already prevents runaway loops, and duplicate
    // detection catches repeated calls. If the synthesis model wants to spend rounds
    // calling tools at any nesting level, let it — as long as budget holds.

    // Gate (initial call only — nested callbacks already passed the gate)
    // Skip gate for pulse invocations — pulses are autonomous work, not user-driven.
    // Requiring SetGoals wastes 5-10s per pulse on gate retries.
    const isPulse = args.invocationType === 'pulse';
    if (callbackDepth <= 1 && !isPulse) {
        const gateResult = await enforceGate(currentToolCalls, args, resolver, entityToolsOpenAiFormat, callbackDepth, handlePromptError);
        if (gateResult.error) return gateResult.error;
        currentToolCalls = gateResult.toolCalls;
    }

    if (!isEntityRuntimeEnabled(args)) {
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

            const synthesisHistory = prepareForSynthesis(args, resolver);

            const startIdx = resolver._preToolHistoryLength || 0;
            const toolHistory = dehydrateToolHistory(args.chatHistory, entityTools, startIdx);
            if (toolHistory.length > 0) {
                resolver.pathwayResultData = { ...(resolver.pathwayResultData || {}), toolHistory };
            }

            const synthResult = await callSynthesis(args, resolver, entityTools, entityToolsOpenAiFormat, callbackDepth, handlePromptError, synthesisHistory);
            if (synthResult.done) { synthesisResult = synthResult.result; break; }
            currentToolCalls = synthResult.toolCalls;
        }

        logRequestEnd(resolver);
        return synthesisResult;
    }

    // Runtime loop: process immediate tools → supervisor review → optional single worker round → review again
    let synthesisResult;
    let needsWorkerRound = false;
    const currentStage = getRuntimeStage(resolver);
    const runtimeSupervisorStreamReplan = isEntityRuntimeEnabled(args)
        && currentStage === 'synthesize'
        && currentToolCalls.length > 0
        && currentToolCalls.every((toolCall) => {
            const name = String(toolCall?.function?.name || '').trim().toLowerCase();
            return name === DELEGATE_RESEARCH_TOOL_NAME || name === SET_GOALS_TOOL_NAME;
        });

    if (runtimeSupervisorStreamReplan) {
        const delegationCalls = currentToolCalls.filter((toolCall) => {
            const name = String(toolCall?.function?.name || '').trim().toLowerCase();
            return name === DELEGATE_RESEARCH_TOOL_NAME || name === SET_GOALS_TOOL_NAME;
        });
        const proposedPlan = delegationCalls.length > 0 ? extractPlanFromToolCall(delegationCalls[0]) : null;
        const stopReason = resolver.entityRuntimeState?.stopReason || null;
        const researchExhausted = !!(stopReason && TERMINAL_REPLAN_STOP_REASONS.has(stopReason));
        const noExecutableWorkInCycle = (resolver._cycleExecutedToolCount || 0) === 0;
        const replanCapReached = (resolver.replanCount || 0) >= MAX_REPLAN_SAFETY_CAP;
        const samePlan = proposedPlan
            && buildPlanSignature(proposedPlan) === buildPlanSignature(resolver.toolPlan);

        if (!proposedPlan || samePlan || researchExhausted || noExecutableWorkInCycle || replanCapReached) {
            const guardReason = !proposedPlan
                ? 'invalid_delegate'
                : (samePlan
                    ? 'same_plan'
                    : (researchExhausted
                        ? stopReason
                        : (replanCapReached ? 'replan_cap' : 'no_executable_work')));
            logEvent(getRequestId(resolver), 'plan.replan_blocked', {
                reason: guardReason,
                stopReason,
                callbackDepth,
                currentCycleExecutedToolCount: resolver._cycleExecutedToolCount || 0,
                proposedPlan,
                tools: summarizeReturnedCalls(currentToolCalls),
                source: 'streaming_supervisor_delegate',
            });
            const synthesisHistory = prepareForSynthesis(args, resolver);
            const finalized = await finalizeSynthesisFromEvidence(
                args,
                resolver,
                handlePromptError,
                synthesisHistory,
                guardReason,
                callbackDepth,
            );
            logRequestEnd(resolver);
            return finalized.result;
        }

        resolver.replanCount = (resolver.replanCount || 0) + 1;
        applyToolPlan(proposedPlan, resolver, { source: 'supervisor_delegate_stream' });
        logEvent(getRequestId(resolver), 'plan.replan', {
            replanCount: resolver.replanCount,
            source: 'streaming_supervisor_delegate',
            tools: summarizeReturnedCalls(currentToolCalls),
        });
        currentToolCalls = [];
        needsWorkerRound = true;
    }

    while (true) {
        resolver._cycleExecutedToolCount = 0;
        if (currentToolCalls.length > 0) {
            const { budgetExhausted } = await processToolCallRound(currentToolCalls, args, resolver, entityTools);
            if (budgetExhausted) currentToolCalls = [];
        }

        const shouldRunInitialWorkerRound = (
            !needsWorkerRound
            && currentToolCalls.length > 0
            && (resolver._cycleExecutedToolCount || 0) === 0
            && !!resolver.toolPlan
            && !resolver.entityRuntimeState?.stopReason
        );

        if ((needsWorkerRound || shouldRunInitialWorkerRound) && !resolver.entityRuntimeState?.stopReason) {
            const workerResult = await runSingleWorkerRound(
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

        // Strip SetGoals from supervisor context
        for (const msg of args.chatHistory) {
            if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('SetGoals')) {
                msg.content = msg.content.replace(/IMPORTANT:.*?2-5 items\.\n\n/s, '');
                break;
            }
        }
        args.chatHistory = stripSetGoalsFromHistory(args.chatHistory);

        const synthesisHistory = prepareForSynthesis(args, resolver);

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

function extractUserMessage(args) {
    let userMessage = args.text || '';
    if (!userMessage && args.chatHistory?.length > 0) {
        for (let i = args.chatHistory.length - 1; i >= 0; i--) {
            const msg = args.chatHistory[i];
            if (msg?.role === 'user') {
                const content = msg.content;
                if (typeof content === 'string') {
                    const trimmedContent = content.trim();
                    if (trimmedContent.startsWith('[system message:')) continue;
                    if (!trimmedContent.startsWith('{') || !trimmedContent.includes('"success"')) { userMessage = content; break; }
                } else if (Array.isArray(content)) {
                    const textItem = content.find(c => typeof c === 'string' || c?.type === 'text');
                    if (textItem) {
                        const textValue = typeof textItem === 'string' ? textItem : textItem.text;
                        if (String(textValue || '').trim().startsWith('[system message:')) continue;
                        userMessage = textValue;
                        break;
                    }
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

export async function toolCallbackCore(args, message, resolver) {
    if (!args || !message || !resolver) return;

    const { entityTools, entityToolsOpenAiFormat } = args;
    resolver.toolBudgetUsed = resolver.toolBudgetUsed || 0;
    resolver.toolCallRound = resolver.toolCallRound || 0;
    if (!resolver.toolResultStore) resolver.toolResultStore = new Map();
    if (!resolver.toolCallCache) resolver.toolCallCache = new Map();
    if (!resolver.semanticToolCache) resolver.semanticToolCache = new Map();

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

    const runtimeOrientationPacket = safeParseRuntimeValue(args.runtimeOrientationPacket);
    const runtimeContext = isEntityRuntimeEnabled(args)
        ? {
            enabled: true,
            goal: args.runGoal || args.text || '',
            origin: args.runtimeOrigin || invocationType || 'chat',
            stage: args.runtimeStage || 'plan',
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
            runtimeStage: args.runtimeStage || null,
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
        effectiveModelPolicy.synthesisReasoningEffort
        || runtimeRoute.synthesisReasoningEffort
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
        args.synthesisReasoningEffort = FAST_CHAT_REASONING_EFFORT;
    }
    args.toolLoopModel = toolLoopModel;
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
        ? getFastPathModel(args)
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

        if (runtimeRoute.mode === 'direct_search') {
            logEvent(rid, 'route.preflight_skipped', {
                mode: runtimeRoute.mode,
                reason: runtimeRoute.reason,
                skipped: ['file_sync', 'context_compression', 'formal_planning'],
            });
            const fastResult = await runDirectSearchFastPath(
                runtimeRoute,
                args,
                resolver,
                entityTools,
                entityToolsOpenAiFormat,
                makeErrorHandler(args, resolver),
            );
            if (isPulse && useContinuityMemory && resolver.continuityEntityId) {
                await recordPulseMemory(resolver, args, fastResult, entityName, entityInstructions);
            } else if (useContinuityMemory && resolver.continuityEntityId && resolver.continuityUserId) {
                await recordConversationMemory(resolver, args, fastResult, entityName, entityInstructions);
            }

            logRequestEnd(resolver);
            await finalizeRuntimeRun(args, resolver, fastResult);
            return fastResult;
        }

        if (runtimeRoute.mode === 'direct_reply') {
            logEvent(rid, 'route.preflight_skipped', {
                mode: runtimeRoute.mode,
                reason: runtimeRoute.reason,
                skipped: ['file_sync', 'context_compression'],
            });
            const fastResult = await runDirectReplyFastPath(runtimeRoute, args, resolver, makeErrorHandler(args, resolver));
            if (isPulse && useContinuityMemory && resolver.continuityEntityId) {
                await recordPulseMemory(resolver, args, fastResult, entityName, entityInstructions);
            } else if (useContinuityMemory && resolver.continuityEntityId && resolver.continuityUserId) {
                await recordConversationMemory(resolver, args, fastResult, entityName, entityInstructions);
            }

            logRequestEnd(resolver);
            await finalizeRuntimeRun(args, resolver, fastResult);
            return fastResult;
        }

        const { chatHistory: strippedHistory, availableFiles } = await syncAndStripFilesFromChatHistory(args.chatHistory, args.agentContext, chatId, entityId);
        args.chatHistory = strippedHistory;
        resolver.args = {...args};

        try { args.chatHistory = await compressContextIfNeeded(args.chatHistory, resolver, args); }
        catch (e) { logEventError(rid, 'request.error', { phase: 'compression', error: e.message }); }
        resolver.args = {...args};

        const hasTools = entityToolsOpenAiFormat.length > 0;
        const firstCallTools = hasTools ? [...planningToolsOpenAiFormat, SET_GOALS_OPENAI_DEF] : planningToolsOpenAiFormat;

        await markRuntimeStage(resolver, 'plan', 'Running initial planning/model pass', {
            model: args.planningModel || args.primaryModel,
        });

        const initialCallModel = args.planningModel || args.primaryModel;
        const initialCallArgs = applyPromptCacheOptions(withVisibleModel({
            ...args, chatHistory: cloneMessages(args.chatHistory), availableFiles,
            stream: args.stream, reasoningEffort: args.planningReasoningEffort || args.configuredReasoningEffort || 'low',
            tools: firstCallTools, tool_choice: "auto"
        }, initialCallModel), 'initial', initialCallModel);

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
            model: args.planningModel || args.primaryModel, purpose: 'initial',
            returnedToolCalls: summarizeReturnedCalls(extractToolCalls(response)),
            streamingCallback: hadStreamingCallback,
            contentChars: (response instanceof CortexResponse ? response.output_text?.length : (typeof response === 'string' ? response.length : 0)) || 0,
        });

        const initialToolCalls = extractToolCalls(response);
        const toolCallback = toolCallbackOverride || resolver.pathway.toolCallback || toolCallbackCore;
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
                await finalizeRuntimeRun(args, resolver, errorResponse);
                return errorResponse;
            }
        }

        if (initialToolCalls.length === 0) {
            response = await maybeFinalizeInitialResponse({
                response,
                args,
                resolver,
                initialCallModel,
            });
        }

        response = repairManagedMediaUrlsInResponse(
            response,
            resolver,
            args.chatHistory || [],
        );

        if (isPulse && useContinuityMemory && resolver.continuityEntityId) {
            await recordPulseMemory(resolver, args, response, entityName, entityInstructions);
        } else if (useContinuityMemory && resolver.continuityEntityId && resolver.continuityUserId) {
            await recordConversationMemory(resolver, args, response, entityName, entityInstructions);
        }

        syncRuntimeResultData(resolver, args);

        const isStreamObject = response && typeof response.on === 'function';
        if (!isStreamObject && !extractResponseText(response).trim()) {
            logEventError(rid, 'request.error', { phase: 'empty_response', error: 'All processing completed but no text was produced', durationMs: Date.now() - requestStartTime });
            response = await generateErrorResponse(
                new Error('I processed your request but wasn\'t able to generate a response. Please try again.'),
                args, resolver
            );
        }

        await finalizeRuntimeRun(args, resolver, response);

        if (!resolver._requestEndLogged) {
            const usage = summarizeUsage(resolver.pathwayResultData?.usage);
            logEvent(rid, 'request.end', {
                durationMs: Date.now() - requestStartTime, toolRounds: resolver.toolCallRound || 0,
                budgetUsed: resolver.toolBudgetUsed || 0, ...(usage && { tokens: usage }),
            });
        }

        if (args.stream) {
            const finalResponseText = resolver.streamedContent || extractResponseText(response) || '';
            publishRequestProgress({
                requestId: rid,
                progress: 1,
                data: JSON.stringify(finalResponseText),
                info: JSON.stringify(resolver.pathwayResultData || {}),
                error: resolver.errors?.length > 0 ? resolver.errors.join(', ') : ''
            });
        }

        return response;
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
