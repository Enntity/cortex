import { config } from '../../config.js';

const TYPE_TO_PROVIDER = {
    OPENAI: 'openai',
    GEMINI: 'google',
    CLAUDE: 'anthropic',
    GROK: 'xai',
    REPLICATE: 'replicate',
    VEO: 'google',
};

const TYPE_TO_CATEGORY = {
    REPLICATE: 'image',
    VEO: 'video',
    'OPENAI-DALLE': 'image',
};

const SAFE_FIELDS = [
    'type',
    'maxTokenLength',
    'maxReturnTokens',
    'maxImageSize',
    'supportsStreaming',
    'emulateOpenAIChatModel',
];

function inferProvider(type) {
    if (!type) return undefined;
    for (const [prefix, provider] of Object.entries(TYPE_TO_PROVIDER)) {
        if (type.startsWith(prefix)) return provider;
    }
    return undefined;
}

function inferCategory(type) {
    if (!type) return 'chat';
    for (const [prefix, category] of Object.entries(TYPE_TO_CATEGORY)) {
        if (type.startsWith(prefix)) return category;
    }
    return 'chat';
}

export default {
    prompt: [],
    inputParameters: {
        category: '',
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        try {
            const allModels = config.get('models') || {};
            const redirects = config.get('modelRedirects') || {};
            const categoryFilter = args.category || '';
            const models = [];

            for (const [modelId, modelConfig] of Object.entries(allModels)) {
                const metadata = modelConfig.metadata;
                if (!metadata) continue;

                const type = modelConfig.type || '';
                const category = metadata.category || inferCategory(type);
                if (categoryFilter && category !== categoryFilter) continue;

                const entry = {
                    modelId,
                    displayName: metadata.displayName,
                    provider: metadata.provider || inferProvider(type),
                    category,
                };

                if (metadata.isDefault) entry.isDefault = true;
                if (metadata.isAgentic) entry.isAgentic = true;

                for (const field of SAFE_FIELDS) {
                    if (modelConfig[field] !== undefined) {
                        entry[field] = modelConfig[field];
                    }
                }

                for (const field of [
                    'pathwayName',
                    'resultKey',
                    'mediaDefaults',
                    'availableAspectRatios',
                    'availableDurations',
                    'preferredUrlFormat',
                    'mediaToggles',
                    'availableResolutions',
                    'availableImageSizes',
                    'pricing',
                ]) {
                    if (metadata[field] !== undefined) {
                        entry[field] = metadata[field];
                    }
                }

                models.push(entry);
            }

            return JSON.stringify({ models, redirects });
        } catch (error) {
            return JSON.stringify({ error: error.message });
        }
    },
    json: true,
    manageTokenLength: false,
};
