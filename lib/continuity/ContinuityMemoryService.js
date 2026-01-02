/**
 * Continuity Memory Service
 * 
 * Main orchestrator for the Continuity Architecture.
 * Provides a unified API for:
 * - Pre-response context assembly (getContextWindow)
 * - Post-response synthesis (synthesizeTurn)
 * - Memory search and management
 * - Expression state management
 * 
 * Integration points:
 * - pathwayResolver.js: Called before model execution
 * - sys_entity_agent.js: Tool access for explicit memory queries
 */

import { config } from '../../config.js';
import logger from '../logger.js';
import { RedisHotMemory } from './storage/RedisHotMemory.js';
import { AzureMemoryIndex } from './storage/AzureMemoryIndex.js';
import { ContextBuilder } from './synthesis/ContextBuilder.js';
import { NarrativeSynthesizer } from './synthesis/NarrativeSynthesizer.js';
import { MemoryDeduplicator } from './synthesis/MemoryDeduplicator.js';
import {
    ContinuityMemoryType,
    DEFAULT_CONFIG,
    createDefaultExpressionState
} from './types.js';

/**
 * Singleton instance
 * @type {ContinuityMemoryService|null}
 */
let instance = null;

export class ContinuityMemoryService {
    /**
     * @param {Object} [options]
     * @param {string} [options.redisConnectionString]
     * @param {string} [options.indexName]
     * @param {string} [options.synthesisModel]
     */
    constructor(options = {}) {
        // Get Redis connection from config
        let redisConnectionString;
        try {
            redisConnectionString = options.redisConnectionString || config.get('storageConnectionString');
        } catch {
            redisConnectionString = null;
        }
        
        // Initialize storage layers
        this.hotMemory = new RedisHotMemory({
            connectionString: redisConnectionString,
            namespace: options.namespace || DEFAULT_CONFIG.redisNamespace
        });
        
        this.coldMemory = new AzureMemoryIndex({
            indexName: options.indexName || DEFAULT_CONFIG.indexName
        });
        
        // Initialize deduplicator for smart memory storage
        this.deduplicator = new MemoryDeduplicator(this.coldMemory, {
            similarityThreshold: options.dedupThreshold || 0.85,
            maxClusterSize: options.maxClusterSize || 5
        });
        
        // Initialize synthesis components
        this.contextBuilder = new ContextBuilder(this.hotMemory, this.coldMemory);
        this.synthesizer = new NarrativeSynthesizer(this.coldMemory, {
            synthesisModel: options.synthesisModel || DEFAULT_CONFIG.synthesisModel,
            deduplicator: this.deduplicator // Pass deduplicator for smart storage
        });
        
        // Track active synthesis tasks
        this.pendingSynthesis = new Map();
        
        logger.info('ContinuityMemoryService initialized');
    }
    
    /**
     * Get or create singleton instance
     * @param {Object} [options]
     * @returns {ContinuityMemoryService}
     */
    static getInstance(options = {}) {
        if (!instance) {
            instance = new ContinuityMemoryService(options);
        }
        return instance;
    }
    
    /**
     * Check if the service is available
     * @returns {boolean}
     */
    isAvailable() {
        return this.hotMemory.isAvailable() || this.coldMemory.isConfigured();
    }
    
    // ==================== CONTEXT ASSEMBLY (Pre-Response) ====================
    
