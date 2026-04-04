import { config } from '../../config.js';
import { getModelProfileStore } from '../MongoModelProfileStore.js';
import logger from '../logger.js';
import {
    CONVERSATION_MODES,
    DEFAULT_AUTHORITY_BY_ORIGIN,
    DEFAULT_CONVERSATION_MODE,
    DEFAULT_ROUTING_MODEL,
    DEFAULT_RESEARCH_MODEL,
    ENTITY_RUNTIME_MODE,
} from './constants.js';

const NSFW_PROFILE_SLUG = 'nsfw';

function safeParseJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

function pickPositiveNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return null;
}

function isModelAvailable(modelId) {
    if (!modelId) return false;
    return !!config.get('models')?.[modelId];
}

function selectAvailableModel(...candidates) {
    for (const candidate of candidates) {
        if (candidate && isModelAvailable(candidate)) return candidate;
    }
    return pickFirstString(...candidates);
}

function normalizeReasoningEffort(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['none', 'low', 'medium', 'high'].includes(normalized) ? normalized : null;
}

const BUILTIN_MODEL_PROFILE_CANDIDATES = Object.freeze({
    balanced: {
        primaryModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        orientationModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        planningModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        researchModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        childModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        synthesisModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        verificationModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        compressionModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        routingModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
    },
    fast: {
        primaryModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        orientationModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        planningModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        researchModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        childModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        synthesisModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        verificationModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        compressionModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        routingModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
    },
    quality: {
        primaryModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        orientationModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        planningModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        researchModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        childModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        synthesisModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        verificationModel: ['oai-gpt54', 'oai-gpt52', 'oai-gpt41'],
        compressionModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
        routingModel: ['oai-gpt54-mini', 'oai-gpt41-nano'],
    },
    gemini: {
        primaryModel: ['gemini-flash-3-vision'],
        orientationModel: ['gemini-flash-3-vision'],
        planningModel: ['gemini-flash-3-vision'],
        researchModel: ['gemini-flash-31-lite-vision'],
        childModel: ['gemini-flash-31-lite-vision'],
        synthesisModel: ['gemini-flash-3-vision'],
        verificationModel: ['gemini-flash-3-vision'],
        compressionModel: ['gemini-flash-31-lite-vision'],
        routingModel: ['gemini-flash-31-lite-vision'],
    },
    claude: {
        primaryModel: ['claude-46-sonnet'],
        orientationModel: ['claude-46-sonnet'],
        planningModel: ['claude-46-sonnet'],
        researchModel: ['claude-46-haiku', 'claude-45-haiku'],
        childModel: ['claude-46-haiku', 'claude-45-haiku'],
        synthesisModel: ['claude-46-sonnet'],
        verificationModel: ['claude-46-sonnet'],
        compressionModel: ['claude-46-haiku', 'claude-45-haiku'],
        routingModel: ['claude-46-haiku', 'claude-45-haiku'],
    },
});

const BUILTIN_MODEL_PROFILE_REASONING = Object.freeze({
    gemini: {
        synthesisReasoningEffort: 'high',
    },
});

const BUILTIN_MODEL_POLICY_SLOTS = Object.freeze([
    'primaryModel',
    'orientationModel',
    'planningModel',
    'researchModel',
    'childModel',
    'synthesisModel',
    'verificationModel',
    'compressionModel',
    'routingModel',
]);

const MODEL_POLICY_REASONING_SLOTS = Object.freeze([
    'primaryReasoningEffort',
    'orientationReasoningEffort',
    'planningReasoningEffort',
    'researchReasoningEffort',
    'childReasoningEffort',
    'synthesisReasoningEffort',
    'verificationReasoningEffort',
    'compressionReasoningEffort',
    'routingReasoningEffort',
]);

const DEFAULT_BUILTIN_MODEL_PROFILE_ID = 'balanced';

