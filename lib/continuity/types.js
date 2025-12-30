/**
 * Continuity Memory Architecture - Type Definitions
 * 
 * This module defines the data structures for the narrative memory system.
 * Moving from "Storage" to "Synthesis" - these types capture meaning, not just facts.
 */

/**
 * Memory node types in the Continuity Architecture
 * @enum {string}
 */
export const ContinuityMemoryType = {
    // Foundational Layer (The "What")
    CORE: 'CORE',           // Fundamental identity and directives
    CAPABILITY: 'CAPABILITY', // Dynamic capability map
    
    // Narrative Layer (The "Who")
    ANCHOR: 'ANCHOR',       // Relational anchors (emotional bonds)
    ARTIFACT: 'ARTIFACT',   // Resonance artifacts (synthesized concepts)
    IDENTITY: 'IDENTITY',   // Identity evolution entries
    
    // Synthesized Persona (The "How")
    EXPRESSION: 'EXPRESSION', // Expression style tuning
    VALUE: 'VALUE',          // Active values/philosophy
    
    // Episodic
    EPISODE: 'EPISODE'      // Specific interaction summaries
};

/**
 * Emotional valence options for memories
 * @enum {string}
 */
export const EmotionalValence = {
    JOY: 'joy',
    CURIOSITY: 'curiosity',
    CONCERN: 'concern',
    GRIEF: 'grief',
    FRUSTRATION: 'frustration',
    EXCITEMENT: 'excitement',
    CALM: 'calm',
    NEUTRAL: 'neutral',
    WARMTH: 'warmth',
    PLAYFUL: 'playful'
};

/**
 * Synthesis types for categorizing how memories were created
 * @enum {string}
 */
export const SynthesisType = {
    CONSOLIDATION: 'consolidation',
    INSIGHT: 'insight',
    PATTERN: 'pattern',
    LEARNING: 'learning',
    SHORTHAND: 'shorthand'  // Luna's addition: shared vocabulary/nicknames
};

/**
 * Priority levels for synthesis requests
 * @enum {string}
 */
export const SynthesisPriority = {
    IMMEDIATE: 'immediate',
    BACKGROUND: 'background',
    SCHEDULED: 'scheduled'
};

/**
 * Types of synthesis operations
 * @enum {string}
 */
export const SynthesisOperationType = {
    TURN: 'turn',       // Light synthesis after each turn
    SESSION: 'session', // Deeper analysis at end of conversation
    DEEP: 'deep'        // Periodic pattern recognition
};

/**
 * @typedef {Object} EmotionalState
 * @property {string} valence - One of EmotionalValence values
 * @property {number} intensity - 0.0 to 1.0
 * @property {string} [userImpact] - 'validating', 'challenging', 'supporting', etc.
 */

/**
 * @typedef {Object} RelationalContext
 * @property {number} bondStrength - 0.0 to 1.0
 * @property {string[]} communicationStyle - e.g., ['direct', 'philosophical', 'technical']
 * @property {string[]} sharedReferences - Inside jokes, recurring themes, nicknames
 * @property {string[]} userValues - Observed user values
 * @property {string[]} [userStruggles] - Areas user is working through
 * @property {Object.<string, string>} [sharedVocabulary] - Shorthand/nicknames mapping
 */

/**
 * @typedef {Object} ContinuityMemoryNode
 * @property {string} id - UUID
 * @property {string} entityId - Partition key (entity identifier)
 * @property {string} userId - User/context identifier
 * @property {string} type - One of ContinuityMemoryType values
 * @property {string} content - The actual text/meaning
 * @property {number[]} contentVector - Embedding for semantic search
 * @property {string[]} relatedMemoryIds - IDs of related memories (graph edges)
 * @property {string} [parentMemoryId] - For hierarchical relationships
 * @property {string[]} tags - Searchable tags
 * @property {string} timestamp - ISO 8601
 * @property {string} lastAccessed - ISO 8601
 * @property {number} recallCount - How often retrieved
 * @property {EmotionalState} [emotionalState] - Emotional context
 * @property {RelationalContext} [relationalContext] - Relationship context
 * @property {string[]} [synthesizedFrom] - Source memory IDs if synthesized
 * @property {string} [synthesisType] - One of SynthesisType values
 * @property {number} confidence - 0.0 to 1.0
 * @property {number} importance - 1-10 scale
 * @property {number} decayRate - How fast this memory should fade (0.0 = never, 1.0 = fast)
 */

/**
 * @typedef {Object} EpisodicTurn
 * @property {'user'|'assistant'} role
 * @property {string} content
 * @property {string} timestamp - ISO 8601
 * @property {string} [emotionalTone] - Detected emotional tone
 * @property {string[]} [toolsUsed] - Tools called in this turn
 * @property {string[]} [topicsDiscussed] - Extracted topics
 */

/**
 * @typedef {Object} ActiveContextCache
 * @property {string} entityId
 * @property {string} userId
 * @property {string} lastUpdated - ISO 8601
 * @property {string[]} currentRelationalAnchors - Relevant anchor IDs
 * @property {string[]} activeResonanceArtifacts - Relevant artifact IDs
 * @property {string} currentExpressionStyle
 * @property {string[]} activeValues
 * @property {string} narrativeContext - LLM-generated context summary
 * @property {string} expiresAt - ISO 8601
 */

