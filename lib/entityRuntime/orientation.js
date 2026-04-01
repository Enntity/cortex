import { getContinuityMemoryService } from '../continuity/index.js';

function resolveOrientationContextId(args = {}) {
    return args.contextId
        || args.agentContext?.find(ctx => ctx?.default)?.contextId
        || args.agentContext?.[0]?.contextId
        || args.chatId
        || (args.invocationType === 'pulse' ? args.entityId : null)
        || null;
}

export function extractCompassFocus(compassText = '') {
    if (!compassText || typeof compassText !== 'string') return [];
    const match = compassText.match(/Current Focus:\s*\n([\s\S]*?)(?:\n\n[A-Z][^:\n]*:|$)/);
    if (!match?.[1]) return [];
    return match[1]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2).trim())
        .filter(Boolean);
}

export async function buildOrientationPacket({ entityConfig = {}, args = {}, goal = '' } = {}) {
    const resolvedEntityConfig = entityConfig || {};
    const memoryService = getContinuityMemoryService();
    const entityId = args.entityId || resolvedEntityConfig.id;
    const userId = resolveOrientationContextId(args);
    const useMemory = resolvedEntityConfig.useMemory !== false && args.useMemory !== false;

    let internalCompass = '';
    let eidosSnapshot = null;

    if (useMemory && memoryService.isAvailable()) {
        try {
            const compass = args.invocationType === 'pulse'
                ? await memoryService.getPulseCompass(entityId)
                : await memoryService.getInternalCompass(entityId, userId || null);
            internalCompass = compass?.content || compass || '';
        } catch {
            internalCompass = '';
        }

        if (userId && memoryService.hotMemory?.isAvailable()) {
            try {
                eidosSnapshot = await memoryService.hotMemory.getEidosMetrics(entityId, userId);
            } catch {
                eidosSnapshot = null;
            }
        }
    }

    return {
        entityName: resolvedEntityConfig.name || args.aiName || entityId,
        internalCompass,
        currentFocus: extractCompassFocus(internalCompass),
        voiceProfile: resolvedEntityConfig.voice || null,
        eidosSnapshot,
        mission: goal || args.text || '',
        requestedOutput: args.requestedOutput || null,
        userContextId: userId,
        builtAt: new Date().toISOString(),
    };
}

export function summarizeOrientationPacket(packet = {}) {
    const avgAuthenticity = Array.isArray(packet.eidosSnapshot?.authenticityScores)
        && packet.eidosSnapshot.authenticityScores.length > 0
        ? Math.round(
            (packet.eidosSnapshot.authenticityScores.reduce((sum, value) => sum + value, 0)
                / packet.eidosSnapshot.authenticityScores.length) * 100
        )
        : null;
    const focus = Array.isArray(packet.currentFocus) && packet.currentFocus.length > 0
        ? packet.currentFocus.map(item => `- ${item}`).join('\n')
        : '- none';
    const eidosLine = avgAuthenticity !== null
        ? `\nEidos: authenticity ${avgAuthenticity}% over ${packet.eidosSnapshot.authenticityScores.length} turns`
        : '';
    return `Current Focus:\n${focus}${eidosLine}`;
}