    /**
     * Get context window for current conversation
     * 
     * Uses a layered context assembly approach:
     * 
     * 1. BOOTSTRAP LAYER (Identity + Relationship)
     *    - CORE memories: Fundamental identity, constraints, behavior rules
     *    - Relational base: Top relationship anchors by importance
     *    - Fetched based on WHO (entity/user), not WHAT (query)
     *    - Always included regardless of current topic
     * 
     * 2. TOPIC LAYER (Query-Informed)
     *    - Semantic search for topic-specific memories
     *    - Additive to bootstrap, fills in contextual details
     * 
     * 3. SYNTHESIS
     *    - Combine layers, deduplicate, format for prompt injection
     * 
     * This is the main entry point for pathwayResolver integration.
     * 
     * @param {Object} params
     * @param {string} params.entityId
     * @param {string} params.userId
     * @param {string} params.query - Current user message
     * @param {Object} [params.options]
     * @returns {Promise<string>} Formatted context for system prompt
     */
    async getContextWindow({ entityId, userId, query, options = {} }) {
        const {
            episodicLimit = 20,
            topicMemoryLimit = 10,           // Topic-specific search limit
            bootstrapRelationalLimit = 5,    // Top relational anchors to always include
            bootstrapMinImportance = 6,      // Minimum importance for relational base
            expandGraph = true,
            maxGraphDepth = 1
        } = options;
        
        // Ensure query is a string
        const queryStr = typeof query === 'string' ? query : String(query || '');
        
        try {
            // ==================== HOT MEMORY (Session State) ====================
            
            // 1. Get episodic stream (recent turns)
            const episodicStream = await this.hotMemory.getEpisodicStream(
                entityId, userId, episodicLimit
            );
            
            // 2. Get expression state (current emotional/stylistic tuning)
            const expressionState = await this.hotMemory.getExpressionState(entityId, userId);
            
            // 3. Check cached context (for topic drift detection)
            const activeCache = await this.hotMemory.getActiveContext(entityId, userId);
            
            // ==================== BOOTSTRAP LAYER (Identity + Relationship) ====================
            // Fetched based on WHO, not WHAT - always present regardless of query
            
            const { coreMemories, relationalBase } = await this._getBootstrapContext(
                entityId, userId, bootstrapRelationalLimit, bootstrapMinImportance
            );
            
            logger.debug(`Bootstrap context: ${coreMemories.length} CORE, ${relationalBase.length} relational base`);
            
            // ==================== TOPIC LAYER (Query-Informed) ====================
            // Additive search based on current query
            
            const needsFreshTopicSearch = !activeCache || 
                this.contextBuilder.hasTopicDrifted(queryStr, activeCache.narrativeContext);
            
            logger.debug(`Topic search: query="${queryStr.substring(0, 50)}...", needsFresh=${needsFreshTopicSearch}`);
            
            let topicMemories = [];
            let expandedMemories = [];
            
            if (needsFreshTopicSearch && this.coldMemory.isConfigured()) {
                // Semantic search for topic-specific memories
                topicMemories = await this.coldMemory.searchSemantic(
                    entityId, userId, queryStr, topicMemoryLimit
                );
                
                logger.debug(`Topic search returned ${topicMemories.length} memories`);
                
                // Graph expansion from topic memories
                if (expandGraph && topicMemories.length > 0) {
                    const allMemories = await this.coldMemory.expandGraph(
                        topicMemories, maxGraphDepth
                    );
                    const topicIds = new Set(topicMemories.map(m => m.id));
                    expandedMemories = allMemories.filter(m => !topicIds.has(m.id));
                    logger.debug(`Graph expansion added ${expandedMemories.length} related memories`);
                }
            } else if (activeCache && this.coldMemory.isConfigured()) {
                // Reuse cached topic memories
                const cachedIds = [
                    ...(activeCache.currentRelationalAnchors || []),
                    ...(activeCache.activeResonanceArtifacts || [])
                ];
                
                if (cachedIds.length > 0) {
                    logger.debug(`Using ${cachedIds.length} cached topic memory IDs`);
                    topicMemories = await this.coldMemory.getByIds(cachedIds);
                }
            }
            
            // ==================== COMBINE LAYERS ====================
            // Bootstrap takes priority, topic fills in details, deduped
            
            const relevantMemories = this._combineAndDedupeMemories(
                coreMemories,
                relationalBase,
                topicMemories
            );
            
            logger.debug(`Combined context: ${relevantMemories.length} unique memories`);
            
            // ==================== CACHE UPDATE ====================
            
            if (needsFreshTopicSearch && this.coldMemory.isConfigured()) {
                const narrativeContext = await this.contextBuilder.generateNarrativeSummary(
                    entityId, userId, [...relevantMemories, ...expandedMemories], queryStr
                );
                
                await this.hotMemory.setActiveContext(entityId, userId, {
                    currentRelationalAnchors: relevantMemories
                        .filter(m => m.type === ContinuityMemoryType.ANCHOR)
                        .map(m => m.id),
                    activeResonanceArtifacts: relevantMemories
                        .filter(m => m.type === ContinuityMemoryType.ARTIFACT)
                        .map(m => m.id),
                    narrativeContext
                });
            }
            
            // ==================== BUILD CONTEXT WINDOW ====================
            
            const context = this.contextBuilder.buildContextWindow({
                episodicStream,
                activeCache: needsFreshTopicSearch ? null : activeCache,
                expressionState,
                relevantMemories,
                expandedMemories,
                currentQuery: queryStr
            });
            
            return context;
        } catch (error) {
            logger.error(`Failed to get context window: ${error.message}`);
            return '';
        }
    }
    