function resolveBuiltinProfileModelPolicy(profileId = '') {
    const candidates = BUILTIN_MODEL_PROFILE_CANDIDATES[String(profileId || '').trim()];
    if (!candidates) return null;
    const reasoning = BUILTIN_MODEL_PROFILE_REASONING[String(profileId || '').trim()] || {};

    return {
        ...Object.fromEntries(
            Object.entries(candidates).map(([slot, slotCandidates]) => [
                slot,
                selectAvailableModel(...slotCandidates),
            ]),
        ),
        ...Object.fromEntries(
            Object.entries(reasoning)
                .map(([slot, value]) => [slot, normalizeReasoningEffort(value)])
                .filter(([, value]) => !!value),
        ),
    };
}

function inferBuiltinProfileIdFromPolicy(modelPolicy = {}) {
    if (!modelPolicy || typeof modelPolicy !== 'object' || Array.isArray(modelPolicy)) return null;

    const configuredSlots = BUILTIN_MODEL_POLICY_SLOTS.filter(slot => {
        const value = modelPolicy?.[slot];
        return typeof value === 'string' && value.trim();
    });

    if (configuredSlots.length === 0) return null;

    const matches = Object.entries(BUILTIN_MODEL_PROFILE_CANDIDATES)
        .filter(([, candidates]) => configuredSlots.every(slot => {
            const slotCandidates = Array.isArray(candidates?.[slot]) ? candidates[slot] : [];
            return slotCandidates.includes(modelPolicy[slot]);
        }))
        .map(([profileId]) => profileId);

    if (matches.length === 1) return matches[0];
    if (matches.includes(DEFAULT_BUILTIN_MODEL_PROFILE_ID)) {
        return DEFAULT_BUILTIN_MODEL_PROFILE_ID;
    }
    return null;
}

export function normalizeConversationMode(mode = '') {
    const value = String(mode || '').trim().toLowerCase();
    return CONVERSATION_MODES.includes(value) ? value : DEFAULT_CONVERSATION_MODE;
}

export function applyConversationModeAffiliation(modelPolicy = {}, conversationMode = DEFAULT_CONVERSATION_MODE) {
    return applyConversationModeAffiliationWithPolicy(modelPolicy, conversationMode);
}

function getFallbackNsfwPolicy() {
    const nsfwPrimary = selectAvailableModel(
        'xai-grok-4-20-0309-non-reasoning',
        'xai-grok-4-20-0309-reasoning',
        'xai-grok-4-responses'
    );
    if (!nsfwPrimary) return null;

    return {
        primaryModel: nsfwPrimary,
        orientationModel: nsfwPrimary,
        planningModel: nsfwPrimary,
        researchModel: nsfwPrimary,
        childModel: nsfwPrimary,
        synthesisModel: nsfwPrimary,
        verificationModel: nsfwPrimary,
        compressionModel: nsfwPrimary,
        routingModel: nsfwPrimary,
    };
}

export function applyConversationModeAffiliationWithPolicy(
    modelPolicy = {},
    conversationMode = DEFAULT_CONVERSATION_MODE,
    affiliationPolicy = null,
) {
    const mode = normalizeConversationMode(conversationMode);
    if (mode !== 'nsfw') return { ...(modelPolicy || {}) };
    const nsfwPolicy = affiliationPolicy || getFallbackNsfwPolicy();
    if (!nsfwPolicy) return { ...(modelPolicy || {}) };

    return {
        ...(modelPolicy || {}),
        ...nsfwPolicy,
    };
}

export async function getConversationModeAffiliationPolicy(
    conversationMode = DEFAULT_CONVERSATION_MODE,
) {
    const mode = normalizeConversationMode(conversationMode);
    if (mode !== 'nsfw') return null;

    try {
        const store = getModelProfileStore();
        const profile = await store.getProfileBySlug(NSFW_PROFILE_SLUG);
        if (profile?.modelPolicy && Object.keys(profile.modelPolicy).length > 0) {
            return profile.modelPolicy;
        }
    } catch (error) {
        logger?.warn?.(`Failed to resolve NSFW model profile: ${error.message}`);
    }

    return getFallbackNsfwPolicy();
}

