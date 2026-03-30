import { hashPromptCacheConversationId, hashPromptCacheKey } from '../promptCaching.js';
import { normalizeConversationMode } from './policy.js';

const IMAGE_FILE_PATTERN = /\b[\w][\w.-]*\.(?:png|jpe?g|webp|gif)\b/gi;

export const DIRECT_ROUTE_WORKSPACE_COMMAND = [
    'printf "/workspace\\n"',
    "find /workspace -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort | sed -n '1,200p'",
    "printf '\\n/workspace/files\\n'",
    "[ -d /workspace/files ] && find /workspace/files -maxdepth 2 -type f | sed 's#^/workspace/files/##' | sort | sed -n '1,200p' || true",
].join('; ');

const TOOL_CATEGORY_TOOLS = Object.freeze({
    workspace: ['WorkspaceSSH', 'ViewImages', 'SetBaseAvatar', 'AnalyzePDF', 'AnalyzeVideo'],
    images: ['ViewImages', 'SetBaseAvatar', 'WorkspaceSSH', 'CreateMedia'],
    web: ['SearchInternet', 'FetchWebPageContentJina', 'SearchXPlatform', 'AnalyzePDF', 'AnalyzeVideo', 'CreateChart'],
    memory: ['SearchMemory', 'StoreContinuityMemory'],
    media: ['CreateMedia', 'GenerateSlides', 'ViewImages', 'ShowOverlay'],
    chart: ['CreateChart', 'GenerateSlides'],
    general: [],
});

function normalizeText(text = '') {
    return String(text || '').trim().toLowerCase();
}

function normalizeModeConfidence(value = '') {
    return String(value || '').trim().toLowerCase() === 'high' ? 'high' : 'low';
}

function dedupe(values = []) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function collectStrings(value) {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(collectStrings);
    if (typeof value === 'object') return Object.values(value).flatMap(collectStrings);
    return [];
}

function hasTool(availableToolNames = [], toolName = '') {
    const lower = toolName.toLowerCase();
    return availableToolNames.some(name => String(name).toLowerCase() === lower);
}

export function extractFilenameMentions(text = '') {
    return dedupe(Array.from(String(text || '').matchAll(IMAGE_FILE_PATTERN), match => match[0]));
}

export function extractRecentFileReferences(chatHistory = []) {
    const files = [];

    const pushString = (text) => {
        for (const filename of extractFilenameMentions(text)) files.push(filename);
        if (typeof text !== 'string') return;
        try {
            const parsed = JSON.parse(text);
            for (const str of collectStrings(parsed)) {
                for (const filename of extractFilenameMentions(str)) files.push(filename);
            }
        } catch {
            // Raw text is common; filename extraction above already handled it.
        }
    };

    for (let i = chatHistory.length - 1; i >= 0; i--) {
        const message = chatHistory[i];
        if (!message) continue;

        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                pushString(toolCall?.function?.arguments || '');
            }
        }

        const fragments = collectStrings(message.content);
        for (const fragment of fragments) pushString(fragment);
    }

    return dedupe(files);
}

export function shortlistInitialTools({ text = '', availableToolNames = [] } = {}) {
    return [];
}

export function shortlistToolsForCategory(category = '', availableToolNames = []) {
    const tools = TOOL_CATEGORY_TOOLS[String(category || '').toLowerCase()] || [];
    return tools.filter(toolName => hasTool(availableToolNames, toolName));
}

export function routeEntityTurn({
    text = '',
    chatHistory = [],
    availableToolNames = [],
    invocationType = '',
    conversationMode = 'chat',
    conversationModeConfidence = 'low',
} = {}) {
    const normalizedText = normalizeText(text);
    if (invocationType === 'pulse' || !normalizedText) {
        return { mode: 'plan', reason: 'default', initialToolNames: [] };
    }

    const currentMode = normalizeConversationMode(conversationMode);
    const currentModeConfidence = normalizeModeConfidence(conversationModeConfidence);
    const modeRoute = ['agentic', 'research'].includes(currentMode)
        ? 'plan'
        : (currentModeConfidence === 'high' ? 'direct_reply' : 'plan');

    return {
        mode: modeRoute,
        reason: `${currentMode}_mode`,
        routeSource: 'conversation_mode',
        initialToolNames: [],
    };
}

export function buildPromptCacheKey({
    entityId = '',
    contextId = '',
    invocationType = '',
    purpose = '',
    model = '',
    routeMode = '',
    toolNames = [],
} = {}) {
    const parts = [
        'entity-runtime',
        entityId || 'entity:none',
        contextId || 'context:none',
        invocationType || 'origin:none',
        purpose || 'purpose:none',
        routeMode || 'route:default',
        dedupe(toolNames.map(name => String(name).toLowerCase())).sort().join(',') || 'tools:none',
    ];

    return hashPromptCacheKey(parts.join('|'), { prefix: `er:${purpose || 'default'}`, maxLength: 64 });
}

export function buildPromptCacheHint(options = {}) {
    const descriptorParts = [
        'entity-runtime',
        options.entityId || 'entity:none',
        options.contextId || 'context:none',
        options.invocationType || 'origin:none',
        options.purpose || 'purpose:none',
        options.routeMode || 'route:default',
        dedupe((options.toolNames || []).map(name => String(name).toLowerCase())).sort().join(',') || 'tools:none',
    ];

    const descriptor = descriptorParts.join('|').slice(0, 512);
    return {
        key: buildPromptCacheKey(options),
        descriptor,
        conversationId: hashPromptCacheConversationId([
            options.entityId || 'entity:none',
            options.contextId || 'context:none',
            options.invocationType || 'origin:none',
        ].join('|')),
    };
}