    /**
     * Get bootstrap context - identity and relational foundation
     * 
     * This is fetched based on WHO (entity/user), not WHAT (query).
     * Provides the foundational layer that should always be present:
     * - CORE directives: Fundamental identity, constraints, behavior rules
     * - Relational base: Top relationship anchors by importance
     * 
     * @private
     * @param {string} entityId
     * @param {string} userId
     * @param {number} relationalLimit - Max relational anchors to fetch
     * @param {number} minImportance - Minimum importance threshold
     * @returns {Promise<{coreMemories: ContinuityMemoryNode[], relationalBase: ContinuityMemoryNode[]}>}
     */
    async _getBootstrapContext(entityId, userId, relationalLimit = 5, minImportance = 6) {
        if (!this.coldMemory.isConfigured()) {
            return { coreMemories: [], relationalBase: [] };
        }
        
        try {
            // Fetch in parallel for efficiency
            const [coreMemories, relationalBase] = await Promise.all([
                // CORE directives - always included, no importance filter
                this.coldMemory.getByType(entityId, userId, ContinuityMemoryType.CORE, 10),
                
                // Top relational anchors - by importance, not query
                this.coldMemory.getTopByImportance(entityId, userId, {
                    types: [ContinuityMemoryType.ANCHOR],
                    limit: relationalLimit,
                    minImportance
                })
            ]);
            
            return { coreMemories, relationalBase };
        } catch (error) {
            logger.error(`Failed to get bootstrap context: ${error.message}`);
            return { coreMemories: [], relationalBase: [] };
        }
    }
    
    /**
     * Combine and deduplicate memories from bootstrap and topic layers
     * 
     * Priority order:
     * 1. CORE memories (identity foundation)
     * 2. Relational base (relationship foundation)
     * 3. Topic memories (query-informed details)
     * 
     * @private
     * @param {ContinuityMemoryNode[]} coreMemories
     * @param {ContinuityMemoryNode[]} relationalBase
     * @param {ContinuityMemoryNode[]} topicMemories
     * @returns {ContinuityMemoryNode[]}
     */
    _combineAndDedupeMemories(coreMemories, relationalBase, topicMemories) {
        const seen = new Set();
        const result = [];
        
        // Add in priority order: CORE first, then relational base, then topic
        for (const memory of [...coreMemories, ...relationalBase, ...topicMemories]) {
            if (memory?.id && !seen.has(memory.id)) {
                seen.add(memory.id);
                result.push(memory);
            }
        }
        
        return result;
    }
    
    // ==================== TURN PROCESSING (Post-Response) ====================
    
    /**
     * Record a conversation turn
     * @param {string} entityId
     * @param {string} userId
     * @param {EpisodicTurn} turn
     */
    async recordTurn(entityId, userId, turn) {
        try {
            await this.hotMemory.appendEpisodicTurn(entityId, userId, turn);
            await this.hotMemory.updateLastInteraction(entityId, userId, turn);
        } catch (error) {
            logger.error(`Failed to record turn: ${error.message}`);
        }
    }
    
    /**
     * Trigger synthesis after a response
     * This runs asynchronously - fire and forget
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} context
     * @param {string} context.aiName
     * @param {string} [context.entityContext]
     */
    async triggerSynthesis(entityId, userId, context = {}) {
        const key = `${entityId}:${userId}`;
        
        // Debounce: Don't start new synthesis if one is in progress
        if (this.pendingSynthesis.has(key)) {
            return;
        }
        
        this.pendingSynthesis.set(key, true);
        
        // Run synthesis in background
        setImmediate(async () => {
            try {
                // Get recent episodic buffer
                const episodicBuffer = await this.hotMemory.getEpisodicStream(
                    entityId, userId, 10
                );
                
                if (episodicBuffer.length < 2) {
                    return; // Need at least a user+assistant turn
                }
                
                // Run synthesis
                const result = await this.synthesizer.synthesizeTurn(
                    entityId, userId, episodicBuffer, context
                );
                
                // Apply expression adjustments if any
                if (result.expressionAdjustments && 
                    Object.keys(result.expressionAdjustments).length > 0) {
                    await this.hotMemory.updateExpressionState(
                        entityId, userId, result.expressionAdjustments
                    );
                }
                
                // Invalidate context cache if new memories were created
                const totalNewMemories = 
                    result.newAnchors.length + 
                    result.newArtifacts.length + 
                    result.identityUpdates.length +
                    result.shorthands.length;
                
                if (totalNewMemories > 0) {
                    await this.hotMemory.invalidateActiveContext(entityId, userId);
                    logger.debug(`Synthesis created ${totalNewMemories} new memories`);
                }
            } catch (error) {
                logger.error(`Synthesis failed: ${error.message}`);
            } finally {
                this.pendingSynthesis.delete(key);
            }
        });
    }
    
