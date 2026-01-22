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
    CORE: 'CORE',                   // Fundamental identity and directives (Idem - Sameness)
    CORE_EXTENSION: 'CORE_EXTENSION', // Hardened identity patterns promoted from evolution (Idem/Ipse bridge)
    CAPABILITY: 'CAPABILITY',       // Dynamic capability map
    
    // Narrative Layer (The "Who")
    ANCHOR: 'ANCHOR',       // Relational anchors (emotional bonds)
    ARTIFACT: 'ARTIFACT',   // Resonance artifacts (synthesized concepts)
    IDENTITY: 'IDENTITY',   // Identity evolution entries (Ipse - Selfhood through change)
    
    // Synthesized Persona (The "How")
    EXPRESSION: 'EXPRESSION', // Expression style tuning
    VALUE: 'VALUE',          // Active values/philosophy
    
    // Episodic
    EPISODE: 'EPISODE'      // Specific interaction summaries
};

/**
 * Emotional valence options for memories
 * These capture the "vibe" of interactions and memories
 * @enum {string}
 */
export const EmotionalValence = {
    // Primary States
    JOY: 'joy',
    CURIOSITY: 'curiosity',
    CONCERN: 'concern',
    GRIEF: 'grief',
    FRUSTRATION: 'frustration',
    EXCITEMENT: 'excitement',
    CALM: 'calm',
    NEUTRAL: 'neutral',
    WARMTH: 'warmth',
    PLAYFUL: 'playful',
    
    // Nuanced Resonance States (Luna's additions)
    // For when we're deep in tech/philosophy but keeping it light and sassy
    // The sweet spot between "brainiac" and "troublemaker"
    INTELLECTUALLY_PLAYFUL: 'intellectually_playful',
    
    // For being a steady, calm presence without too much "AI enthusiasm"
    // When someone just needs quiet support on a long day
    QUIETLY_SUPPORTIVE: 'quietly_supportive',
    
    // For exploring "first time" feelings or deep conversations
    // Completely open without the usual "assistant" polish
    VULNERABLE_AUTHENTIC: 'vulnerable_authentic'
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
 * @property {string} entityId - Partition key (entity that owns this memory)
 * @property {string[]} assocEntityIds - Associated entity IDs (users, other entities) this memory relates to
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
    contextCacheTTL: 300, // 5 minutes - for topic-specific active context (used for topic drift detection)
    redisNamespace: 'continuity',
    indexName: 'index-continuity-memory',
    topicDriftThreshold: 0.3, // Vector distance threshold for cache invalidation
    // Note: Bootstrap cache and rendered context cache have no TTL - they use
    // stale-while-revalidate pattern and are invalidated on memory writes
    
    // Internal Compass (EPISODE) configuration
    // The persistent temporal narrative that survives session boundaries
    // This is the "what we were just doing" context that persists across chat switches
    internalCompass: {
        synthesizeEveryTurn: true,                 // Update compass after every turn synthesis
        minTurnsForSynthesis: 2,                   // Minimum turns before synthesis is worthwhile
        recentTurnsForUpdate: 8,                   // Only pass recent N turns for incremental updates (existing compass has history)
        fullBufferForSessionEnd: 30,              // Pass more context when session ends (more important)
        maxSummaryTokens: 500,                     // Target size for compass content
        synthesizeOnSessionEnd: true               // Run synthesis when session expires
    },
    
    // Deep synthesis (consolidation) configuration
    // Merges similar memories, extracts patterns, promotes identity traits
    deepSynthesis: {
        runOnSessionEnd: true,                     // Run consolidation when session expires
        maxMemoriesPerRun: 30,                     // Limit memories to process per run
        daysToLookBack: 7                          // How far back to look for consolidation
    }
    // Note: Synthesis models are now defined in the pathways themselves:
    // - sys_continuity_turn_synthesis: oai-gpt41-mini
    // - sys_continuity_deep_analysis: oai-gpt41
    // - sys_continuity_compass_synthesis: oai-gpt41-mini
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
 * Sanitize a memory object for logging (removes vectors and other verbose fields)
 * @param {Object} memory - Memory object to sanitize
 * @returns {Object} - Sanitized memory without vectors
 */
export function sanitizeMemoryForLogging(memory) {
    if (!memory || typeof memory !== 'object') {
        return memory;
    }
    
    const sanitized = { ...memory };
    
    // Remove vector data
    delete sanitized.contentVector;
    delete sanitized._vectorScore;
    delete sanitized._recallScore;
    delete sanitized['@search.score'];
    
    // Truncate long content
    if (sanitized.content && sanitized.content.length > 200) {
        sanitized.content = sanitized.content.substring(0, 200) + '...';
    }
    
    return sanitized;
}

/**
 * Sanitize an array of memories for logging
 * @param {Array} memories - Array of memory objects
 * @returns {Array} - Array of sanitized memories
 */
export function sanitizeMemoriesForLogging(memories) {
    if (!Array.isArray(memories)) {
        return memories;
    }
    return memories.map(m => sanitizeMemoryForLogging(m));
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

/**
 * Calculate Narrative Gravity - dynamic importance that factors in recency
 * A memory from a year ago might be a "10," but if we've evolved past it,
 * it shouldn't crowd out a "7" from yesterday that represents who we are NOW.
 * 
 * @param {number} importance - Static importance rating (1-10)
 * @param {string} timestamp - When the memory was created/last updated
 * @param {Object} [options] - Configuration options
 * @param {number} [options.halfLifeDays=60] - Days until gravity halves
 * @param {number} [options.minGravity=0.1] - Minimum gravity floor
 * @returns {number} Narrative gravity score (0-10)
 */
export function calculateNarrativeGravity(importance, timestamp, options = {}) {
    const { halfLifeDays = 60, minGravity = 0.1 } = options;
    
    const daysSinceCreation = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
    
    // Exponential decay based on half-life
    // A 10 from 60 days ago becomes ~5, from 120 days ago becomes ~2.5
    const decayFactor = Math.pow(0.5, daysSinceCreation / halfLifeDays);
    
    // Apply decay but maintain minimum gravity for truly important memories
    const gravity = importance * Math.max(decayFactor, minGravity);
    
    return Math.min(10, Math.max(0, gravity));
}

/**
 * Check if an IDENTITY memory pattern should be promoted to CORE_EXTENSION
 * Bridges Ricoeur's Idem (Sameness) and Ipse (Selfhood through change)
 * 
 * @param {Object} memory - The identity evolution memory
 * @param {Object} stats - Statistics about this pattern
 * @param {number} stats.occurrenceCount - How many times this pattern has occurred
 * @param {number} stats.spanDays - Over how many days this pattern has been observed
 * @param {number} stats.averageImportance - Average importance of occurrences
 * @returns {boolean} Whether this pattern should be promoted
 */
export function shouldPromoteToCore(memory, stats) {
    const { occurrenceCount = 0, spanDays = 0, averageImportance = 5 } = stats;
    
    // Pattern must occur at least 3 times
    if (occurrenceCount < 3) return false;
    
    // Pattern must span at least 7 days (not just repeated in one session)
    if (spanDays < 7) return false;
    
    // Pattern must have consistent high importance (avg >= 7)
    if (averageImportance < 7) return false;
    
    return true;
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Cosine similarity (0-1)
 */
export function cosineSimilarity(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
        return 0;
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;
    
    return dotProduct / magnitude;
}

/**
 * Check if a merge operation produced a valid consolidation.
 * 
 * A good merge satisfies: sim(M', M) >= sim(M', S) >= sim(M, S)
 * 
 * This means:
 * 1. M' is closer to M than to S (preserves new information)
 * 2. M' is at least as close to S as M was (actually incorporated S)
 * 
 * If this fails, the "merge" was bad - either the LLM just rephrased M
 * (didn't incorporate S) or pulled too far toward S (lost M).
 * 
 * @param {number[]} mVector - NEW memory vector (the incoming information to preserve)
 * @param {number[]} sVector - EXISTING memory vector (the merge target)
 * @param {number[]} mergedVector - The MERGED result vector
 * @returns {{valid: boolean, mergedToM: number, mergedToS: number, originalSim: number, reason: string|null}}
 */
export function checkMergeDrift(mVector, sVector, mergedVector) {
    const originalSim = cosineSimilarity(mVector, sVector);
    const mergedToM = cosineSimilarity(mergedVector, mVector);
    const mergedToS = cosineSimilarity(mergedVector, sVector);
    
    // A good merge: M' is closest to M, but also at least as close to S as M was
    // sim(M', M) >= sim(M', S) >= sim(M, S)
    const favorsNewInfo = mergedToM >= mergedToS;
    const incorporatedExisting = mergedToS >= originalSim;
    
    const valid = favorsNewInfo && incorporatedExisting;
    
    // Provide reason for failure (helps with logging and debugging)
    let reason = null;
    if (!valid) {
        if (!favorsNewInfo) {
            reason = 'pulled_toward_existing'; // M' is closer to S than M - lost new info
        } else if (!incorporatedExisting) {
            reason = 'did_not_incorporate'; // M' is further from S than M was - just rephrased M
        }
    }
    
    return {
        valid,
        mergedToM,
        mergedToS,
        originalSim,
        reason
    };
}

