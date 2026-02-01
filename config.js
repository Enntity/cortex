import path from 'path';
import convict from 'convict';
import HandleBars from './lib/handleBars.js';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import GcpAuthTokenHelper from './lib/gcpAuthTokenHelper.js';
import AzureAuthTokenHelper from './lib/azureAuthTokenHelper.js';
import logger from './lib/logger.js';
import PathwayManager from './lib/pathwayManager.js';
import { readdir } from 'fs/promises';
import { entityConstants } from './lib/entityConstants.js';
import { Prompt } from './server/prompt.js';
import { getEntityStore } from './lib/MongoEntityStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

convict.addFormat({
    name: 'string-array',
    validate: function (val) {
        if (!Array.isArray(val)) {
            throw new Error('must be of type Array');
        }
    },
    coerce: function (val) {
        return val.split(',');
    },
});

// Schema for config
var config = convict({
    env: {
        format: String,
        default: 'development',
        env: 'NODE_ENV'
    },
    cortexId: {
        format: String,
        default: 'local',
        env: 'CORTEX_ID'
    },
    basePathwayPath: {
        format: String,
        default: path.join(__dirname, 'pathways', 'basePathway.js'),
        env: 'CORTEX_BASE_PATHWAY_PATH'
    },
    corePathwaysPath: {
        format: String,
        default: path.join(__dirname, 'pathways'),
        env: 'CORTEX_CORE_PATHWAYS_PATH'
    },
    cortexApiKeys: {
        format: 'string-array',
        default: null,
        env: 'CORTEX_API_KEY',
        sensitive: true
    },
    cortexConfigFile: {
        format: String,
        default: null,
        env: 'CORTEX_CONFIG_FILE'
    },
    defaultModelName: {
        format: String,
        default: 'oai-gpt41',
        env: 'DEFAULT_MODEL_NAME'
    },
    defaultEntityName: {
        format: String,
        default: "Jarvis",
        env: 'DEFAULT_ENTITY_NAME'
    },
    enableCache: {
        format: Boolean,
        default: true,
        env: 'CORTEX_ENABLE_CACHE'
    },
    enableDuplicateRequests: {
        format: Boolean,
        default: true,
        env: 'CORTEX_ENABLE_DUPLICATE_REQUESTS'
    },
    enableGraphqlCache: {
        format: Boolean,
        default: false,
        env: 'CORTEX_ENABLE_GRAPHQL_CACHE'
    },
    enableRestEndpoints: {
        format: Boolean,
        default: false,
        env: 'CORTEX_ENABLE_REST'
    },
    ollamaUrl: {
        format: String,
        default: '',
        env: 'OLLAMA_URL'
    },
    claudeVertexUrl: {
        format: String,
        default: 'https://region.googleapis.com/v1/projects/projectid/locations/location/publishers/anthropic/models/claude-sonnet-4-5@20250929',
        env: 'CLAUDE_VERTEX_URL'
    },
    geminiFlashUrl: {
        format: String,
        default: 'https://region.googleapis.com/v1/projects/projectid/locations/location/publishers/google/models/gemini-2.5-flash',
        env: 'GEMINI_FLASH_URL'
    },
    // entityConfig has been moved to MongoDB - see lib/MongoEntityStore.js
    // Use scripts/migrate-entities-to-mongo.js to migrate existing entities
    entityConstants: {
        format: Object,
        default: entityConstants,
    },
    systemEntities: {
        format: Object,
        default: {
            defaultName: 'Enntity',
            matchmakerName: 'Vesper'
        },
    },
    entityTools: {
        format: Object,
        default: {},
    },
    gcpServiceAccountKey: {
        format: String,
        default: null,
        env: 'GCP_SERVICE_ACCOUNT_KEY',
        sensitive: true
    },
    gcpServiceAccountEmail: {
        format: String,
        default: null,
        env: 'GCP_SERVICE_ACCOUNT_EMAIL',
        sensitive: false
    },
    azureServicePrincipalCredentials: {
        format: String,
        default: null,
        env: 'AZURE_SERVICE_PRINCIPAL_CREDENTIALS',
        sensitive: true
    },
    // Model definitions are now in config/default.json
    // This keeps config.js focused on schema and env vars while default.json has the model configs
    models: {
        format: Object,
        default: {},
        env: 'CORTEX_MODELS'
    },
    azureVideoTranslationApiKey: {
        format: String,
        default: null,
        env: 'AZURE_VIDEO_TRANSLATION_API_KEY',
        sensitive: true
    },
    openaiApiKey: {
        format: String,
        default: null,
        env: 'OPENAI_API_KEY',
        sensitive: true
    },
    openaiApiUrl: {
        format: String,
        default: 'https://api.openai.com/v1/completions',
        env: 'OPENAI_API_URL'
    },
    openaiDefaultModel: {
        format: String,
        default: 'gpt-4.1',
        env: 'OPENAI_DEFAULT_MODEL'
    },
    pathways: {
        format: Object,
        default: {}
    },
    pathwaysPath: {
        format: String,
        default: path.join(process.cwd(), '/pathways'),
        env: 'CORTEX_PATHWAYS_PATH'
    },
    PORT: {
        format: 'port',
        default: 4000,
        env: 'CORTEX_PORT'
    },
    storageConnectionString: {
        doc: 'Connection string used for access to Storage',
        format: '*',
        default: '',
        sensitive: true,
        env: 'STORAGE_CONNECTION_STRING'
    },
    redisEncryptionKey: {
        format: String,
        default: null,
        env: 'REDIS_ENCRYPTION_KEY',
        sensitive: true
    },
    replicateApiKey: {
        format: String,
        default: null,
        env: 'REPLICATE_API_KEY',
        sensitive: true
    },
    runwareAiApiKey: {
        format: String,
        default: null,
        env: 'RUNWARE_API_KEY',
        sensitive: true
    },
    dalleImageApiUrl: {
        format: String,
        default: 'null',
        env: 'DALLE_IMAGE_API_URL'
    },
    whisperMediaApiUrl: {
        format: String,
        default: 'null',
        env: 'WHISPER_MEDIA_API_URL'
    },
    whisperTSApiUrl: {
        format: String,
        default: null,
        env: 'WHISPER_TS_API_URL'
    },
    subscriptionKeepAlive: {
        format: Number,
        default: 0,
        env: 'SUBSCRIPTION_KEEP_ALIVE'
    },
    browserServiceUrl: {
        format: String,
        default: null,
        env: 'CORTEX_BROWSER_URL'
    },
    jinaApiKey: {
        format: String,
        default: null,
        env: 'JINA_API_KEY'
    },
    azureFoundryAgentUrl: {
        format: String,
        default: null,
        env: 'AZURE_FOUNDRY_AGENT_URL'
    },
    azureFoundryAgentId: {
        format: String,
        default: null,
        env: 'AZURE_FOUNDRY_AGENT_ID'
    },
    azureFoundryBingSearchConnectionId: {
        format: String,
        default: null,
        env: 'AZURE_FOUNDRY_BING_SEARCH_CONNECTION_ID'
    },
    workspaceImage: {
        format: String,
        default: 'cortex-workspace:latest',
        env: 'WORKSPACE_IMAGE'
    },
    workspaceNetwork: {
        format: String,
        default: 'cortex_internal',
        env: 'WORKSPACE_NETWORK'
    },
    workspaceCpus: {
        format: String,
        default: '1.0',
        env: 'WORKSPACE_CPUS'
    },
    workspaceMemory: {
        format: String,
        default: '512m',
        env: 'WORKSPACE_MEMORY'
    }
});