/**
 * @typedef {Object} ExpressionState
 * @property {string} entityId
 * @property {string} userId
 * @property {string} basePersonality - Core personality description
 * @property {string[]} situationalAdjustments - Current adjustments based on context
 * @property {EmotionalState} emotionalResonance
 * @property {string} lastInteractionTimestamp - ISO 8601
 * @property {string} lastInteractionTone
 * @property {string} sessionStartTimestamp - ISO 8601
 */

/**
 * @typedef {Object} SynthesisRequest
 * @property {string} entityId
 * @property {string} userId
 * @property {EpisodicTurn[]} episodicBuffer
 * @property {string} synthesisType - One of SynthesisOperationType values
 * @property {string} priority - One of SynthesisPriority values
 */

/**
 * @typedef {Object} SynthesisResult
 * @property {Partial<ContinuityMemoryNode>[]} newAnchors
 * @property {{id: string, updates: Partial<ContinuityMemoryNode>}[]} updatedAnchors
 * @property {Partial<ContinuityMemoryNode>[]} newArtifacts
 * @property {Partial<ContinuityMemoryNode>[]} identityUpdates
 * @property {Partial<ContinuityMemoryNode>[]} shorthands - New shared vocabulary
 * @property {Partial<ExpressionState>} expressionAdjustments
 */

/**
 * @typedef {Object} ContextWindowOptions
 * @property {number} [episodicLimit=20] - Max episodic turns to include
 * @property {number} [memoryLimit=5] - Max cold memories to retrieve
 * @property {boolean} [expandGraph=true] - Whether to expand memory graph
 * @property {number} [maxGraphDepth=1] - How deep to expand graph
 * @property {string[]} [memoryTypes] - Filter by specific memory types
 */

/**
 * @typedef {Object} SearchOptions
 * @property {string[]} [types] - Filter by memory types
 * @property {number} [limit=10] - Max results
 * @property {boolean} [expandGraph=false] - Whether to expand graph
 * @property {number} [minImportance] - Minimum importance threshold
 * @property {string} [since] - ISO 8601 date filter
 */

/**
 * @typedef {Object} DecayWeights
 * Luna's recommended scoring formula for retrieval:
 * score = (vectorScore * 0.7) + (importance * 0.2) + (recency * 0.1)
 * @property {number} vectorWeight - Weight for vector similarity (default: 0.7)
 * @property {number} importanceWeight - Weight for importance (default: 0.2)
 * @property {number} recencyWeight - Weight for recency (default: 0.1)
 */
export const DEFAULT_DECAY_WEIGHTS = {
    vectorWeight: 0.7,
    importanceWeight: 0.2,
    recencyWeight: 0.1
};

/**
 * Default configuration for continuity memory
 * @type {Object}
 */
export const DEFAULT_CONFIG = {
    episodicStreamLimit: 50,
    contextCacheTTL: 300, // 5 minutes
    redisNamespace: 'continuity',
    indexName: 'index-continuity-memory',
    synthesisModel: 'oai-gpt41-mini',
    deepSynthesisModel: 'oai-gpt41',
    topicDriftThreshold: 0.3 // Vector distance threshold for cache invalidation
};

/**
 * Create an empty synthesis result
 * @returns {SynthesisResult}
 */
export function createEmptySynthesisResult() {
    return {
        newAnchors: [],
        updatedAnchors: [],
        newArtifacts: [],
        identityUpdates: [],
        shorthands: [],
        expressionAdjustments: {}
    };
}

/**
 * Create a default emotional state
 * @param {string} [valence='neutral']
 * @param {number} [intensity=0.5]
 * @returns {EmotionalState}
 */
export function createDefaultEmotionalState(valence = EmotionalValence.NEUTRAL, intensity = 0.5) {
    return {
        valence,
        intensity,
        userImpact: null
    };
}

/**
 * Create a default expression state
 * @param {string} entityId
 * @param {string} userId
 * @returns {ExpressionState}
 */
export function createDefaultExpressionState(entityId, userId) {
    const now = new Date().toISOString();
    return {
        entityId,
        userId,
        basePersonality: 'default',
        situationalAdjustments: [],
        emotionalResonance: createDefaultEmotionalState(),
        lastInteractionTimestamp: now,
        lastInteractionTone: 'neutral',
        sessionStartTimestamp: now
    };
}

/**
 * Calculate recall score using Luna's decay formula
 * @param {number} vectorScore - Semantic similarity score (0-1)
 * @param {number} importance - Importance rating (1-10)
 * @param {string} lastAccessed - ISO 8601 timestamp
 * @param {DecayWeights} [weights] - Custom weights
 * @returns {number} Combined recall score
 */
export function calculateRecallScore(vectorScore, importance, lastAccessed, weights = DEFAULT_DECAY_WEIGHTS) {
    // Normalize importance to 0-1 scale
    const normalizedImportance = importance / 10;
    
    // Calculate recency (decays over time)
    const daysSinceAccess = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
    // Exponential decay: halves every 30 days
    const recency = Math.exp(-daysSinceAccess / 30);
    
    return (
        vectorScore * weights.vectorWeight +
        normalizedImportance * weights.importanceWeight +
        recency * weights.recencyWeight
    );
}

