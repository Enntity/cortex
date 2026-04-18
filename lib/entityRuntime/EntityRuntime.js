import logger from '../logger.js';
import { DEFAULT_CONVERSATION_MODE, ENTITY_RUN_STAGE, ENTITY_RUN_STATUS } from './constants.js';
import { extractGoalFromArgs } from './goal.js';
import { buildOrientationPacket } from './orientation.js';
import { resolveAuthorityEnvelope, resolveEntityModelPolicy, getRuntimeOrigin, normalizeConversationMode } from './policy.js';
import { getEntityRuntimeStore, logRuntimeStoreFallback } from './store.js';

let runtimeInstance = null;

function previewResult(result = '') {
    return typeof result === 'string' ? result.slice(0, 1000) : '';
}

function buildLease({ holder = 'runtime', maxWallClockMs = 5 * 60 * 1000 } = {}) {
    const now = new Date();
    return {
        holder,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + maxWallClockMs).toISOString(),
    };
}

function extractContextId(args = {}) {
    return args.contextId
        || args.agentContext?.find(ctx => ctx?.default)?.contextId
        || args.agentContext?.[0]?.contextId
        || args.chatId
        || (args.invocationType === 'pulse' ? args.entityId : null)
        || null;
}

export class EntityRuntime {
    constructor({ store } = {}) {
        this.store = store || getEntityRuntimeStore();
    }