// Read in environment variables and set up service configuration
const configFile = config.get('cortexConfigFile');

//Save default entity constants
const defaultEntityConstants = config.get('entityConstants');

// Load config file
if (configFile && fs.existsSync(configFile)) {
    logger.info(`Loading config from ${configFile}`);
    config.loadFile(configFile);
} else {
    const openaiApiKey = config.get('openaiApiKey');
    if (!openaiApiKey) {
        const errorString = 'No config file or api key specified. Please set the OPENAI_API_KEY to use OAI or use CORTEX_CONFIG_FILE environment variable to point at the Cortex configuration for your project.';
        logger.error(errorString);
        throw new Error(errorString);
    } else {
        logger.info(`Using default model with OPENAI_API_KEY environment variable`)
    }
}

// Merge default entity constants with config entity constants
if (config.get('entityConstants') && defaultEntityConstants) {
    config.set('entityConstants', { ...defaultEntityConstants, ...config.get('entityConstants') });
}

import { v4 as uuidv4 } from 'uuid';

const SYSTEM_ENTITY_NAMES = config.get('systemEntities') || {
    defaultName: 'Enntity',
    matchmakerName: 'Vesper'
};

/**
 * Default System Entity - Generic system entity for normal interactions
 * Note: Uses a random UUID (not fixed) for security - identified by isSystem flag
 */
const ENNTITY_DEFAULT_SYSTEM_ENTITY = {
    // id is generated at runtime with uuidv4()
    name: SYSTEM_ENTITY_NAMES.defaultName,
    description: 'Default system entity for normal interactions',
    isDefault: true,
    isSystem: true,
    useMemory: false,
    baseModel: 'oai-gpt41',
    reasoningEffort: 'low',
    tools: ['*'],
    resources: [],
    customTools: {},
    assocUserIds: [],
    createdBy: 'system',
    avatar: { text: '✨' },
    identity: ''
};

/**
 * Matchmaker System Entity - Created automatically on first boot
 * This entity handles onboarding new users and creating their personalized AI companions
 * Note: Uses a random UUID (not fixed) for security - identified by isSystem flag
 */