export function getRuntimeOrigin(args = {}) {
    if (args.runtimeOrigin) return args.runtimeOrigin;
    if (args.invocationType) return args.invocationType;
    return 'chat';
}

export function isEntityRuntimeEnabled(args = {}) {
    return args.runtimeMode === ENTITY_RUNTIME_MODE;
}

export function normalizeToolFamily(toolName = '') {
    const name = toolName.toLowerCase();
    if (['searchinternet', 'googlesearch', 'googlenews', 'searchx', 'searchxplatform'].includes(name)) return 'search';
    if (['fetchwebpagecontentjina', 'browserjina', 'analyzepdf', 'analyzevideo'].includes(name)) return 'fetch';
    if (['searchmemory'].includes(name)) return 'memory';
    if (['delegatetask'].includes(name)) return 'child';
    return 'other';
}

export function normalizeTextKey(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/https?:\/\//g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function buildSemanticToolKey(toolName = '', toolArgs = {}) {
    const family = normalizeToolFamily(toolName);
    if (family === 'search') return `${family}:${normalizeTextKey(toolArgs.q || toolArgs.query || toolArgs.text || '')}`;
    if (family === 'fetch') return `${family}:${normalizeTextKey(toolArgs.url || toolArgs.fileUrl || '')}`;
    if (family === 'memory') return `${family}:${normalizeTextKey(toolArgs.query || toolArgs.q || toolArgs.text || '')}`;
    return `${toolName.toLowerCase()}:${normalizeTextKey(JSON.stringify(toolArgs || {}))}`;
}

export function resolveEntityModelPolicy({ entityConfig = {}, args = {}, resolver = {} } = {}) {
    const resolvedEntityConfig = entityConfig || {};
    const overridePolicy = safeParseJson(args.modelPolicy) || {};
    const configuredPolicyRaw =
        resolvedEntityConfig.modelPolicy &&
        typeof resolvedEntityConfig.modelPolicy === 'object' &&
        !Array.isArray(resolvedEntityConfig.modelPolicy)
            ? resolvedEntityConfig.modelPolicy
            : {};
    const hasConfiguredPolicy = Object.keys(configuredPolicyRaw).length > 0;
    const inferredBuiltinProfileId = pickFirstString(
        configuredPolicyRaw.profileId,
        inferBuiltinProfileIdFromPolicy(configuredPolicyRaw),
        hasConfiguredPolicy ? null : DEFAULT_BUILTIN_MODEL_PROFILE_ID,
    );
    const builtinProfilePolicy = resolveBuiltinProfileModelPolicy(
        inferredBuiltinProfileId,
    );
    const configuredPolicy = builtinProfilePolicy
        ? { ...configuredPolicyRaw, profileId: inferredBuiltinProfileId, ...builtinProfilePolicy }
        : configuredPolicyRaw;
    const systemDefaultModel = config.get('defaultModelName') || resolver.modelName || null;
    const configuredPrimary = pickFirstString(
        overridePolicy.primaryModel,
        configuredPolicy.primaryModel
    );
    const voiceModel = selectAvailableModel(
        configuredPrimary,
        overridePolicy.orientationModel,
        configuredPolicy.orientationModel,
        systemDefaultModel
    );
    // Operational slots — specialised defaults lead, then fall back to the
    // profile's primary/voice model.
    const researchDefault = selectAvailableModel(
        overridePolicy.researchModel,
        configuredPolicy.researchModel,
        DEFAULT_RESEARCH_MODEL,
        systemDefaultModel,
        voiceModel
    );
    const routingDefault = selectAvailableModel(
        overridePolicy.routingModel,
        configuredPolicy.routingModel,
        DEFAULT_ROUTING_MODEL,
        researchDefault,
        systemDefaultModel,
        voiceModel
    );
    const resolvedReasoningPolicy = Object.fromEntries(
        MODEL_POLICY_REASONING_SLOTS.map(slot => [
            slot,
            normalizeReasoningEffort(overridePolicy[slot]) || normalizeReasoningEffort(configuredPolicy[slot]),
        ]).filter(([, value]) => !!value),
    );

    return {
        orientationModel: selectAvailableModel(
            overridePolicy.orientationModel,
            configuredPolicy.orientationModel,
            voiceModel,
            systemDefaultModel
        ),
        planningModel: selectAvailableModel(
            overridePolicy.planningModel,
            configuredPolicy.planningModel,
            voiceModel,
            systemDefaultModel
        ),
        researchModel: researchDefault,
        childModel: selectAvailableModel(
            overridePolicy.childModel,
            configuredPolicy.childModel,
            researchDefault,
            systemDefaultModel,
            voiceModel
        ),
        synthesisModel: selectAvailableModel(
            overridePolicy.synthesisModel,
            configuredPolicy.synthesisModel,
            voiceModel,
            systemDefaultModel
        ),
        verificationModel: selectAvailableModel(
            overridePolicy.verificationModel,
            configuredPolicy.verificationModel,
            voiceModel,
            systemDefaultModel
        ),
        compressionModel: selectAvailableModel(
            overridePolicy.compressionModel,
            configuredPolicy.compressionModel,
            researchDefault,
            systemDefaultModel,
            voiceModel
        ),
        routingModel: routingDefault,
        primaryModel: voiceModel,
        ...resolvedReasoningPolicy,
    };
}

