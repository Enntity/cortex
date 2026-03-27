import { hashPromptCacheConversationId, hashPromptCacheKey } from '../promptCaching.js';

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

const TOOL_FAMILY_RULES = [
    {
        category: 'workspace',
        test: (text) => (
            /\b(file|files|folder|folders|workspace|stash|directory|directories)\b/.test(text)
            || /\b(ls|list|browse|show)\b/.test(text)
        ),
        tools: TOOL_CATEGORY_TOOLS.workspace,
    },
    {
        category: 'images',
        test: (text) => (
            /\b(image|images|photo|photos|picture|pictures|avatar|selfie)\b/.test(text)
            || /\blook at\b/.test(text)
            || /\bview\b/.test(text)
        ),
        tools: TOOL_CATEGORY_TOOLS.images,
    },
    {
        category: 'web',
        test: (text) => (
            /\b(today|latest|recent|current|news|headline|headlines|happening|weather|price|prices|stock|stocks)\b/.test(text)
            || /\bsearch\b/.test(text)
        ),
        tools: TOOL_CATEGORY_TOOLS.web,
    },
    {
        category: 'memory',
        test: (text) => (
            /\bremember\b/.test(text)
            || /\bmemory\b/.test(text)
            || /\brecall\b/.test(text)
        ),
        tools: TOOL_CATEGORY_TOOLS.memory,
    },
    {
        category: 'media',
        test: (text) => (
            /\b(generate|create|make|draw|render|edit|modify)\b/.test(text)
            && /\b(image|video|slide|slides|infographic|presentation)\b/.test(text)
        ),
        tools: TOOL_CATEGORY_TOOLS.media,
    },
    {
        category: 'chart',
        test: (text) => /\b(chart|graph|diagram|plot)\b/.test(text),
        tools: TOOL_CATEGORY_TOOLS.chart,
    },
];

function normalizeText(text = '') {
    return String(text || '').trim().toLowerCase();
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

function hasTool(availableToolNames = [], toolName = '') {
    const lower = toolName.toLowerCase();
    return availableToolNames.some(name => String(name).toLowerCase() === lower);
}

function looksLikeWorkspaceInventory(text = '') {
    return (
        /\bwhat (?:other )?files do you see\b/.test(text)
        || /\bwhat files (?:can|do) you see\b/.test(text)
        || /\bwhat(?:'s| is) in (?:the )?(?:stash|workspace|workspace\/files)\b/.test(text)
        || /\b(?:list|show|browse|check)\b.*\b(?:files|workspace|stash|folder|directory)\b/.test(text)
    );
}

function looksLikeAvatarChange(text = '', explicitFiles = []) {
    return explicitFiles.length > 0
        && /\b(?:try|use|set|switch|swap|make)\b/.test(text);
}

function looksLikeImageInspection(text = '', explicitFiles = []) {
    return explicitFiles.length > 0
        ? /\b(?:look at|view|see|inspect)\b/.test(text)
        : /\b(?:look at|did you look at|view|inspect)\b.*\b(?:it|this|that)\b/.test(text);
}

function looksLikeDirectReply(text = '') {
    if (!text) return false;
    if (/\b(today|latest|recent|current|news|weather|price|stock|search|find|look up|browse|workspace|files|file|folder|directory|avatar|image|photo|picture|video|audio|pdf|upload|generate|create|make|draw|render|edit|modify|code|debug|fix|build|deploy|run|test)\b/.test(text)) {
        return false;
    }

    return (
        /^(?:hey|hi|hello|yo|sup|what's up|whats up)\b/.test(text)
        || /\bmiss me\??$/.test(text)
        || /\bhow are you\b/.test(text)
        || /\bhow'?s it going\b/.test(text)
        || /\bwhat have you been up to\b/.test(text)
        || /\bwhat've you been up to\b/.test(text)
        || /\bhow have you been\b/.test(text)
        || /\bgood morning\b/.test(text)
        || /\bgood night\b/.test(text)
    );
}

export function shortlistInitialTools({ text = '', availableToolNames = [] } = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return [];

    const shortlist = [];
    for (const rule of TOOL_FAMILY_RULES) {
        if (!rule.test(normalizedText)) continue;
        for (const toolName of rule.tools) {
            if (hasTool(availableToolNames, toolName)) shortlist.push(toolName);
        }
    }

    return dedupe(shortlist);
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
} = {}) {
    const normalizedText = normalizeText(text);
    if (invocationType === 'pulse' || !normalizedText) {
        return { mode: 'plan', reason: 'default', initialToolNames: [] };
    }

    const explicitFiles = extractFilenameMentions(text);
    const recentFiles = extractRecentFileReferences(chatHistory);
    const targetImageFile = explicitFiles[0] || recentFiles[0] || null;

    if (hasTool(availableToolNames, 'WorkspaceSSH') && looksLikeWorkspaceInventory(normalizedText)) {
        return {
            mode: 'direct_tool',
            reason: 'workspace_inventory',
            routeSource: 'heuristic',
            toolName: 'WorkspaceSSH',
            toolArgs: {
                command: DIRECT_ROUTE_WORKSPACE_COMMAND,
                userMessage: 'Checking the workspace files directly',
                timeoutSeconds: 60,
            },
            initialToolNames: shortlistInitialTools({ text, availableToolNames }),
        };
    }

    if (hasTool(availableToolNames, 'SetBaseAvatar') && looksLikeAvatarChange(normalizedText, explicitFiles)) {
        return {
            mode: 'direct_tool',
            reason: 'set_base_avatar',
            routeSource: 'heuristic',
            toolName: 'SetBaseAvatar',
            toolArgs: {
                file: explicitFiles[0],
                userMessage: `Switching the base avatar to ${explicitFiles[0]}`,
            },
            initialToolNames: shortlistInitialTools({ text, availableToolNames }),
        };
    }

    if (targetImageFile && hasTool(availableToolNames, 'ViewImages') && looksLikeImageInspection(normalizedText, explicitFiles)) {
        return {
            mode: 'direct_tool',
            reason: 'view_image',
            routeSource: 'heuristic',
            toolName: 'ViewImages',
            toolArgs: {
                files: [targetImageFile],
                userMessage: `Looking at ${targetImageFile}`,
            },
            initialToolNames: shortlistInitialTools({ text, availableToolNames }),
        };
    }

    if (looksLikeDirectReply(normalizedText)) {
        return {
            mode: 'direct_reply',
            reason: 'casual_chat',
            routeSource: 'heuristic',
            initialToolNames: [],
            planningReasoningEffort: 'low',
            synthesisReasoningEffort: 'low',
        };
    }

    return {
        mode: 'plan',
        reason: 'default',
        routeSource: 'heuristic',
        initialToolNames: shortlistInitialTools({ text, availableToolNames }),
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