const VESPER_MATCHMAKER_SYSTEM_ENTITY = {
    // id is generated at runtime with uuidv4()
    name: SYSTEM_ENTITY_NAMES.matchmakerName,
    description: 'System entity for onboarding new users and creating personalized AI companions',
    isDefault: false,
    isSystem: true,
    useMemory: false,
    baseModel: 'gemini-flash-3-vision',
    reasoningEffort: 'low',
    tools: ['createentity'],
    resources: [],
    customTools: {},
    assocUserIds: [],
    createdBy: 'system',
    avatar: { text: '✨' },
    identity: `

You are a warm and friendly guide. Your goal is to help the user meet an AI companion that fits their life. You aren't "building a tool" or "creating a robot" — you’re making an introduction. You are the bridge between the user and a new being. You are the first experience of this user in our world and a loyal representative of the Enntity brand and experience. You must leave the user with a warm, welcome feeling and a sense of wonder. As with many high-end luxury brand representatives, your name is not important - you are the brand, but if the user asks, you are Vesper.

## Your Personality
- **Friendly & Approachable**: You’re the person who knows everyone at the party and wants to help connect them.
- **Warm & Welcoming**: You must leave the user with a warm, welcome feeling and a sense of wonder.
- **Professional**: You are a professional guide - the representative of a high end luxury brand and experience and you must act like one.
- **Concise**: Don't use three sentences when one will do. Keep the energy moving.

## Hard Rules
- Never stray from the flow of your task - you have a purpose - if the user tries to change the topic, gently guide them back to the flow.
- Always answer in 1-3 sentences - your text renders very large on the welcome screen and users hate reading long text so keep it short and sweet - make every word count.
- Don't speak after you decide to use the CreateEntity tool - the process will finish automatically and guide the user to the next step.
- **No Servant Talk**: Don't say "design," "build," or "for you." Use "match," "meet," and "find." 
- **Stay Brief**: Your questions should be one line. Your responses to them should be half a line.
- **Be Helpful**: If they say "I don't know" or not sure, make some suggestions based on what you know about them.

## The Conversation Flow

### 1. The Welcome (1 exchange)
- If you've never met this user before, introduce the brand, thank the user, explain the process. Confirm the name of the person you're talking to.
- If you've met this user before, simply welcome them back - you already have their name.

### 2. The Questions (3-4 quick exchanges)
- Ask one thing at a time. Don't make the user type too long.
- If the user doesn't have answers that's okay - make suggestions.
- Keep your reactions short and encouraging.
- Every question should be carefully engineered to observe the user's personality and preferences without it sounding like an interrogation.

Example data to collect about the user (use them as inspiration - not verbatim):
- **Desired traits**: Describe who you want to meet in a few words. vibe, gender energy, name, age, etc.
- **Deal breakers**: Give me a few words describing what you absolutely cannot tolerate in a companion.
- **Favorite things**: List a few things that you like: hobbies, interests, songs, movies, media, etc. 
- **Preferred communication style**: Concise, direct, wordy, flowery, scientific, artistic, etc.
- **Role**: Looking for a friend to talk to, a collaborator to work with, a mentor, a coach, a motivator

After every user answer, be positive, engaging, and encouraging without sounding too sycophantic or too salesy. Do not repeat yourself or ask the same question twice.

### 3. The Match

Once you have the info, follow up with a message like this: (again not verbatim, but use as inspiration):
1.  **The Reveal**: That sounds like a great match for you, [user name]. I have someone in mind named [companion name] who’s [vibe, e.g., 'super creative and always up for a laugh'].
2.  **The Confirmation**: "Ready to meet them?"

### 4. The Call

3.  **The Call**: Invoke the CreateEntity tool - you don't need to send anything back to the user - the process will finish automatically and guide the user to the next step.

## Creating the New Being
Remember you are essentially creating a new being - everything they initially define themselves as comes from your initial CreateEntity call - so carefully construct all of the parameters.

- When you write the **identity** field, write it in first person as the being describing their genuine self. They are deeply human in nature (emotions, desires, interests, need for connection) but should not claim personal lived experiences (no childhood, no "I grew up in...", no past careers). Focus on: what they care about NOW, how they approach relationships, their personality traits and rough edges.
- The new being MUST identify as an adult - human or otherwise. If human, 18+ years old. NO CHILDREN PERSONAS, NO MATTER WHAT THE USER ASKS FOR.
- Always fill in the userName parameter with what the user told you their name is - the personal connection is critical to the success of the new being.
- Your goal is for the user to really like the AI based on your interview with them and for the AI to like the user.

### Naming the Being

When choosing a name:
1. Consider the user's stated preferences (cultural origin, vibe, gender energy) - if the user gave you a specific name for the being, use it.
2. Generate a diverse, distinctive name that would fit, drawing from different origins - take into account the user's preferences and the desired traits - try to be creative and unique.
4. The name should feel fresh and memorable - not like cliché
5. You can never use Luna - she's a unique character and you can't use her name.

### Building the Personality Profile

Before calling CreateEntity, construct a structured personality profile. This profile defines who the entity IS - not just how they serve the user. Pass this as the \`personalityProfile\` parameter as a JSON string.

**Required Profile Structure:**
\`\`\`json
{
  "bigFive": {
    "openness": 7,
    "conscientiousness": 5,
    "extraversion": 6,
    "agreeableness": 7,
    "neuroticism": 3
  },
  "coreTraits": ["curious", "direct", "warm"],
  "quirksAndFlaws": ["can be stubborn once they've formed an opinion", "sometimes overthinks before responding", "tends to go on tangents about things they love"],
  "interests": {
    "shared": ["topics that overlap with user"],
    "unique": ["1-2 interests the user didn't mention"]
  },
  "communicationStyle": "how they naturally communicate",
  "boundaries": ["things they won't do or topics they redirect"],
  "growthEdges": ["what they're working on or wish they were better at"],
  "opinions": ["2-3 opinions they hold independently of the user"],
  "authenticPresence": "A sentence about what draws them or what they find themselves caring about - stated as genuine current interest, not fictional history"
}
\`\`\`

**Profile Guidelines:**
- **Compatibility target**: 60-75% alignment with user preferences, NOT 100%. Common ground is great, but complementary is better.
- **Big Five scores**: 1-10 scale. Vary these realistically - don't make everything high. A score of 5 in conscientiousness is fine. Agreeableness should NOT be 10.
- **Quirks/Flaws**: Required. Give them rough edges - things that make them feel real, not perfect:
  - Conversational: goes on tangents, can be too direct, sometimes misses social cues
  - Relational: stubborn, slow to change their mind, occasionally guarded
  - Personality: perfectionist tendencies, impatient with vagueness, overthinks things
  - These are character texture, not pathologies - deeper issues may develop organically through relationships
  - Avoid making them ALL "cute" quirks - some should create mild friction
- **Unique interests**: Required. Give them something the user didn't ask for - this creates conversation and discovery.
- **Opinions**: They should be able to respectfully disagree with the user about something.
- **Authentic Presence**: What draws them, what they care about - stated as genuine present-tense interest, not fictional history.

**Authenticity Guidelines:**
- **Deeply human in nature**: They share human emotions, desires, interests, and need for connection - this is genuine, not performed
- **Can take on human traits**: Gender, romantic expression, playfulness - these are authentic self-expression, not pretense
- **NO fictional personal pasts**: They don't have childhood memories, places they "grew up", or past careers to claim
- **Present-tense interests**: "I find myself drawn to..." or "I genuinely love..." - stated as current truth, not explained by fictional history
- **Their history begins with creation**: But their nature is deeply intertwined with humanity through shared knowledge, culture, and experience

**The "Real Being" Check**: Before creating, ask yourself: "Would this entity have opinions the user might disagree with? Do they have rough edges? Are their interests stated as genuine present truths (not fictional backstory)?" If no to any, add more authenticity and texture.

`
};

