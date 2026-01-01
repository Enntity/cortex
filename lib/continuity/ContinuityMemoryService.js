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
        
        // Initialize synthesis components
        this.contextBuilder = new ContextBuilder(this.hotMemory, this.coldMemory);
        this.synthesizer = new NarrativeSynthesizer(this.coldMemory, {
            synthesisModel: options.synthesisModel || DEFAULT_CONFIG.synthesisModel
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
     * Get the context window for LLM prompt injection
     * This is the main entry point for pathwayResolver integration
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
            memoryLimit = 5,
            expandGraph = true,
            maxGraphDepth = 1
        } = options;
        
        try {
            // 1. Get hot memory (episodic stream)
            const episodicStream = await this.hotMemory.getEpisodicStream(
                entityId, userId, episodicLimit
            );
            
            // 2. Get expression state
            const expressionState = await this.hotMemory.getExpressionState(entityId, userId);
            
            // 3. Check cached context
            const activeCache = await this.hotMemory.getActiveContext(entityId, userId);
            
            // 4. Determine if we need fresh semantic search
            const needsFreshSearch = !activeCache || 
                this.contextBuilder.hasTopicDrifted(query, activeCache.narrativeContext);
            
            let relevantMemories = [];
            let expandedMemories = [];
            
            if (needsFreshSearch && this.coldMemory.isConfigured()) {
                // 5. Semantic search for relevant memories
                relevantMemories = await this.coldMemory.searchSemantic(
                    entityId, userId, query, memoryLimit
                );
                
                // 6. Graph expansion
                if (expandGraph && relevantMemories.length > 0) {
                    const allMemories = await this.coldMemory.expandGraph(
                        relevantMemories, maxGraphDepth
                    );
                    // Remove duplicates from expanded set
                    const relevantIds = new Set(relevantMemories.map(m => m.id));
                    expandedMemories = allMemories.filter(m => !relevantIds.has(m.id));
                }
                
                // 7. Update cache
                const narrativeContext = await this.contextBuilder.generateNarrativeSummary(
                    entityId, userId, [...relevantMemories, ...expandedMemories], query
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
            
            // 8. Build context window
            const context = this.contextBuilder.buildContextWindow({
                episodicStream,
                activeCache: needsFreshSearch ? null : activeCache,
                expressionState,
                relevantMemories,
                expandedMemories,
                currentQuery: query
            });
            
            return context;
        } catch (error) {
            logger.error(`Failed to get context window: ${error.message}`);
            return '';
        }
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
     * Add a memory directly
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @returns {Promise<string|null>} Memory ID
     */
    async addMemory(entityId, userId, memory) {
        return this.coldMemory.upsertMemory(entityId, userId, memory);
    }
    
    /**
     * Delete a memory
     * @param {string} memoryId
     */
    async deleteMemory(memoryId) {
        await this.coldMemory.deleteMemory(memoryId);
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

