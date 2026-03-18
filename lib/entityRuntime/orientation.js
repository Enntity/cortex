import { getContinuityMemoryService } from '../continuity/index.js';

function getPrimaryUserContext(agentContext = []) {
    return agentContext.find(ctx => ctx?.contextId)?.contextId || null;
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
    const userId = getPrimaryUserContext(args.agentContext || []);
    const useMemory = resolvedEntityConfig.useMemory !== false && args.useMemory !== false;

    let continuityContext = '';
    let internalCompass = '';
    let eidosSnapshot = null;

    if (useMemory && memoryService.isAvailable()) {
        if (userId) {
            try {
                continuityContext = await memoryService.getContextWindow({
                    entityId,
                    userId,
                    options: { episodicLimit: 10, topicMemoryLimit: 5 },
                });
            } catch {
                continuityContext = '';
            }
        }

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
        identity: resolvedEntityConfig.identity || resolvedEntityConfig.instructions || '',
        continuityContext,
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
    return `Goal: ${packet.mission || 'No goal provided'}\nCurrent Focus:\n${focus}${eidosLine}`;
}