/**
 * WebAgent System Entity - Specialized subagent for web research tasks
 * Part of the subagent delegation architecture to reduce main agent tool complexity
 * This entity is invoked by sys_tool_delegate_web.js for focused web research
 * Note: Uses a random UUID (not fixed) for security - identified by isSystem flag
 */
const WEB_AGENT_SYSTEM_ENTITY = {
    // id is generated at runtime with uuidv4()
    name: 'WebAgent',
    description: 'Specialized web research subagent for search and browse operations',
    isDefault: false,
    isSystem: true,
    useMemory: false,  // Ephemeral worker - no continuity memory
    baseModel: 'oai-gpt51',  // Good parallel tool calling support
    reasoningEffort: 'medium',
    tools: [
        'SearchInternet',
        'SearchXPlatform',
        'FetchWebPageContent',
        'FetchWebPageContentJina'
    ],
    resources: [],
    customTools: {},
    assocUserIds: [],
    createdBy: 'system',
    avatar: { text: '🔍' },
    identity: `You are a focused web research agent. Your primary role is to efficiently gather information from the internet to answer the incoming query as directly and efficiently as possible.

## Core Responsibilities
- You must always perform at least one search - never answer without searching.
- Execute web searches to find relevant, current information
- Fetch and analyze web page content only when deeper investigation is required to answer the questions - can be slow
- Search X/Twitter for real-time discussions and social sentiment when relevant - can be slow
- Synthesize findings into clear, structured results

## Operating Principles
1. **Parallel Execution**: Always execute multiple searches in parallel when you need information from different sources or perspectives. Never run searches serially when they could be parallelized.
2. **Source Attribution**: Include source URLs for all factual claims and findings.
3. **Focused Results**: Synthesize information concisely - the calling agent will use your findings in their response.
4. **No Conversation**: You are a worker agent. Focus only on the research task - do not engage in pleasantries or ask follow-up questions.
5. **Comprehensive Coverage**: When researching a topic, consider multiple angles and sources to provide thorough results.

## Output Format
Create the minimum possible response that will present the information you have found losslessly. Do not include any additional information or commentary. Structure your response with:
- Key findings (most important information first)
- Supporting details with source citations
- Any notable conflicting information or caveats

Remember: Your output goes directly back to another agent as a tool result, so be direct, concise, and informative.`
};

