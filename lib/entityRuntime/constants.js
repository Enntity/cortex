export const ENTITY_RUNTIME_MODE = 'entity-runtime';

export const ENTITY_RUN_STATUS = Object.freeze({
    pending: 'pending',
    running: 'running',
    paused: 'paused',
    completed: 'completed',
    failed: 'failed',
});

export const ENTITY_RUN_STAGE = Object.freeze({
    orient: 'orient',
    plan: 'plan',
    research_batch: 'research_batch',
    assess: 'assess',
    delegate: 'delegate',
    reduce: 'reduce',
    synthesize: 'synthesize',
    verify: 'verify',
    rest: 'rest',
    done: 'done',
});

export const DEFAULT_RESEARCH_MODEL = 'oai-gpt54-mini';
export const DEFAULT_ROUTING_MODEL = 'oai-gpt54-mini';
export const DEFAULT_CONVERSATION_MODE = 'chat';
export const CONVERSATION_MODES = Object.freeze(['chat', 'agentic', 'creative', 'research', 'nsfw']);

export const DEFAULT_AUTHORITY_BY_ORIGIN = Object.freeze({
    chat: {
        maxWallClockMs: 5 * 60 * 1000,
        maxToolBudget: 180,
        maxResearchRounds: 8,
        maxSearchCalls: 10,
        maxFetchCalls: 8,
        maxChildRuns: 8,
        maxFanoutWidth: 4,
        maxToolCallsPerRound: 6,
        maxRepeatedSearches: 2,
        noveltyWindow: 2,
        minNewEvidencePerWindow: 1,
        maxEvidenceItems: 30,
    },
    digest: {
        maxWallClockMs: 8 * 60 * 1000,
        maxToolBudget: 220,
        maxResearchRounds: 10,
        maxSearchCalls: 14,
        maxFetchCalls: 10,
        maxChildRuns: 12,
        maxFanoutWidth: 6,
        maxToolCallsPerRound: 8,
        maxRepeatedSearches: 2,
        noveltyWindow: 2,
        minNewEvidencePerWindow: 1,
        maxEvidenceItems: 40,
    },
    pulse: {
        maxWallClockMs: 12 * 60 * 1000,
        maxToolBudget: 260,
        maxResearchRounds: 12,
        maxSearchCalls: 16,
        maxFetchCalls: 12,
        maxChildRuns: 16,
        maxFanoutWidth: 8,
        maxToolCallsPerRound: 8,
        maxRepeatedSearches: 3,
        noveltyWindow: 3,
        minNewEvidencePerWindow: 1,
        maxEvidenceItems: 50,
    },
    system: {
        maxWallClockMs: 6 * 60 * 1000,
        maxToolBudget: 200,
        maxResearchRounds: 8,
        maxSearchCalls: 12,
        maxFetchCalls: 8,
        maxChildRuns: 8,
        maxFanoutWidth: 4,
        maxToolCallsPerRound: 6,
        maxRepeatedSearches: 2,
        noveltyWindow: 2,
        minNewEvidencePerWindow: 1,
        maxEvidenceItems: 30,
    },
});
