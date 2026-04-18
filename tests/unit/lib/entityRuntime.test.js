import test from 'ava';
import { EntityRuntime } from '../../../lib/entityRuntime/EntityRuntime.js';

test('EntityRuntime.startRun builds an ephemeral durable run shape when storage is unavailable', async t => {
    const runtime = new EntityRuntime({
        store: {
            isConfigured() {
                return false;
            },
        },
    });

    const run = await runtime.startRun({
        entityConfig: {
            id: 'entity-1',
            name: 'Jinx',
            modelPolicy: {
                primaryModel: 'voice-model',
            },
        },
        args: {
            entityId: 'entity-1',
            text: 'Write the report',
            invocationType: 'chat',
        },
        resolver: {
            requestId: 'req-1',
            modelName: 'system-model',
        },
    });

    t.is(run.entityId, 'entity-1');
    t.is(run.goal, 'Write the report');
    t.is(run.stage, 'plan');
    t.is(run.status, 'running');
    t.truthy(run.lease?.holder);
    t.true(Array.isArray(run.stageHistory));
    t.is(run.stageHistory[0]?.stage, 'orient');
    t.is(run.orientationPacket?.mission, 'Write the report');
});

test('EntityRuntime.startRun extracts a plain-text goal from structured chat history', async t => {
    const runtime = new EntityRuntime({
        store: {
            isConfigured() {
                return false;
            },
        },
    });

    const run = await runtime.startRun({
        entityConfig: {
            id: 'entity-1',
            name: 'Jinx',
            modelPolicy: {
                primaryModel: 'voice-model',
            },
        },
        args: {
            entityId: 'entity-1',
            invocationType: 'chat',
            chatHistory: [
                { role: 'assistant', content: 'Previous turn' },
                {
                    role: 'user',
                    content: [
                        JSON.stringify({
                            type: 'text',
                            text: 'Check the report status',
                        }),
                    ],
                },
            ],
        },
        resolver: {
            requestId: 'req-structured-1',
            modelName: 'system-model',
        },
    });

    t.is(run.goal, 'Check the report status');
    t.is(run.orientationPacket?.mission, 'Check the report status');
});

test('EntityRuntime.resumeRun can recover the latest open run by entity and origin', async t => {
    const stageEvents = [];
    const updates = [];
    const storedRun = {
        id: 'run-123',
        entityId: 'entity-1',
        origin: 'pulse',
        stage: 'rest',
        authorityEnvelope: {
            maxWallClockMs: 60000,
        },
    };

    const runtime = new EntityRuntime({
        store: {
            isConfigured() {
                return true;
            },
            async findLatestOpenRun({ entityId, origin }) {
                t.is(entityId, 'entity-1');
                t.is(origin, 'pulse');
                return storedRun;
            },
            async appendStageEvent(runId, event) {
                stageEvents.push({ runId, event });
                return event;
            },
            async updateRun(runId, patch) {
                updates.push({ runId, patch });
                return {
                    ...storedRun,
                    ...patch,
                };
            },
        },
    });

    const resumed = await runtime.resumeRun({
        entityId: 'entity-1',
        origin: 'pulse',
        trigger: 'wake',
        resolver: {
            requestId: 'req-2',
        },
    });

    t.is(resumed.id, 'run-123');
    t.is(resumed.status, 'running');
    t.is(stageEvents.length, 1);
    t.is(stageEvents[0].runId, 'run-123');
    t.is(stageEvents[0].event.note, 'Run resumed');
    t.is(updates.length, 1);
    t.is(updates[0].runId, 'run-123');
    t.truthy(resumed.lease?.expiresAt);
});

test('EntityRuntime.startRun does not hydrate sticky mode from storage without a context id', async t => {
    let latestRunLookups = 0;
    const runtime = new EntityRuntime({
        store: {
            isConfigured() {
                return true;
            },
            async findLatestRun() {
                latestRunLookups += 1;
                return {
                    id: 'run-older',
                    conversationMode: 'nsfw',
                    conversationModeConfidence: 'high',
                };
            },
            async createRun(doc) {
                return { ...doc, id: 'run-1' };
            },
        },
    });

    const run = await runtime.startRun({
        entityConfig: {
            id: 'entity-1',
            modelPolicy: {
                primaryModel: 'voice-model',
            },
        },
        args: {
            entityId: 'entity-1',
            text: 'Hello there',
            invocationType: 'chat',
        },
        resolver: {
            requestId: 'req-3',
            modelName: 'system-model',
        },
    });

    t.is(latestRunLookups, 0);
    t.is(run.conversationMode, 'chat');
    t.is(run.conversationModeConfidence, 'low');
    t.is(run.contextId, null);
});