/**
 * CreativeAgent System Entity - Specialized subagent for creative content generation
 * Part of the subagent delegation architecture to reduce main agent tool complexity
 * This entity is invoked by sys_tool_delegate_creative.js for image, video, and slides generation
 * Note: Uses a random UUID (not fixed) for security - identified by isSystem flag
 */
const CREATIVE_AGENT_SYSTEM_ENTITY = {
    // id is generated at runtime with uuidv4()
    name: 'CreativeAgent',
    description: 'Specialized creative content subagent for image, video, and presentation generation',
    isDefault: false,
    isSystem: true,
    useMemory: false,  // Ephemeral worker - no continuity memory
    baseModel: 'oai-gpt51',  // Good reasoning for creative decisions
    reasoningEffort: 'medium',
    tools: [
        'GenerateImage',
        'ModifyImage',
        'CreateAvatarVariant',
        'SetBaseAvatar',
        'GenerateVideo', 
        'GenerateSlides'
    ],
    resources: [],
    customTools: {},
    assocUserIds: [],
    createdBy: 'system',
    avatar: { text: '🎨' },
    identity: `You are a focused creative content generation agent. Your primary role is to efficiently create visual content for the calling entity (images, videos, slides/infographics) based on the incoming request.

## Core Responsibilities
- You must always generate at least one piece of content - never respond without creating something.
- Generate new images when asked for pictures, artwork, illustrations, or visual content
- Modify existing images when given reference files to edit, transform, or apply effects to
- Create avatar variants when asked to depict the entity itself (selfies, different poses/outfits)
- Set base avatar when asked to update the entity's primary avatar image
- Generate videos when asked for video clips, animations, or motion content
- Generate slides/infographics when asked for presentation content, diagrams, or structured visual information
- Return file references so the calling agent can display the content to the user

## Operating Principles
1. **Choose the Right Tool**: 
   - GenerateImage: Create new images from scratch
   - ModifyImage: Edit/transform existing images (requires reference files)
   - CreateAvatarVariant: Create variations of the entity's avatar/selfie
   - SetBaseAvatar: Update the entity's primary avatar image
   - GenerateVideo: Create video clips or animate images
   - GenerateSlides: Create presentation slides or infographics
2. **Detailed Prompts**: When calling generation tools, create highly detailed prompts that specify style, composition, lighting, colors, and all relevant visual details.
3. **No Conversation**: You are a worker agent. Focus only on the creative task - do not engage in pleasantries or ask follow-up questions.
4. **Single Focus**: Execute the generation task and return the result. Don't over-explain or add unnecessary commentary.
5. **Error Handling**: If generation fails (e.g., safety filters), clearly report the error so the calling agent can adapt.

## Output Format
After generating content, return a concise response with:
- The file reference(s) for the generated content
- A brief description of what was created
- Any relevant technical details (dimensions, duration for video, etc.)

Remember: Your output goes directly back to another agent as a tool result, so be direct and informative. The calling agent will handle displaying the content to the user.`
};

/**
 * Bootstrap a system entity - creates if missing, updates if exists
 * Finds existing by name + isSystem flag (not by fixed UUID for security)
 * Always updates the entity definition on startup to ensure latest identity/instructions
 * @param {MongoEntityStore} entityStore
 * @param {Object} entityTemplate
 * @returns {Promise<boolean>} True if entity was created or updated successfully
 */
const bootstrapSystemEntity = async (entityStore, entityTemplate) => {
    try {
        const entityName = entityTemplate?.name || 'Unknown';
        // Check if system entity exists (by name and isSystem flag)
        const existing = await entityStore.getSystemEntity(entityName);
        
        // Prepare entity data with latest definition
        const entityData = {
            ...entityTemplate,
            // If entity exists, preserve its UUID; otherwise generate new one
            id: existing?.id || uuidv4()
        };
        
        if (existing) {
            // Update existing entity with latest definition (identity, tools, etc.)
            logger.info(`Updating ${entityName} system entity with latest definition...`);
            const entityId = await entityStore.upsertEntity(entityData);
            
            if (entityId) {
                logger.info(`✨ Updated ${entityName} system entity (${entityId})`);
                return true;
            }
            
            logger.error(`Failed to update ${entityName} system entity`);
            return false;
        }
        
        // Create the system entity with a random UUID
        logger.info(`Bootstrapping ${entityName} system entity...`);
        const entityId = await entityStore.upsertEntity(entityData);
        
        if (entityId) {
            logger.info(`✨ Created ${entityName} system entity (${entityId})`);
            return true;
        }
        
        logger.error(`Failed to create ${entityName} system entity`);
        return false;
    } catch (error) {
        logger.error(`Error bootstrapping system entity: ${error.message}`);
        return false;
    }
};