    // ==================== MEMORY SEARCH (Tool Access) ====================
    
    /**
     * Search memories explicitly (for tool use)
     * @param {Object} params
     * @param {string} params.entityId
     * @param {string} params.userId
     * @param {string} params.query
     * @param {Object} [params.options]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async searchMemory({ entityId, userId, query, options = {} }) {
        const {
            types = null,
            limit = 10,
            expandGraph = false
        } = options;
        
        try {
            let results = await this.coldMemory.searchSemantic(
                entityId, userId, query, limit, types
            );
            
            if (expandGraph && results.length > 0) {
                results = await this.coldMemory.expandGraph(results, 1);
            }
            
            return results;
        } catch (error) {
            logger.error(`Memory search failed: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Get memories by type
     * @param {string} entityId
     * @param {string} userId
     * @param {string} type
     * @param {number} [limit=10]
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getMemoriesByType(entityId, userId, type, limit = 10) {
        return this.coldMemory.getByType(entityId, userId, type, limit);
    }
    
    /**
     * Format memories for LLM display
     * @param {ContinuityMemoryNode[]} memories
     * @returns {string}
     */
    formatMemoriesForDisplay(memories) {
        if (!memories || memories.length === 0) {
            return 'No memories found.';
        }
        
        const grouped = {};
        for (const memory of memories) {
            const type = memory.type || 'OTHER';
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(memory);
        }
        
        const sections = [];
        
        for (const [type, mems] of Object.entries(grouped)) {
            const typeLabel = {
                [ContinuityMemoryType.ANCHOR]: 'Relational Anchors',
                [ContinuityMemoryType.ARTIFACT]: 'Resonance Artifacts',
                [ContinuityMemoryType.IDENTITY]: 'Identity Evolution',
                [ContinuityMemoryType.CORE]: 'Core Directives',
                [ContinuityMemoryType.EPISODE]: 'Episodes'
            }[type] || type;
            
            const items = mems.map(m => `- ${m.content}`).join('\n');
            sections.push(`**${typeLabel}:**\n${items}`);
        }
        
        return sections.join('\n\n');
    }
    
    // ==================== EXPRESSION STATE ====================
    
    /**
     * Get current expression state
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<ExpressionState|null>}
     */
    async getExpressionState(entityId, userId) {
        return this.hotMemory.getExpressionState(entityId, userId);
    }
    
    /**
     * Update expression state
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ExpressionState>} updates
     */
    async updateExpressionState(entityId, userId, updates) {
        await this.hotMemory.updateExpressionState(entityId, userId, updates);
    }
    
    // ==================== SESSION MANAGEMENT ====================
    
    /**
     * Initialize or resume a session
     * @param {string} entityId
     * @param {string} userId
     * @param {boolean} [forceNew=false]
     */
    async initSession(entityId, userId, forceNew = false) {
        try {
            await this.hotMemory.ensureStructures(entityId, userId);
            
            if (forceNew) {
                await this.hotMemory.startNewSession(entityId, userId);
            } else {
                // Check if session has expired (>4 hours since last interaction)
                const timeSinceLast = await this.hotMemory.getTimeSinceLastInteraction(entityId, userId);
                
                if (timeSinceLast === null || timeSinceLast > 4 * 60 * 60 * 1000) {
                    await this.hotMemory.startNewSession(entityId, userId);
                }
            }
        } catch (error) {
            logger.error(`Failed to init session: ${error.message}`);
        }
    }
    
    /**
     * Get session info
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<Object>}
     */
    async getSessionInfo(entityId, userId) {
        const [expressionState, episodicStream, sessionDuration] = await Promise.all([
            this.hotMemory.getExpressionState(entityId, userId),
            this.hotMemory.getEpisodicStream(entityId, userId, 100),
            this.hotMemory.getSessionDuration(entityId, userId)
        ]);
        
        return {
            turnCount: episodicStream.length,
            sessionDurationMs: sessionDuration,
            lastInteraction: expressionState?.lastInteractionTimestamp,
            currentTone: expressionState?.lastInteractionTone,
            emotionalResonance: expressionState?.emotionalResonance
        };
    }
    
