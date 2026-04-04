import { v4 as uuidv4 } from 'uuid';
import { MongoClient } from 'mongodb';
import logger from '../logger.js';

const DEFAULT_RUN_COLLECTION = 'entity_runs';
const DEFAULT_EVIDENCE_COLLECTION = 'entity_run_evidence';

let instance = null;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export class MongoEntityRuntimeStore {
    constructor(options = {}) {
        this.runCollectionName = options.runCollectionName || DEFAULT_RUN_COLLECTION;
        this.evidenceCollectionName = options.evidenceCollectionName || DEFAULT_EVIDENCE_COLLECTION;
        this.connectionString = process.env.MONGO_URI || '';
        this.databaseName = options.databaseName || null;
        this._client = null;
        this._db = null;
        this._runs = null;
        this._evidence = null;
    }

    static getInstance(options = {}) {
        if (!instance) instance = new MongoEntityRuntimeStore(options);
        return instance;
    }

    isConfigured() {
        return !!this.connectionString;
    }

    async _connect() {
        if (this._runs && this._evidence) return;
        if (!this.isConfigured()) throw new Error('MongoDB not configured');

        this._client = new MongoClient(this.connectionString);
        await this._client.connect();
        this._db = this.databaseName ? this._client.db(this.databaseName) : this._client.db();
        if (!this._db.databaseName) this._db = this._client.db('cortex');
        this._runs = this._db.collection(this.runCollectionName);
        this._evidence = this._db.collection(this.evidenceCollectionName);
    }

    async createRun(run = {}) {
        await this._connect();
        const now = new Date();
        const doc = {
            id: run.id || uuidv4(),
            entityId: run.entityId,
            parentRunId: run.parentRunId || null,
            contextId: run.contextId || null,
            origin: run.origin || 'chat',
            goal: run.goal || '',
            requestedOutput: run.requestedOutput || null,
            status: run.status || 'pending',
            stage: run.stage || 'orient',
            activeFocus: run.activeFocus || [],
            openQuestions: run.openQuestions || [],
            evidenceRefs: run.evidenceRefs || [],
            childRunIds: run.childRunIds || [],
            budgetState: run.budgetState || {},
            reflection: run.reflection || '',
            stopReason: run.stopReason || null,
            lease: run.lease || null,
            conversationMode: run.conversationMode || 'chat',
            conversationModeConfidence: run.conversationModeConfidence || 'low',
            modeUpdatedAt: run.modeUpdatedAt || now.toISOString(),
            modelPolicy: run.modelPolicy || {},
            authorityEnvelope: run.authorityEnvelope || {},
            orientationPacket: run.orientationPacket || {},
            resultPreview: run.resultPreview || '',
            resultData: run.resultData || null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            stageHistory: run.stageHistory || [],
        };
        await this._runs.insertOne(doc);
        return clone(doc);
    }

    async getRun(runId) {
        await this._connect();
        const doc = await this._runs.findOne({ id: runId });
        return doc ? clone(doc) : null;
    }

    async findLatestOpenRun({ entityId, contextId = null, origin = null, statuses = ['pending', 'running', 'paused'] } = {}) {
        await this._connect();
        const query = {
            entityId,
            status: { $in: statuses },
        };
        if (contextId) query.contextId = contextId;
        if (origin) query.origin = origin;
        const doc = await this._runs.find(query).sort({ updatedAt: -1, createdAt: -1 }).limit(1).next();
        return doc ? clone(doc) : null;
    }

    async findLatestRun({ entityId, contextId = null, origin = null } = {}) {
        await this._connect();
        const query = { entityId };
        if (contextId) query.contextId = contextId;
        if (origin) query.origin = origin;
        const doc = await this._runs.find(query).sort({ updatedAt: -1, createdAt: -1 }).limit(1).next();
        return doc ? clone(doc) : null;
    }

    async updateRun(runId, patch = {}) {
        await this._connect();
        const next = { ...patch, updatedAt: new Date() };
        await this._runs.updateOne({ id: runId }, { $set: next });
        return this.getRun(runId);
    }

    async appendStageEvent(runId, stageEvent = {}) {
        await this._connect();
        const event = {
            stage: stageEvent.stage || 'unknown',
            note: stageEvent.note || '',
            at: stageEvent.at || new Date().toISOString(),
            meta: stageEvent.meta || {},
        };
        await this._runs.updateOne(
            { id: runId },
            {
                $set: { updatedAt: new Date(), stage: event.stage },
                $push: { stageHistory: event },
            }
        );
        return event;
    }

    async completeRun(runId, patch = {}) {
        await this._connect();
        await this._runs.updateOne(
            { id: runId },
            {
                $set: {
                    ...patch,
                    status: patch.status || 'completed',
                    completedAt: new Date(),
                    updatedAt: new Date(),
                },
            }
        );
        return this.getRun(runId);
    }

    async appendChildRun(parentRunId, childRunId) {
        await this._connect();
        await this._runs.updateOne(
            { id: parentRunId },
            {
                $set: { updatedAt: new Date() },
                $addToSet: { childRunIds: childRunId },
            }
        );
        return this.getRun(parentRunId);
    }

    async appendEvidence(runId, evidence = {}) {
        await this._connect();
        const doc = {
            id: evidence.id || uuidv4(),
            runId,
            entityId: evidence.entityId || null,
            toolName: evidence.toolName || null,
            family: evidence.family || 'other',
            semanticKey: evidence.semanticKey || null,
            content: evidence.content || '',
            summary: evidence.summary || '',
            snippet: evidence.snippet || '',
            metadata: evidence.metadata || {},
            createdAt: new Date(),
        };
        await this._evidence.insertOne(doc);
        await this._runs.updateOne(
            { id: runId },
            {
                $set: { updatedAt: new Date() },
                $push: { evidenceRefs: doc.id },
            }
        );
        return clone(doc);
    }

    async listEvidence(runId, { limit = 50 } = {}) {
        await this._connect();
        const docs = await this._evidence.find({ runId }).sort({ createdAt: -1 }).limit(limit).toArray();
        return docs.map(clone);
    }

    async close() {
        if (this._client) await this._client.close();
        this._client = null;
        this._db = null;
        this._runs = null;
        this._evidence = null;
    }
}

export function getEntityRuntimeStore(options = {}) {
    return MongoEntityRuntimeStore.getInstance(options);
}

export function logRuntimeStoreFallback(message) {
    logger.warn(`[entityRuntimeStore] ${message}`);
}