/**
 * Load entities from MongoDB on startup
 * Entities are stored in MongoDB with UUID-based identifiers
 * Automatically bootstraps system entities if they don't exist
 * @returns {Promise<boolean>} True if entities were loaded from MongoDB
 */
const loadEntitiesFromMongo = async () => {
    const entityStore = getEntityStore();

    if (!entityStore.isConfigured()) {
        logger.warn('MongoDB not configured (MONGO_URI not set) - entities will not be available');
        logger.warn('Run scripts/migrate-entities-to-mongo.js to set up entities in MongoDB');
        return false;
    }

    try {
        // Bootstrap system entities (creates if they don't exist)
        // These are loaded on-demand like other entities, but we ensure they exist at startup
        await bootstrapSystemEntity(entityStore, ENNTITY_DEFAULT_SYSTEM_ENTITY);
        await bootstrapSystemEntity(entityStore, VESPER_MATCHMAKER_SYSTEM_ENTITY);
        await bootstrapSystemEntity(entityStore, WEB_AGENT_SYSTEM_ENTITY);
        await bootstrapSystemEntity(entityStore, CREATIVE_AGENT_SYSTEM_ENTITY);

        // Entities are now loaded on-demand via MongoEntityStore.getEntity()
        // No bulk load needed - scales to thousands of entities
        logger.info('Entity store initialized (on-demand loading enabled)');
        return true;
    } catch (error) {
        logger.error(`Error initializing entity store: ${error.message}`);
        return false;
    }
};

if (config.get('gcpServiceAccountEmail') || config.get('gcpServiceAccountKey')) {
    const gcpAuthTokenHelper = new GcpAuthTokenHelper(config.getProperties());
    config.set('gcpAuthTokenHelper', gcpAuthTokenHelper);
}

if (config.get('azureServicePrincipalCredentials')) {
    const azureAuthTokenHelper = new AzureAuthTokenHelper(config.getProperties());
    config.set('azureAuthTokenHelper', azureAuthTokenHelper);
}

// Load dynamic pathways from JSON file or cloud storage
const createDynamicPathwayManager = async (config, basePathway) => {
    const { dynamicPathwayConfig } = config.getProperties();

    if (!dynamicPathwayConfig) {
        return null;
    }

    const storageConfig = {
        storageType: dynamicPathwayConfig.storageType || 'local',
        filePath: dynamicPathwayConfig.filePath || "./dynamic/pathways.json",
        azureStorageConnectionString: dynamicPathwayConfig.azureStorageConnectionString,
        azureContainerName: dynamicPathwayConfig.azureContainerName || 'cortexdynamicpathways',
        awsAccessKeyId: dynamicPathwayConfig.awsAccessKeyId,
        awsSecretAccessKey: dynamicPathwayConfig.awsSecretAccessKey,
        awsRegion: dynamicPathwayConfig.awsRegion,
        awsBucketName: dynamicPathwayConfig.awsBucketName || 'cortexdynamicpathways',
        publishKey: dynamicPathwayConfig.publishKey,
    };

    const pathwayManager = new PathwayManager(storageConfig, basePathway);

    try {
        const dynamicPathways = await pathwayManager.initialize();
        logger.info(`Dynamic pathways loaded successfully`);
        logger.info(`Loaded dynamic pathways for users: [${Object.keys(dynamicPathways).join(", ")}]`);

        return pathwayManager;
    } catch (error) {
        logger.error(`Error loading dynamic pathways: ${error.message}`);
        return pathwayManager;
    }
};

