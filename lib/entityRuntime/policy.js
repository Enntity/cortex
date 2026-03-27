import { config } from '../../config.js';
import {
    DEFAULT_AUTHORITY_BY_ORIGIN,
    DEFAULT_ROUTING_MODEL,
    DEFAULT_RESEARCH_MODEL,
    ENTITY_RUNTIME_MODE,
} from './constants.js';

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
    const configuredPolicy = resolvedEntityConfig.modelPolicy || {};
    const systemDefaultModel = config.get('defaultModelName') || resolver.modelName || null;
    const requestPrimary = pickFirstString(args.modelOverride, args.model);
    const forcedPrimary = pickFirstString(requestPrimary, resolvedEntityConfig.modelOverride);
    const configuredPrimary = pickFirstString(
        overridePolicy.primaryModel,
        configuredPolicy.primaryModel
    );
    const preferredModel = selectAvailableModel(
        forcedPrimary,
        overridePolicy.preferredModel,
        resolvedEntityConfig.preferredModel,
        configuredPrimary,
        systemDefaultModel
    );
    const voiceModel = selectAvailableModel(
        forcedPrimary,
        configuredPrimary,
        preferredModel,
        systemDefaultModel
    );
    // Operational slots — specialised defaults lead; forcedPrimary is a last-resort
    // fallback only (via preferredModel / voiceModel already in the chain).
    const researchDefault = selectAvailableModel(
        overridePolicy.researchModel,
        configuredPolicy.researchModel,
        DEFAULT_RESEARCH_MODEL,
        systemDefaultModel,
        preferredModel,
        voiceModel
    );
    const routingDefault = selectAvailableModel(
        overridePolicy.routingModel,
        configuredPolicy.routingModel,
        DEFAULT_ROUTING_MODEL,
        researchDefault,
        systemDefaultModel,
        preferredModel,
        voiceModel
    );

    return {
        // Voice slots — forcedPrimary leads (user's model choice = entity's voice)
        orientationModel: selectAvailableModel(
            forcedPrimary,
            overridePolicy.orientationModel,
            configuredPolicy.orientationModel,
            voiceModel,
            preferredModel,
            systemDefaultModel
        ),
        // Voice slot — the initial planning call needs to understand the SetGoals
        // protocol reliably; cheap models fail the gate too often.
        planningModel: selectAvailableModel(
            forcedPrimary,
            overridePolicy.planningModel,
            configuredPolicy.planningModel,
            voiceModel,
            preferredModel,
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
        // Voice slots
        synthesisModel: selectAvailableModel(
            forcedPrimary,
            overridePolicy.synthesisModel,
            configuredPolicy.synthesisModel,
            voiceModel,
            preferredModel,
            systemDefaultModel
        ),
        verificationModel: selectAvailableModel(
            forcedPrimary,
            overridePolicy.verificationModel,
            configuredPolicy.verificationModel,
            voiceModel,
            preferredModel,
            systemDefaultModel
        ),
        // Operational slot
        compressionModel: selectAvailableModel(
            overridePolicy.compressionModel,
            configuredPolicy.compressionModel,
            researchDefault,
            systemDefaultModel,
            voiceModel
        ),
        routingModel: routingDefault,
        preferredModel,
        primaryModel: voiceModel,
        forcedPrimaryModel: forcedPrimary || null,
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
    ].join(', ');
}

export function safeParseRuntimeValue(value) {
    return safeParseJson(value) || value;
}
