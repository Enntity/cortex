import logger from '../../../lib/logger.js';
import { getEntityRuntime, ENTITY_RUNTIME_MODE } from '../../../lib/entityRuntime/index.js';
import { logEvent } from '../../../lib/requestLogger.js';
import { loadEntityConfig } from './tools/shared/sys_entity_tools.js';
import { executeEntityAgentCore, toolCallbackCore } from './sys_entity_executor.js';

function extractGoal(args = {}) {
    if (typeof args.text === 'string' && args.text.trim()) return args.text.trim();
    const lastUser = [...(args.chatHistory || [])].reverse().find(msg => msg.role === 'user');
    if (typeof lastUser?.content === 'string' && lastUser.content.trim()) return lastUser.content.trim();
    if (Array.isArray(lastUser?.content)) {
        const textPart = lastUser.content.find(part => typeof part === 'string' || part?.type === 'text');
        if (typeof textPart === 'string') return textPart.trim();
        if (textPart?.text) return textPart.text.trim();
    }
    return '';
}

function extractContextId(args = {}) {
    return args.contextId
        || args.agentContext?.find(ctx => ctx?.default)?.contextId
        || args.agentContext?.[0]?.contextId
        || args.chatId
        || (args.invocationType === 'pulse' ? args.entityId : null)
        || null;
}

export default {
    prompt: [],
    emulateOpenAIChatModel: 'cortex-agent-runtime',
    useInputChunking: false,
    enableDuplicateRequests: false,
    toolCallback: toolCallbackCore,
    inputParameters: {
        privateData: false,
        chatHistory: [{ role: '', content: [] }],
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
        runtimeAction: 'start',
        runId: '',
        trigger: '',
        requestedOutput: '',
        authorityEnvelope: undefined,
        modelPolicy: undefined,
        parentRunId: '',
        styleNeutralizationProfile: undefined,
        styleNeutralizationPatch: '',
        styleNeutralizationText: '',
    },
    timeout: 600,

    executePathway: async ({ args, resolver, runAllPrompts }) => {
        const runtime = getEntityRuntime();
        const entityConfig = await loadEntityConfig(args.entityId);
        const runtimeOrigin = args.invocationType || 'chat';
        const runtimeAction = args.runtimeAction || (args.runId || runtimeOrigin === 'pulse' ? 'resume' : 'start');
        const goal = extractGoal(args);
        const rid = resolver.rootRequestId || resolver.requestId;

        let run = null;
        if (runtimeAction === 'resume') {
            run = await runtime.resumeRun({
                runId: args.runId,
                entityId: args.entityId || entityConfig?.id,
                contextId: extractContextId(args),
                origin: runtimeOrigin,
                trigger: args.trigger || 'manual',
                resolver,
            });
        }

        if (!run) {
            run = await runtime.startRun({
                entityConfig,
                args: {
                    ...args,
                    runtimeOrigin,
                },
                resolver,
                goal,
                requestedOutput: args.requestedOutput,
                parentRunId: args.parentRunId || null,
            });
        }

        try {
            await runtime.markStage(run.id, 'plan', 'Runtime run activated', {
                runtimeAction,
                model: run.modelPolicy?.planningModel || run.modelPolicy?.primaryModel || args.model || null,
            });
            logEvent(rid, 'runtime.stage', {
                runId: run.id,
                stage: 'plan',
                model: run.modelPolicy?.planningModel || run.modelPolicy?.primaryModel || args.model || null,
                stopReason: run.stopReason || null,
                budgetState: run.budgetState || {},
            });

            await runtime.markStage(run.id, 'research_batch', 'Runtime entered shared entity executor', {
                runtimeAction,
                model: run.modelPolicy?.researchModel || run.modelPolicy?.planningModel || null,
            });
            logEvent(rid, 'runtime.stage', {
                runId: run.id,
                stage: 'research_batch',
                model: run.modelPolicy?.researchModel || run.modelPolicy?.planningModel || null,
                stopReason: run.stopReason || null,
                budgetState: run.budgetState || {},
            });

            resolver.entityRuntimeRunId = run.id;
            const runtimeArgs = {
                ...args,
                runtimeMode: ENTITY_RUNTIME_MODE,
                runtimeRunId: run.id,
                runtimeStage: 'research_batch',
                runtimeOrigin: run.origin,
                runGoal: run.goal,
                runtimeConversationMode: run.conversationMode,
                runtimeConversationModeConfidence: run.conversationModeConfidence,
                requestedOutput: run.requestedOutput,
                authorityEnvelope: run.authorityEnvelope,
                modelPolicy: run.modelPolicy,
                runtimeOrientationPacket: run.orientationPacket,
            };

            return await executeEntityAgentCore({
                args: runtimeArgs,
                runAllPrompts,
                resolver,
                toolCallbackOverride: toolCallbackCore,
            });
        } catch (error) {
            logger.error(`[sys_entity_runtime] ${error.message}`);
            await runtime.failRun({ runId: run.id, error });
            throw error;
        }
    },
};