    async startRun({ entityConfig = {}, args = {}, resolver = {}, goal, requestedOutput, parentRunId = null } = {}) {
        const resolvedEntityConfig = entityConfig || {};
        const runtimeGoal = goal || extractGoalFromArgs(args);
        const origin = getRuntimeOrigin(args);
        const contextId = extractContextId(args);
        const modelPolicy = resolveEntityModelPolicy({ entityConfig: resolvedEntityConfig, args, resolver });
        const authorityEnvelope = resolveAuthorityEnvelope({ entityConfig: resolvedEntityConfig, args, origin });
        const orientationPacket = await buildOrientationPacket({ entityConfig: resolvedEntityConfig, args, goal: runtimeGoal });
        let conversationMode = normalizeConversationMode(args.runtimeConversationMode || DEFAULT_CONVERSATION_MODE);
        let conversationModeConfidence = 'low';
        if (this.store.isConfigured() && contextId) {
            try {
                const latestRun = await this.store.findLatestRun({
                    entityId: args.entityId || resolvedEntityConfig.id || null,
                    contextId,
                    origin,
                });
                if (latestRun?.conversationMode) {
                    conversationMode = normalizeConversationMode(latestRun.conversationMode);
                }
                if (latestRun?.conversationModeConfidence) {
                    conversationModeConfidence = String(latestRun.conversationModeConfidence).trim().toLowerCase() === 'high' ? 'high' : 'low';
                } else if (latestRun?.id) {
                    conversationModeConfidence = 'high';
                }
            } catch (error) {
                logRuntimeStoreFallback(`Failed to load previous conversation mode: ${error.message}`);
            }
        }
        const lease = buildLease({
            holder: resolver.requestId || resolver.rootRequestId || origin || 'runtime',
            maxWallClockMs: authorityEnvelope.maxWallClockMs,
        });
        const nowIso = new Date().toISOString();

        const doc = {
            entityId: args.entityId || resolvedEntityConfig.id || null,
            parentRunId,
            contextId,
            origin,
            goal: runtimeGoal,
            requestedOutput: requestedOutput || args.requestedOutput || null,
            status: ENTITY_RUN_STATUS.running,
            stage: ENTITY_RUN_STAGE.plan,
            conversationMode,
            conversationModeConfidence,
            modeUpdatedAt: nowIso,
            activeFocus: orientationPacket.currentFocus || [],
            modelPolicy,
            authorityEnvelope,
            orientationPacket,
            lease,
            budgetState: {
                toolBudgetUsed: 0,
                researchRounds: 0,
                searchCalls: 0,
                fetchCalls: 0,
                childRuns: 0,
                evidenceItems: 0,
            },
            stageHistory: [
                { stage: ENTITY_RUN_STAGE.orient, note: 'Run created', at: nowIso, meta: { origin, conversationMode, conversationModeConfidence } },
                { stage: ENTITY_RUN_STAGE.plan, note: 'Initial planning state established', at: nowIso, meta: { conversationMode, conversationModeConfidence } },
            ],
        };

        const ephemeralRun = {
            ...doc,
            id: resolver.requestId || `ephemeral-${Date.now()}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        if (!this.store.isConfigured()) {
            logRuntimeStoreFallback('MongoDB unavailable; runtime state will be request-local only');
            return ephemeralRun;
        }

        try {
            return await this.store.createRun(doc);
        } catch (error) {
            logRuntimeStoreFallback(`Failed to persist runtime state, using request-local fallback: ${error.message}`);
            return ephemeralRun;
        }
    }

    async resumeRun({ runId, entityId, contextId = null, origin = null, trigger = 'manual', resolver = {} } = {}) {
        if (!this.store.isConfigured()) return null;
        let run = null;
        try {
            run = runId
                ? await this.store.getRun(runId)
                : await this.store.findLatestOpenRun({ entityId, contextId, origin });
        } catch (error) {
            logRuntimeStoreFallback(`Failed to resume runtime state from store: ${error.message}`);
            return null;
        }
        if (!run) return null;
        const lease = buildLease({
            holder: resolver.requestId || resolver.rootRequestId || trigger || 'runtime',
            maxWallClockMs: run.authorityEnvelope?.maxWallClockMs,
        });
        await this.store.appendStageEvent(run.id, {
            stage: run.stage || ENTITY_RUN_STAGE.plan,
            note: 'Run resumed',
            meta: {
                trigger,
                conversationMode: normalizeConversationMode(run.conversationMode || DEFAULT_CONVERSATION_MODE),
                conversationModeConfidence: String(run.conversationModeConfidence || 'low').trim().toLowerCase() === 'high' ? 'high' : 'low',
            },
        });
        return this.store.updateRun(run.id, {
            status: ENTITY_RUN_STATUS.running,
            conversationMode: normalizeConversationMode(run.conversationMode || DEFAULT_CONVERSATION_MODE),
            conversationModeConfidence: String(run.conversationModeConfidence || 'low').trim().toLowerCase() === 'high' ? 'high' : 'low',
            lease,
        });
    }

    async markStage(runId, stage, note = '', meta = {}) {
        if (!runId || !this.store.isConfigured()) return null;
        return this.store.appendStageEvent(runId, { stage, note, meta });
    }

    async appendEvidence(runId, evidence = {}) {
        if (!runId || !this.store.isConfigured()) return null;
        return this.store.appendEvidence(runId, evidence);
    }

    async completeRun({ runId, result = '', stopReason = 'completed', budgetState = {}, resultData = null, conversationMode = DEFAULT_CONVERSATION_MODE, conversationModeConfidence = 'low', modeUpdatedAt = null } = {}) {
        if (!runId || !this.store.isConfigured()) return null;
        return this.store.completeRun(runId, {
            status: ENTITY_RUN_STATUS.completed,
            stage: ENTITY_RUN_STAGE.done,
            stopReason,
            budgetState,
            conversationMode: normalizeConversationMode(conversationMode),
            conversationModeConfidence: String(conversationModeConfidence || 'low').trim().toLowerCase() === 'high' ? 'high' : 'low',
            modeUpdatedAt: modeUpdatedAt || new Date().toISOString(),
            resultPreview: previewResult(result),
            resultData,
            lease: null,
        });
    }

    async failRun({ runId, error } = {}) {
        if (!runId || !this.store.isConfigured()) return null;
        logger.error(`[EntityRuntime] run ${runId} failed: ${error?.message || error}`);
        return this.store.completeRun(runId, {
            status: ENTITY_RUN_STATUS.failed,
            stage: ENTITY_RUN_STAGE.done,
            stopReason: 'failed',
            reflection: error?.message || String(error || ''),
            lease: null,
        });
    }

    async pauseRun({ runId, reason = 'paused', budgetState = {}, reflection = '', resultData = null, conversationMode = DEFAULT_CONVERSATION_MODE, conversationModeConfidence = 'low', modeUpdatedAt = null } = {}) {
        if (!runId || !this.store.isConfigured()) return null;
        return this.store.updateRun(runId, {
            status: ENTITY_RUN_STATUS.paused,
            stopReason: reason,
            stage: ENTITY_RUN_STAGE.rest,
            budgetState,
            reflection,
            conversationMode: normalizeConversationMode(conversationMode),
            conversationModeConfidence: String(conversationModeConfidence || 'low').trim().toLowerCase() === 'high' ? 'high' : 'low',
            modeUpdatedAt: modeUpdatedAt || new Date().toISOString(),
            resultData,
            lease: null,
        });
    }

    async spawnChild({ parentRunId, entityId, objective, scope = '', tools = [], budget = {}, modelPolicy = {}, outputSchema = {} } = {}) {
        if (!this.store.isConfigured()) return null;
        const child = await this.store.createRun({
            entityId,
            parentRunId,
            origin: 'delegate',
            goal: objective || '',
            requestedOutput: outputSchema,
            status: ENTITY_RUN_STATUS.pending,
            stage: ENTITY_RUN_STAGE.delegate,
            activeFocus: scope ? [scope] : [],
            authorityEnvelope: budget,
            modelPolicy,
            orientationPacket: { mission: objective || '', currentFocus: scope ? [scope] : [] },
            budgetState: { tools },
            stageHistory: [
                { stage: ENTITY_RUN_STAGE.delegate, note: 'Child run created', at: new Date().toISOString(), meta: { parentRunId } },
            ],
        });
        await this.store.appendStageEvent(parentRunId, {
            stage: ENTITY_RUN_STAGE.delegate,
            note: 'Child run scheduled',
            meta: { childRunId: child.id, objective },
        });
        await this.store.appendChildRun(parentRunId, child.id);
        return child;
    }
}

export function getEntityRuntime(options = {}) {
    if (!runtimeInstance) runtimeInstance = new EntityRuntime(options);
    return runtimeInstance;
}
