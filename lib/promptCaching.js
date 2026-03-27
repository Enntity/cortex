import { createHash } from 'crypto';

function safeJsonParse(value) {
    if (typeof value !== 'string' || value.trim() === '') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

export function hashPromptCacheKey(input, { prefix = 'pc', maxLength = 64 } = {}) {
    const digest = createHash('sha256').update(String(input || '')).digest('hex');
    const safePrefix = String(prefix || 'pc').replace(/[^a-z0-9:_-]/gi, '').toLowerCase() || 'pc';
    const head = safePrefix.slice(0, Math.max(1, maxLength - 9));
    const value = `${head}:${digest}`;
    return value.slice(0, maxLength);
}

export function hashPromptCacheConversationId(input) {
    const digest = createHash('sha256').update(String(input || '')).digest('hex').slice(0, 32).split('');
    digest[12] = '4';
    const variant = parseInt(digest[16], 16);
    digest[16] = ['8', '9', 'a', 'b'][variant % 4];
    return `${digest.slice(0, 8).join('')}-${digest.slice(8, 12).join('')}-${digest.slice(12, 16).join('')}-${digest.slice(16, 20).join('')}-${digest.slice(20, 32).join('')}`;
}

export function normalizePromptCacheHint(parameters = {}) {
    const explicitHint = safeJsonParse(parameters.promptCache ?? parameters.prompt_cache);

    if (explicitHint && typeof explicitHint === 'object' && !Array.isArray(explicitHint)) {
        return {
            enabled: explicitHint.enabled !== false,
            key: explicitHint.key ? String(explicitHint.key) : '',
            descriptor: explicitHint.descriptor ? String(explicitHint.descriptor) : '',
            conversationId: explicitHint.conversationId ? String(explicitHint.conversationId) : '',
            cachedContent: explicitHint.cachedContent ? String(explicitHint.cachedContent) : '',
            retention: explicitHint.retention ? String(explicitHint.retention) : undefined,
            ttl: explicitHint.ttl ? String(explicitHint.ttl) : undefined,
        };
    }

    if (parameters.prompt_cache_key || parameters.prompt_cache_retention) {
        return {
            enabled: true,
            key: parameters.prompt_cache_key ? String(parameters.prompt_cache_key) : '',
            descriptor: parameters.prompt_cache_key ? String(parameters.prompt_cache_key) : '',
            retention: parameters.prompt_cache_retention ? String(parameters.prompt_cache_retention) : undefined,
        };
    }

    return null;
}

export function applyOpenAIPromptCache(requestParameters = {}, parameters = {}, options = {}) {
    const hint = normalizePromptCacheHint(parameters);
    if (!hint?.enabled) return requestParameters;

    const source = hint.key || hint.descriptor;
    if (!source) return requestParameters;

    const maxKeyLength = options.maxKeyLength || 64;
    const cacheKey = source.length <= maxKeyLength
        ? source
        : hashPromptCacheKey(source, {
            prefix: options.prefix || 'er',
            maxLength: maxKeyLength,
        });

    return {
        ...requestParameters,
        prompt_cache_key: cacheKey,
        ...(hint.retention ? { prompt_cache_retention: hint.retention } : {}),
    };
}

export function applyAnthropicPromptCache(requestParameters = {}, parameters = {}, options = {}) {
    const hint = normalizePromptCacheHint(parameters);
    if (!hint?.enabled) return requestParameters;

    const cacheControl = { type: 'ephemeral' };
    if (hint.ttl && !options.vertex) {
        cacheControl.ttl = hint.ttl;
    }

    const system = requestParameters.system;
    let nextRequestParameters = requestParameters;

    if (Array.isArray(requestParameters.tools) && requestParameters.tools.length > 0) {
        const nextTools = [...requestParameters.tools];
        const lastToolIndex = nextTools.length - 1;
        nextTools[lastToolIndex] = {
            ...nextTools[lastToolIndex],
            cache_control: cacheControl,
        };
        nextRequestParameters = {
            ...nextRequestParameters,
            tools: nextTools,
        };
    }

    if (typeof system === 'string' && system.trim()) {
        return {
            ...nextRequestParameters,
            system: [{ type: 'text', text: system, cache_control: cacheControl }],
        };
    }

    if (Array.isArray(system) && system.length > 0) {
        const nextSystem = [...system];
        const lastIndex = nextSystem.length - 1;
        const lastBlock = nextSystem[lastIndex];
        nextSystem[lastIndex] = {
            ...lastBlock,
            cache_control: cacheControl,
        };
        return {
            ...nextRequestParameters,
            system: nextSystem,
        };
    }

    return nextRequestParameters;
}

export function applyGooglePromptCache(requestParameters = {}, parameters = {}) {
    const hint = normalizePromptCacheHint(parameters);
    if (!hint?.enabled) return requestParameters;

    const cachedContent = hint.cachedContent || parameters.cachedContent || parameters.cached_content;
    if (!cachedContent) return requestParameters;

    return {
        ...requestParameters,
        cachedContent: String(cachedContent),
    };
}

export function applyXAIPromptCacheHeaders(headers = {}, parameters = {}) {
    const hint = normalizePromptCacheHint(parameters);
    if (!hint?.enabled) return headers || {};

    const source = hint.conversationId || hint.key || hint.descriptor;
    if (!source) return headers || {};

    return {
        ...(headers || {}),
        'x-grok-conv-id': hint.conversationId || hashPromptCacheConversationId(source),
    };
}

export function applyPromptCacheToRequest(requestParameters = {}, parameters = {}, support = {}, options = {}) {
    switch (support?.provider) {
        case 'openai':
            return applyOpenAIPromptCache(requestParameters, parameters, options);
        case 'anthropic':
            return applyAnthropicPromptCache(requestParameters, parameters, options);
        case 'google':
            return applyGooglePromptCache(requestParameters, parameters, options);
        default:
            return requestParameters;
    }
}

export function applyPromptCacheToHeaders(headers = {}, parameters = {}, support = {}, options = {}) {
    switch (support?.provider) {
        case 'xai':
            return applyXAIPromptCacheHeaders(headers, parameters, options);
        default:
            return headers || {};
    }
}