    // ==================== MEMORY MANAGEMENT ====================
    
    /**
     * Add a memory directly (without deduplication)
     * Use addMemoryWithDedup for smart storage that merges similar memories
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @returns {Promise<string|null>} Memory ID
     */
    async addMemory(entityId, userId, memory) {
        return this.coldMemory.upsertMemory(entityId, userId, memory);
    }
    
    /**
     * Add a memory with deduplication
     * Finds and merges semantically similar existing memories
     * Preserves narrative properties during merge
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @returns {Promise<{id: string, merged: boolean, mergedCount: number}>}
     */
    async addMemoryWithDedup(entityId, userId, memory) {
        return this.deduplicator.storeWithDedup(entityId, userId, memory);
    }
    
    /**
     * Cluster and consolidate all memories for an entity/user
     * Use for batch deduplication of existing memories
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {string} [options.type] - Optional type filter
     * @returns {Promise<{clustered: number, reduced: number}>}
     */
    async consolidateMemories(entityId, userId, options = {}) {
        return this.deduplicator.clusterAndConsolidate(entityId, userId, options);
    }
    
    /**
     * Delete a memory
     * @param {string} memoryId
     */
    async deleteMemory(memoryId) {
        await this.coldMemory.deleteMemory(memoryId);
    }
    
    /**
     * Delete all memories for a given entity/user combination
     * Useful for test/benchmark cleanup
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {string[]} [options.tags] - Optional tags filter (e.g., ['test', 'benchmark'])
     * @returns {Promise<{deleted: number}>}
     */
    async deleteAllMemories(entityId, userId, options = {}) {
        try {
            // Search for all memories for this entity/user
            // Use a high limit to get all memories
            const allMemories = await this.coldMemory.searchFullText(
                entityId, 
                userId, 
                '*', 
                { limit: 10000 } // High limit to catch all test data
            );
            
            // Filter by tags if provided
            let memoriesToDelete = allMemories;
            if (options.tags && options.tags.length > 0) {
                const tagSet = new Set(options.tags);
                memoriesToDelete = allMemories.filter(m => {
                    const memoryTags = m.tags || [];
                    return options.tags.some(tag => memoryTags.includes(tag));
                });
            }
            
            if (memoriesToDelete.length === 0) {
                return { deleted: 0 };
            }
            
            // Delete all matching memories
            const idsToDelete = memoriesToDelete.map(m => m.id).filter(Boolean);
            await this.coldMemory.deleteMemories(idsToDelete);
            
            logger.info(`Deleted ${idsToDelete.length} memories for ${entityId}/${userId}`);
            return { deleted: idsToDelete.length };
        } catch (error) {
            logger.error(`Failed to delete all memories: ${error.message}`);
            return { deleted: 0, error: error.message };
        }
    }
    
    /**
     * Handle "forget me" request
     * @param {string} entityId
     * @param {string} userId
     */
    async forgetUser(entityId, userId) {
        logger.info(`Processing forget request for ${entityId}/${userId}`);
        
        // Clear hot memory
        await this.hotMemory.clearEpisodicStream(entityId, userId);
        await this.hotMemory.invalidateActiveContext(entityId, userId);
        
        // Cascading delete in cold memory
        await this.coldMemory.cascadingForget(entityId, userId);
    }
    
    /**
     * Link two memories
     * @param {string} memoryId1
     * @param {string} memoryId2
     */
    async linkMemories(memoryId1, memoryId2) {
        await this.coldMemory.linkMemories(memoryId1, memoryId2);
    }
    
    // ==================== DEEP SYNTHESIS ====================
    
    /**
     * Trigger deep synthesis (consolidation, pattern recognition)
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {number} [options.maxMemories=50] - Max memories to analyze
     * @param {number} [options.daysToLookBack=7] - How far back to look
     * @returns {Promise<Object>}
     */
    async runDeepSynthesis(entityId, userId, options = {}) {
        return this.synthesizer.runDeepSynthesis(entityId, userId, options);
    }
    
    // ==================== CLEANUP ====================
    
    /**
     * Graceful shutdown
     */
    close() {
        this.hotMemory.close();
        instance = null;
    }
}

// Export factory function for easy access
export function getContinuityMemoryService(options = {}) {
    return ContinuityMemoryService.getInstance(options);
}

export default ContinuityMemoryService;

