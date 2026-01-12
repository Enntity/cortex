import { getv, setvWithDoubleEncryption } from '../../../../lib/keyValueStorageClient.js';

export default {
    inputParameters: {
        contextId: ``,
        aiMemory: ``,
        section: `memoryAll`,
        contextKey: `` // Kept for backward compat, but now uses registry lookup by contextId
    },
    model: 'oai-gpt4o',
    isMutation: true, // Declaratively mark this as a Mutation
    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, aiMemory, section = 'memoryAll' } = args;

        // Validate that contextId is provided
        if (!contextId) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            let savedContext = (getv && (await getv(`${contextId}`))) || {};
            // if savedContext is not an object, set it to an empty object
            if (typeof savedContext !== 'object') {
                savedContext = {};
            }
            savedContext.memoryContext = aiMemory;
            await setvWithDoubleEncryption(`${contextId}`, savedContext, contextId);
            return aiMemory;
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryVersion'];
        const allSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryVersion'];

        // Handle single section save
        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, aiMemory, contextId);
            }
            return aiMemory;
        }

        // if the aiMemory is an empty string, set all sections to empty strings
        if (aiMemory.trim() === "") {
            for (const section of allSections) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, "", contextId);
            }
            return "";
        }
        
        // Handle multi-section save
        try {
            const memoryObject = JSON.parse(aiMemory);
            for (const section of allSections) {
                if (section in memoryObject) {
                    await setvWithDoubleEncryption(`${contextId}-${section}`, memoryObject[section], contextId);
                }
            }
        } catch {
            for (const section of allSections) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, "", contextId);
            }
            await setvWithDoubleEncryption(`${contextId}-memoryUser`, aiMemory, contextId);
        }

        return aiMemory;
    }
}