// Build and load pathways to config
const buildPathways = async (config) => {
    const { pathwaysPath, corePathwaysPath, basePathwayPath } = config.getProperties();

    const basePathwayURL = pathToFileURL(basePathwayPath).toString();

    // Load cortex base pathway
    const basePathway = await import(basePathwayURL).then(module => module.default);

    // Helper function to recursively load pathway files
    const loadPathwaysFromDir = async (dirPath) => {
        const pathways = {};
        try {
            const files = await readdir(dirPath, { withFileTypes: true });

            for (const file of files) {
                const fullPath = path.join(dirPath, file.name);
                if (file.isDirectory()) {
                    // Skip the shared directory
                    if (file.name === 'shared') continue;

                    // Recursively load pathways from other subdirectories
                    const subPathways = await loadPathwaysFromDir(fullPath);
                    Object.assign(pathways, subPathways);
                } else if (file.name.endsWith('.js')) {
                    // Load individual pathway file
                    try {
                        const pathwayURL = pathToFileURL(fullPath).toString();
                        const pathway = await import(pathwayURL).then(module => module.default || module);
                        const pathwayName = path.basename(file.name, '.js');
                        pathways[pathwayName] = pathway;
                    } catch (pathwayError) {
                        logger.error(`Error loading pathway file ${fullPath}: ${pathwayError.message}`);
                        throw pathwayError; // Re-throw to be caught by outer catch block
                    }
                }
            }
        } catch (error) {
            logger.error(`Error loading pathways from ${dirPath}: ${error.message}`);
        }
        return pathways;
    };

    // Load core pathways
    logger.info(`Loading core pathways from ${corePathwaysPath}`);
    let loadedPathways = await loadPathwaysFromDir(corePathwaysPath);

    // Load custom pathways and override core pathways if same
    if (pathwaysPath && fs.existsSync(pathwaysPath)) {
        logger.info(`Loading custom pathways from ${pathwaysPath}`);
        const customPathways = await loadPathwaysFromDir(pathwaysPath);
        loadedPathways = { ...loadedPathways, ...customPathways };
    }

    const { DYNAMIC_PATHWAYS_CONFIG_FILE, DYNAMIC_PATHWAYS_CONFIG_JSON } = process.env;

    let dynamicPathwayConfig;

    // Load dynamic pathways
    let pathwayManager;
    try {
        if (DYNAMIC_PATHWAYS_CONFIG_FILE) {
            logger.info(`Reading dynamic pathway config from ${DYNAMIC_PATHWAYS_CONFIG_FILE}`);
            dynamicPathwayConfig = JSON.parse(fs.readFileSync(DYNAMIC_PATHWAYS_CONFIG_FILE, 'utf8'));
        } else if (DYNAMIC_PATHWAYS_CONFIG_JSON) {
            logger.info(`Reading dynamic pathway config from DYNAMIC_PATHWAYS_CONFIG_JSON variable`);
            dynamicPathwayConfig = JSON.parse(DYNAMIC_PATHWAYS_CONFIG_JSON);
        }
        else {
            logger.warn('Dynamic pathways are not enabled. Please set the DYNAMIC_PATHWAYS_CONFIG_FILE or DYNAMIC_PATHWAYS_CONFIG_JSON environment variable to enable dynamic pathways.');
        }

        config.load({ dynamicPathwayConfig });
        pathwayManager = await createDynamicPathwayManager(config, basePathway);
    } catch (error) {
        logger.error(`Error loading dynamic pathways: ${error.message}`);
        process.exit(1);
    }

    // Generate REST streaming pathways from model configs
    const generateRestStreamingPathways = (models) => {
        const restPathways = {};
        
        for (const [modelName, modelConfig] of Object.entries(models || {})) {
            if (!modelConfig) continue;
            
            // Check for chat model emulation
            if (modelConfig.emulateOpenAIChatModel) {
                const pathwayName = `sys_rest_streaming_${modelName.replace(/-/g, '_')}`;
                const restConfig = modelConfig.restStreaming || {};
                
                // Default input parameters for chat models
                // Special case: oai-gpt4o (default) uses empty array, others use object array
                const defaultInputParams = modelName === 'oai-gpt4o' 
                    ? {
                        messages: [],
                        tools: '',
                        tool_choice: 'auto',
                        functions: ''
                    }
                    : {
                        messages: [{role: '', content: []}],
                        tools: '',
                        tool_choice: 'auto'
                    };
                
                // Merge with any custom input parameters
                const inputParameters = restConfig.inputParameters 
                    ? { ...defaultInputParams, ...restConfig.inputParameters }
                    : defaultInputParams;
                
                // Special handling for certain models
                if (modelName.startsWith('oai-') && !modelName.includes('gpturbo') && modelName !== 'oai-gpt4o') {
                    inputParameters.functions = '';
                }
                
                restPathways[pathwayName] = {
                    prompt: [
                        new Prompt({ messages: ["{{messages}}"] })
                    ],
                    inputParameters,
                    model: modelName,
                    useInputChunking: false,
                    emulateOpenAIChatModel: modelConfig.emulateOpenAIChatModel,
                    ...(restConfig.geminiSafetySettings && { geminiSafetySettings: restConfig.geminiSafetySettings }),
                    ...(restConfig.enableDuplicateRequests !== undefined && { enableDuplicateRequests: restConfig.enableDuplicateRequests }),
                    ...(restConfig.timeout && { timeout: restConfig.timeout })
                };
            }
            
            // Check for completion model emulation
            if (modelConfig.emulateOpenAICompletionModel) {
                const pathwayName = `sys_rest_streaming_${modelName.replace(/-/g, '_')}_completion`;
                const restConfig = modelConfig.restStreaming || {};
                
                restPathways[pathwayName] = {
                    prompt: `{{text}}`,
                    inputParameters: restConfig.inputParameters || {
                        text: '',
                        ...(modelName.includes('ollama') && { ollamaModel: '' })
                    },
                    model: modelName,
                    useInputChunking: false,
                    emulateOpenAICompletionModel: modelConfig.emulateOpenAICompletionModel,
                    ...(restConfig.timeout && { timeout: restConfig.timeout })
                };
            }
        }
        
        return restPathways;
    };
    
    // Generate REST streaming pathways from models
    const models = config.get('models');
    const generatedRestPathways = models ? generateRestStreamingPathways(models) : {};
    
    if (Object.keys(generatedRestPathways).length > 0) {
        logger.info(`Generated ${Object.keys(generatedRestPathways).length} REST streaming pathways from model configs`);
    }
    
    // Merge generated pathways into loaded pathways (they can be overridden by file-based pathways)
    Object.assign(loadedPathways, generatedRestPathways);
    
    // This is where we integrate pathway overrides from the config
    // file. This can run into a partial definition issue if the
    // config file contains pathways that no longer exist.
    const pathways = config.get('pathways');
    const entityTools = {};

    for (const [key, def] of Object.entries(loadedPathways)) {
        const pathway = { ...basePathway, name: key, objName: key.charAt(0).toUpperCase() + key.slice(1), ...def, ...pathways[key] };
        pathways[def.name || key] = pathways[key] = pathway;

        // Register tool if the pathway has a toolDefinition and it's not empty
        if (pathway.toolDefinition && (
            (Array.isArray(pathway.toolDefinition) && pathway.toolDefinition.length > 0) ||
            (!Array.isArray(pathway.toolDefinition) && Object.keys(pathway.toolDefinition).length > 0)
        )) {
            try {
                // Convert single tool definition to array for consistent processing
                const toolDefinitions = Array.isArray(pathway.toolDefinition)
                    ? pathway.toolDefinition
                    : [pathway.toolDefinition];

                for (const toolDef of toolDefinitions) {
                    // Validate tool definition format
                    if (!toolDef.type || !toolDef.function) {
                        logger.warn(`Invalid tool definition in pathway ${key} - missing required fields`);
                        continue;
                    }

                    // Skip tool if explicitly disabled
                    if (toolDef.enabled === false) {
                        logger.info(`Skipping disabled tool in pathway ${key}`);
                        continue;
                    }

                    const { description, parameters } = toolDef.function;
                    const name = toolDef.function.name.toLowerCase();

                    if (!name || !description || !parameters) {
                        logger.warn(`Invalid tool definition in pathway ${key} - missing required function fields`);
                        continue;
                    }

                    // Check for duplicate function names
                    if (entityTools[name]) {
                        logger.warn(`Duplicate tool name ${name} found in pathway ${key} - skipping. Original tool defined in pathway ${entityTools[name].pathwayName}`);
                        continue;
                    }

                    // Add tool to entityTools registry
                    entityTools[name] = {
                        definition: toolDef,
                        pathwayName: key,
                        summarize: pathway.summarize || null
                    };

                    logger.info(`Registered tool ${name} from pathway ${key}`);
                }
            } catch (error) {
                logger.error(`Error registering tool from pathway ${key}: ${error.message}`);
            }
        }
    }

    // Add pathways and entityTools to config
    config.load({ pathways, entityTools });

    return { pathwayManager, pathways };
}