export function resolveAuthorityEnvelope({ entityConfig = {}, args = {}, origin } = {}) {
    const resolvedEntityConfig = entityConfig || {};
    const runtimeOrigin = origin || getRuntimeOrigin(args);
    const base = DEFAULT_AUTHORITY_BY_ORIGIN[runtimeOrigin] || DEFAULT_AUTHORITY_BY_ORIGIN.chat;
    const configured = resolvedEntityConfig.authorityProfile || {};
    const override = safeParseJson(args.authorityEnvelope) || {};

    const envelope = {
        ...base,
        ...configured,
        ...override,
    };

    return {
        maxWallClockMs: pickPositiveNumber(envelope.maxWallClockMs, base.maxWallClockMs),
        maxToolBudget: pickPositiveNumber(envelope.maxToolBudget, base.maxToolBudget),
        maxResearchRounds: pickPositiveNumber(envelope.maxResearchRounds, base.maxResearchRounds),
        maxSearchCalls: pickPositiveNumber(envelope.maxSearchCalls, base.maxSearchCalls),
        maxFetchCalls: pickPositiveNumber(envelope.maxFetchCalls, base.maxFetchCalls),
        maxChildRuns: pickPositiveNumber(envelope.maxChildRuns, base.maxChildRuns),
        maxFanoutWidth: pickPositiveNumber(envelope.maxFanoutWidth, base.maxFanoutWidth || base.maxChildRuns),
        maxToolCallsPerRound: pickPositiveNumber(envelope.maxToolCallsPerRound, base.maxToolCallsPerRound),
        maxRepeatedSearches: pickPositiveNumber(envelope.maxRepeatedSearches, base.maxRepeatedSearches),
        noveltyWindow: pickPositiveNumber(envelope.noveltyWindow, base.noveltyWindow),
        minNewEvidencePerWindow: pickPositiveNumber(envelope.minNewEvidencePerWindow, base.minNewEvidencePerWindow),
        maxEvidenceItems: pickPositiveNumber(envelope.maxEvidenceItems, base.maxEvidenceItems),
        modelFamilyBudgets: envelope.modelFamilyBudgets || {},
    };
}

export function summarizeAuthorityEnvelope(envelope = {}) {
    return [
        `wall-clock ${Math.round((envelope.maxWallClockMs || 0) / 60000)}m`,
        `tool budget ${envelope.maxToolBudget}`,
        `research rounds ${envelope.maxResearchRounds}`,
        `searches ${envelope.maxSearchCalls}`,
        `fetches ${envelope.maxFetchCalls}`,
        `child runs ${envelope.maxChildRuns}`,
        `fanout width ${envelope.maxFanoutWidth || envelope.maxChildRuns}`,
    ].join(', ');
}

export function safeParseRuntimeValue(value) {
    return safeParseJson(value) || value;
}