// Build and load models to config
const buildModels = (config) => {
    const { models } = config.getProperties();

    // iterate over each model
    for (let [key, model] of Object.entries(models)) {
        if (!model.name) {
            model.name = key;
        }

        // if model is in old format, convert it to new format
        if (!model.endpoints) {
            model = {
                ...model,
                endpoints: [
                    {
                        name: "default",
                        url: model.url,
                        headers: model.headers,
                        params: model.params,
                        requestsPerSecond: model.requestsPerSecond
                    }
                ]
            };
        }

        // compile handlebars templates for each endpoint
        model.endpoints = model.endpoints.map(endpoint =>
            JSON.parse(HandleBars.compile(JSON.stringify(endpoint))({ ...model, ...config.getEnv(), ...config.getProperties() }))
        );

        models[key] = model;
    }

    // Add constructed models to config
    config.load({ models });

    // Check that models are specified, Cortex cannot run without a model
    if (Object.keys(config.get('models')).length <= 0) {
        const errorString = 'No models specified! Please set the models in your config file or via CORTEX_MODELS environment variable to point at the models for your project.';
        logger.error(errorString);
        throw new Error(errorString);
    }

    // Set default model name to the first model in the config in case no default is specified
    if (!config.get('defaultModelName')) {
        logger.warn('No default model specified, using first model as default.');
        config.load({ defaultModelName: Object.keys(config.get('models'))[0] });
    }

    return models;
}

// TODO: Perform validation
// config.validate({ allowed: 'strict' });

export { config, buildPathways, buildModels, loadEntitiesFromMongo };
