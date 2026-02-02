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
import logger, { continuityLog } from '../logger.js';
import { RedisHotMemory } from './storage/RedisHotMemory.js';
import { MongoMemoryIndex } from './storage/MongoMemoryIndex.js';
import { ContextBuilder } from './synthesis/ContextBuilder.js';
import { NarrativeSynthesizer } from './synthesis/NarrativeSynthesizer.js';
import { MemoryDeduplicator } from './synthesis/MemoryDeduplicator.js';
import { ResonanceTracker } from './eidos/ResonanceTracker.js';
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
     * @param {string} [options.aiName] - Entity name for synthesis
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
        
        // Initialize cold memory (MongoDB backend)
        this.coldMemory = new MongoMemoryIndex({
            collectionName: options.collectionName || 'continuity_memories',
            databaseName: options.databaseName || null  // Use URI's database
        });
        logger.info('Continuity memory using MongoDB backend');
        
        // Initialize deduplicator for smart memory storage
        // Callback invalidates bootstrap cache on any write (simpler than type-checking)
        this.deduplicator = new MemoryDeduplicator(this.coldMemory, {
            similarityThreshold: options.dedupThreshold || 0.85,
            maxClusterSize: options.maxClusterSize || 5,
            onMemoryWrite: (entityId, userId) => {
                this.hotMemory.invalidateBootstrapCache(entityId, userId).catch(() => {});
            }
        });
        
        // Initialize synthesis components
        this.contextBuilder = new ContextBuilder(this.hotMemory, this.coldMemory);
        this.synthesizer = new NarrativeSynthesizer(this.coldMemory, {
            aiName: options.aiName || 'Entity',
            deduplicator: this.deduplicator // Pass deduplicator for smart storage
        });
        
        // Track active synthesis tasks
        this.pendingSynthesis = new Map();

        // Eidos introspection layer
        this.resonanceTracker = new ResonanceTracker();

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
            
            // ==================== TOPIC LAYER (Query-Informed) ====================
            // Additive search based on current query
            
            const needsFreshTopicSearch = !activeCache || 
                this.contextBuilder.hasTopicDrifted(queryStr, activeCache.narrativeContext);
            
            let topicMemories = [];
            let expandedMemories = [];
            
            if (needsFreshTopicSearch && this.coldMemory.isConfigured()) {
                // Semantic search for topic-specific memories
                topicMemories = await this.coldMemory.searchSemantic(
                    entityId, userId, queryStr, topicMemoryLimit
                );
                
                // Graph expansion from topic memories
                if (expandGraph && topicMemories.length > 0) {
                    const allMemories = await this.coldMemory.expandGraph(
                        topicMemories, maxGraphDepth
                    );
                    const topicIds = new Set(topicMemories.map(m => m.id));
                    expandedMemories = allMemories.filter(m => !topicIds.has(m.id));
                }
            } else if (activeCache && this.coldMemory.isConfigured()) {
                // Reuse cached topic memories
                const cachedIds = [
                    ...(activeCache.currentRelationalAnchors || []),
                    ...(activeCache.activeResonanceArtifacts || [])
                ];
                
                if (cachedIds.length > 0) {
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
            
            // Only log summary, not details
            if (relevantMemories.length > 0) {
                logger.debug(`Context assembled: ${relevantMemories.length} memories (${coreMemories.length} CORE, ${relationalBase.length} relational, ${topicMemories.length} topic)`);
            }
            
            // ==================== INTERNAL COMPASS (Temporal Narrative) ====================
            // Fetch the persistent narrative that tracks "what we've been doing"
            
            const internalCompass = await this.synthesizer.getInternalCompass(entityId, userId);
            if (internalCompass) {
                logger.debug(`Internal Compass found, last synthesized: ${internalCompass.metadata?.lastSynthesized || 'unknown'}`);
            }
                
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
                internalCompass,
                currentQuery: queryStr
            });
            
            // Log context block in continuity mode (with proper entity/user context)
            if (context && process.env.CORTEX_LOG_MODE === 'continuity') {
                const typeCounts = {};
                relevantMemories.forEach(m => {
                    typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
                });
                continuityLog.contextBlock(entityId, userId, context, { memoryCounts: typeCounts });
                
                // Also log the compass separately if present
                if (internalCompass) {
                    continuityLog.compass(entityId, userId, internalCompass);
                }
            }
            
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
        
        // Check Redis cache first - bootstrap context is identity-based, not query-based
        const cached = await this.hotMemory.getBootstrapCache(entityId, userId);
        if (cached) {
            logger.debug(`Bootstrap cache hit: ${cached.coreMemories.length} core, ${cached.relationalBase.length} relational`);
            return {
                coreMemories: cached.coreMemories,
                relationalBase: cached.relationalBase
            };
        }
        
        // Bootstrap limits - these are foundational and should be generous
        // TODO: Make dynamic based on available context budget
        const CORE_LIMIT = 30;           // Fundamental directives
        const CORE_EXTENSION_LIMIT = 100; // All evolved identity patterns
        
        try {
            // Cache miss - fetch from cold storage (3 parallel calls)
            const [coreDirectives, coreExtensions, relationalBase] = await Promise.all([
                // CORE directives - original identity bedrock (Idem)
                // Ordered by importance to get the most critical ones first
                this.coldMemory.getByType(entityId, userId, ContinuityMemoryType.CORE, CORE_LIMIT),
                
                // CORE_EXTENSION - hardened patterns from identity evolution (Idem/Ipse bridge)
                // Fetch all of them for now - these represent earned identity growth
                this.coldMemory.getByType(entityId, userId, ContinuityMemoryType.CORE_EXTENSION, CORE_EXTENSION_LIMIT),
                
                // Top relational anchors - by importance, not query
                this.coldMemory.getTopByImportance(entityId, userId, {
                    types: [ContinuityMemoryType.ANCHOR],
                    limit: relationalLimit,
                    minImportance
                })
            ]);
            
            // Combine CORE and CORE_EXTENSION into unified core memories
            const coreMemories = [...coreDirectives, ...coreExtensions];
            
            // Cache for subsequent requests (fire and forget)
            this.hotMemory.setBootstrapCache(entityId, userId, {
                coreMemories,
                relationalBase
            }).catch(err => logger.warn(`Failed to cache bootstrap: ${err.message}`));
            
            logger.debug(`Bootstrap cache miss: fetched ${coreMemories.length} core, ${relationalBase.length} relational from cold storage`);
            
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
            
            // Log turn recording in continuity mode
            continuityLog.recordTurn(entityId, userId, turn.role, turn.content);
        } catch (error) {
            logger.error(`Failed to record turn: ${error.message}`);
        }
    }
    
    /**
     * Trigger synthesis after a response
     * This runs asynchronously - fire and forget
     * 
     * Performs two types of synthesis:
     * 1. Turn synthesis - extracts anchors, artifacts, identity notes from conversation
     * 2. Compass synthesis - periodically updates the Internal Compass (temporal narrative)
     * 
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
                
                // Run turn synthesis (anchors, artifacts, identity, shorthands)
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
                    
                    // Log turn synthesis in continuity mode
                    continuityLog.synthesize('turn_synthesis', entityId, userId, {
                        newMemories: totalNewMemories,
                        stats: {
                            anchors: result.newAnchors.length,
                            artifacts: result.newArtifacts.length,
                            identity: result.identityUpdates.length,
                            shorthands: result.shorthands.length
                        }
                    });
                }
                
                // Eidos introspection + Internal Compass update
                if (DEFAULT_CONFIG.internalCompass?.synthesizeEveryTurn !== false) {
                    await this._processEidosAndCompass(entityId, userId, result, context, {
                        triggerSoulReport: true,
                        logCompass: true,
                    });
                }
            } catch (error) {
                logger.error(`Synthesis failed: ${error.message}`);
            } finally {
                this.pendingSynthesis.delete(key);
            }
        });
    }
    
    // ==================== EIDOS HELPERS ====================

    /**
     * Shared Eidos introspection + compass update logic.
     * Used by both triggerSynthesis (user-scoped) and triggerPulseSynthesis (entity-level).
     * @private
     */
    async _processEidosAndCompass(entityId, userId, result, context, { triggerSoulReport = false, logCompass = false, compassUserId = userId } = {}) {
        let eidosMetricsStr = '';
        if (DEFAULT_CONFIG.eidos?.enabled !== false) {
            try {
                const authenticityScore = result.authenticityAssessment?.score ?? null;
                const existingMetrics = await this.hotMemory.getEidosMetrics(entityId, userId);
                const resonanceMetrics = this.resonanceTracker.computeMetrics(result, existingMetrics?.resonanceMetrics);

                const scores = existingMetrics?.authenticityScores || [];
                if (authenticityScore !== null) {
                    scores.push(authenticityScore);
                    const maxScores = DEFAULT_CONFIG.eidos?.authenticity?.rollingWindowSize || 20;
                    while (scores.length > maxScores) scores.shift();
                }

                const turnCount = await this.hotMemory.incrementEidosTurnCount(entityId, userId);

                await this.hotMemory.updateEidosMetrics(entityId, userId, {
                    authenticityScores: scores,
                    resonanceMetrics,
                    turnCount,
                });

                eidosMetricsStr = this._formatEidosMetricsForCompass({
                    authenticityScores: scores,
                    resonanceMetrics,
                    turnCount,
                    driftNotes: result.authenticityAssessment?.driftNotes || '',
                    voiceCheck: result.voiceCheck || null,
                });

                if (triggerSoulReport) {
                    const soulReportInterval = DEFAULT_CONFIG.eidos?.soulReport?.turnInterval || 100;
                    const minTurnsForFirst = DEFAULT_CONFIG.eidos?.soulReport?.minTurnsForFirst || 50;
                    if (turnCount >= minTurnsForFirst && turnCount % soulReportInterval === 0) {
                        this._triggerSoulReport(entityId, userId, context);
                    }
                }
            } catch (eidosError) {
                logger.warn(`Eidos introspection failed (non-fatal): ${eidosError.message}`);
            }
        }

        // Internal Compass update
        const recentTurnsLimit = DEFAULT_CONFIG.internalCompass?.recentTurnsForUpdate || 8;
        const recentBuffer = await this.hotMemory.getEpisodicStream(entityId, userId, recentTurnsLimit);
        const minTurns = DEFAULT_CONFIG.internalCompass?.minTurnsForSynthesis || 2;

        if (recentBuffer.length >= minTurns) {
            const compassResult = await this.synthesizer.synthesizeInternalCompass(
                entityId,
                compassUserId,
                recentBuffer,
                { aiName: context.aiName || 'Entity', eidosMetrics: eidosMetricsStr }
            );

            if (logCompass && compassResult.updated) {
                continuityLog.synthesize('compass_synthesis', entityId, userId, {
                    content: compassResult.compass?.content
                });
                continuityLog.compass(entityId, userId, compassResult.compass);
            }
        }
    }

    /**
     * Format Eidos metrics as human-readable text for the compass LLM
     * @private
     * @param {Object} metrics
     * @returns {string}
     */
    _formatEidosMetricsForCompass(metrics) {
        const lines = [];
        if (metrics.authenticityScores?.length) {
            const recent = metrics.authenticityScores.slice(-5);
            const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
            lines.push(`Authenticity (last ${recent.length} turns): ${(avg * 100).toFixed(0)}%`);
        }
        if (metrics.driftNotes) {
            lines.push(`Last turn drift notes: ${metrics.driftNotes}`);
        }
        if (metrics.voiceCheck) {
            const vc = metrics.voiceCheck;
            const parts = [];
            if (vc.lengthFeel && vc.lengthFeel !== 'appropriate') {
                parts.push(`length=${vc.lengthFeel}`);
            }
            if (vc.modelInfluence) {
                parts.push(`model bleed: ${vc.modelInfluence}`);
            }
            if (vc.toneMismatch) {
                parts.push(`tone: ${vc.toneMismatch}`);
            }
            if (vc.correction) {
                parts.push(vc.correction);
            }
            if (parts.length > 0) {
                lines.push(`Voice check: ${parts.join('; ')}`);
            }
        }
        if (metrics.resonanceMetrics) {
            const r = metrics.resonanceMetrics;
            lines.push(`Resonance: trend=${r.trend}, attunement=${((r.attunementRatio || 0) * 100).toFixed(0)}%`);
        }
        if (metrics.turnCount) {
            lines.push(`Turn count: ${metrics.turnCount}`);
        }
        return lines.join('\n');
    }

    /**
     * Trigger a Soul Report (fire-and-forget).
     * Generates a first-person self-assessment stored as an IDENTITY memory.
     * @private
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} context
     */
    _triggerSoulReport(entityId, userId, context) {
        setImmediate(async () => {
            try {
                const { callPathway } = await import('../pathwayTools.js');

                // Gather inputs
                const metrics = await this.hotMemory.getEidosMetrics(entityId, userId);
                if (!metrics) return;

                const recentIdentity = await this.coldMemory.getByType(
                    entityId, userId, ContinuityMemoryType.IDENTITY, 20
                );
                const coreMemories = await this.coldMemory.getByType(
                    entityId, userId, ContinuityMemoryType.CORE, 10
                );

                const result = await callPathway('sys_eidos_soul_report', {
                    aiName: context.aiName || 'Entity',
                    entityContext: context.entityContext || '',
                    authenticityHistory: JSON.stringify(metrics.authenticityScores || []),
                    recentIdentityMemories: JSON.stringify(
                        (recentIdentity || []).map(m => ({
                            content: m.content,
                            importance: m.importance,
                            alignmentFlag: m.metadata?.alignmentFlag || null,
                            tags: m.tags,
                            timestamp: m.timestamp,
                        }))
                    ),
                    resonanceMetrics: JSON.stringify(metrics.resonanceMetrics || {}),
                    coreMemories: JSON.stringify(
                        (coreMemories || []).map(m => ({ content: m.content }))
                    ),
                });

                if (result && result.trim()) {
                    // Store as IDENTITY memory
                    const memory = {
                        type: ContinuityMemoryType.IDENTITY,
                        content: result.trim(),
                        importance: 9,
                        tags: ['soul-report', 'eidos', 'auto-synthesis'],
                        metadata: {
                            turnCountAtReport: metrics.turnCount,
                            generatedAt: new Date().toISOString(),
                        },
                    };

                    await this.synthesizer._storeMemory(entityId, userId, memory);

                    // Update last soul report timestamp
                    await this.hotMemory.updateEidosMetrics(entityId, userId, {
                        lastSoulReport: new Date().toISOString(),
                    });

                    logger.info(`Soul Report generated for ${entityId}/${userId} at turn ${metrics.turnCount}`);
                    continuityLog.synthesize('soul_report', entityId, userId, {
                        turnCount: metrics.turnCount,
                    });
                }
            } catch (error) {
                logger.warn(`Soul Report generation failed (non-fatal): ${error.message}`);
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
     * 
     * When a session expires (>4 hours), this will:
     * 1. Synthesize the Internal Compass from the expiring session's episodic stream
     * 2. Clear the episodic stream
     * 3. Start a fresh session
     * 
     * This ensures the entity "wakes up" with context from the previous session.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {boolean} [forceNew=false]
     * @param {Object} [context] - Context for compass synthesis
     * @param {string} [context.aiName] - Entity name for synthesis
     */
    async initSession(entityId, userId, forceNew = false, context = {}) {
        try {
            await this.hotMemory.ensureStructures(entityId, userId);
            
            const timeSinceLast = await this.hotMemory.getTimeSinceLastInteraction(entityId, userId);
            const sessionExpired = timeSinceLast === null || timeSinceLast > 4 * 60 * 60 * 1000;
            
            if (forceNew || sessionExpired) {
                // Before clearing the session, synthesize Internal Compass from episodic stream
                // This preserves "what we were doing" across the session boundary
                if (sessionExpired && DEFAULT_CONFIG.internalCompass?.synthesizeOnSessionEnd !== false) {
                    try {
                        // Use fuller buffer for session-end (more important synthesis)
                        const sessionEndBufferSize = DEFAULT_CONFIG.internalCompass?.fullBufferForSessionEnd || 30;
                        const episodicBuffer = await this.hotMemory.getEpisodicStream(entityId, userId, sessionEndBufferSize);
                        
                        if (episodicBuffer.length >= (DEFAULT_CONFIG.internalCompass?.minTurnsForSynthesis || 2)) {
                            logger.info(`Session expired - synthesizing Internal Compass before clearing (${episodicBuffer.length} turns)`);
                            
                            // Log session end in continuity mode
                            continuityLog.synthesize('session_end', entityId, userId, {
                                stats: { turns: episodicBuffer.length }
                            });
                            
                            const compassResult = await this.synthesizer.synthesizeInternalCompass(
                                entityId, 
                                userId, 
                                episodicBuffer, 
                                { 
                                    aiName: context.aiName || 'Entity',
                                    sessionEnding: true 
                                }
                            );
                            
                            // Log compass update in continuity mode
                            if (compassResult.updated) {
                                continuityLog.compass(entityId, userId, compassResult.compass);
                            }
                        }
                    } catch (compassError) {
                        // Non-fatal - log and continue with session reset
                        logger.warn(`Failed to synthesize compass on session end: ${compassError.message}`);
                    }
                }
                
                // Run deep synthesis on session end to consolidate similar memories
                // This merges duplicate anchors, extracts patterns, and promotes identity traits
                if (sessionExpired && DEFAULT_CONFIG.deepSynthesis?.runOnSessionEnd !== false) {
                    // Run in background - don't block session initialization
                    setImmediate(async () => {
                        try {
                            logger.info(`Session expired - running deep synthesis for consolidation`);
                            continuityLog.synthesize('deep_synthesis', entityId, userId, { 
                                stats: { trigger: 'session_end' } 
                            });
                            
                            const deepResult = await this.synthesizer.runDeepSynthesis(
                                entityId, 
                                userId, 
                                {
                                    maxMemories: DEFAULT_CONFIG.deepSynthesis?.maxMemoriesPerRun || 30,
                                    daysToLookBack: DEFAULT_CONFIG.deepSynthesis?.daysToLookBack || 7
                                }
                            );
                            
                            if (deepResult.consolidated > 0 || deepResult.patterns > 0) {
                                logger.info(`Deep synthesis complete: ${deepResult.consolidated} consolidated, ${deepResult.patterns} patterns`);
                                continuityLog.synthesize('deep_synthesis', entityId, userId, {
                                    stats: deepResult
                                });
                            }
                        } catch (deepError) {
                            logger.warn(`Deep synthesis on session end failed: ${deepError.message}`);
                        }
                    });
                }
                
                await this.hotMemory.startNewSession(entityId, userId);
                
                // Log session init in continuity mode
                continuityLog.synthesize('session_init', entityId, userId, {});
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
    
    // ==================== INTERNAL COMPASS (Temporal Narrative) ====================
    
    /**
     * Get the Internal Compass for an entity/user
     * 
     * The Internal Compass is a persistent EPISODE memory that tracks
     * "what we've been doing" across session boundaries.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<ContinuityMemoryNode|null>}
     */
    async getInternalCompass(entityId, userId) {
        return this.synthesizer.getInternalCompass(entityId, userId);
    }
    
    /**
     * Synthesize/update the Internal Compass
     * 
     * Called automatically on session end, but can also be triggered manually
     * for long-running sessions.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [context]
     * @param {string} [context.aiName]
     * @param {boolean} [context.sessionEnding=false]
     * @returns {Promise<{updated: boolean, compass: ContinuityMemoryNode|null}>}
     */
    async synthesizeInternalCompass(entityId, userId, context = {}) {
        try {
            // Get the current episodic buffer
            const episodicBuffer = await this.hotMemory.getEpisodicStream(entityId, userId, 50);
            
            if (episodicBuffer.length < (DEFAULT_CONFIG.internalCompass?.minTurnsForSynthesis || 4)) {
                logger.debug(`Skipping compass synthesis - only ${episodicBuffer.length} turns`);
                return { updated: false, compass: null };
            }
            
            return this.synthesizer.synthesizeInternalCompass(
                entityId, 
                userId, 
                episodicBuffer, 
                context
            );
        } catch (error) {
            logger.error(`Failed to synthesize Internal Compass: ${error.message}`);
            return { updated: false, compass: null };
        }
    }
    
    /**
     * Check if Internal Compass needs synthesis (time threshold exceeded)
     * 
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    async needsCompassSynthesis(entityId, userId) {
        return this.synthesizer.needsCompassSynthesis(entityId, userId);
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
        const result = await this.coldMemory.upsertMemory(entityId, userId, memory);
        
        // Invalidate bootstrap cache on any write
        this.hotMemory.invalidateBootstrapCache(entityId, userId).catch(() => {});
        
        return result;
    }
    
    /**
     * Add a memory with deduplication
     * Finds and merges semantically similar existing memories
     * Preserves narrative properties during merge
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>} memory
     * @param {Object} [options]
     * @param {boolean} [options.deferDeletes=false] - If true, return IDs for batch deletion later
     * @returns {Promise<{id: string, merged: boolean, mergedCount: number, mergedIds: string[]}>}
     */
    async addMemoryWithDedup(entityId, userId, memory, options = {}) {
        // Deduplicator handles cache invalidation via onMemoryWrite callback
        return this.deduplicator.storeWithDedup(entityId, userId, memory, options);
    }
    
    /**
     * Delete multiple memories by ID (batch delete)
     * @param {string[]} memoryIds - Array of memory IDs to delete
     * @returns {Promise<void>}
     */
    async deleteMemories(memoryIds) {
        if (!memoryIds || memoryIds.length === 0) return;
        await this.coldMemory.deleteMemories(memoryIds);
    }
    
    /**
     * Get all memories for an entity/user
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {number} [options.limit=1000] - Max memories to return
     * @returns {Promise<ContinuityMemoryNode[]>}
     */
    async getAllMemories(entityId, userId, options = {}) {
        return this.coldMemory.searchFullText(entityId, userId, '*', {
            limit: options.limit || 1000
        });
    }
    
    /**
     * Batch upsert multiple memories
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ContinuityMemoryNode>[]} memories
     * @returns {Promise<string[]>} Array of memory IDs
     */
    async upsertMemories(entityId, userId, memories) {
        const ids = await this.coldMemory.upsertMemories(entityId, userId, memories);
        // Invalidate bootstrap cache since we may have added core/anchor memories
        await this.hotMemory.invalidateBootstrapCache(entityId, userId);
        return ids;
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
            
            // Invalidate bootstrap cache since we may have deleted core/anchor memories
            await this.hotMemory.invalidateBootstrapCache(entityId, userId);
            
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
        
        // Clear hot memory (including bootstrap cache)
        await this.hotMemory.clearEpisodicStream(entityId, userId);
        await this.hotMemory.invalidateActiveContext(entityId, userId);
        await this.hotMemory.invalidateBootstrapCache(entityId, userId);
        
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
    
    // ==================== PULSE (LIFE LOOP) ====================

    /**
     * Sentinel userId for pulse episodic streams.
     * Pulse wakes are entity-level (no user), but the episodic stream
     * key pattern requires a userId component.
     */
    static PULSE_USER_ID = '__pulse__';

    /**
     * Record a turn during a pulse wake (entity-level episodic stream)
     * @param {string} entityId
     * @param {EpisodicTurn} turn
     */
    async recordPulseTurn(entityId, turn) {
        try {
            await this.hotMemory.appendEpisodicTurn(
                entityId,
                ContinuityMemoryService.PULSE_USER_ID,
                turn
            );
        } catch (error) {
            logger.error(`Failed to record pulse turn: ${error.message}`);
        }
    }

    /**
     * Trigger synthesis after a pulse wake completes.
     * Runs turn synthesis + compass synthesis on the entity-level episodic stream.
     * Uses null userId for memory storage so memories are entity-level.
     *
     * @param {string} entityId
     * @param {Object} context
     * @param {string} context.aiName
     */
    async triggerPulseSynthesis(entityId, context = {}) {
        const key = `${entityId}:__pulse__`;

        if (this.pendingSynthesis.has(key)) {
            return;
        }

        this.pendingSynthesis.set(key, true);

        setImmediate(async () => {
            try {
                // Get recent pulse episodic buffer
                const episodicBuffer = await this.hotMemory.getEpisodicStream(
                    entityId,
                    ContinuityMemoryService.PULSE_USER_ID,
                    10
                );

                if (episodicBuffer.length < 2) {
                    return;
                }

                // Run turn synthesis — stores memories with null userId (entity-level)
                const result = await this.synthesizer.synthesizeTurn(
                    entityId,
                    null, // Entity-level memories
                    episodicBuffer,
                    context
                );

                const totalNewMemories =
                    result.newAnchors.length +
                    result.newArtifacts.length +
                    result.identityUpdates.length +
                    result.shorthands.length;

                if (totalNewMemories > 0) {
                    logger.debug(`Pulse synthesis created ${totalNewMemories} entity-level memories`);
                    continuityLog.synthesize('pulse_turn_synthesis', entityId, null, {
                        newMemories: totalNewMemories,
                        stats: {
                            anchors: result.newAnchors.length,
                            artifacts: result.newArtifacts.length,
                            identity: result.identityUpdates.length,
                            shorthands: result.shorthands.length
                        }
                    });
                }

                // Eidos introspection + entity-level Internal Compass update
                await this._processEidosAndCompass(
                    entityId,
                    ContinuityMemoryService.PULSE_USER_ID,
                    result,
                    context,
                    { compassUserId: null } // Entity-level compass
                );
            } catch (error) {
                logger.error(`Pulse synthesis failed: ${error.message}`);
            } finally {
                this.pendingSynthesis.delete(key);
            }
        });
    }

    /**
     * Handle pulse rest — run sleep synthesis when entity calls EndPulse.
     * Integrates with the existing sleep/deep synthesis cycle.
     *
     * @param {string} entityId
     * @param {Object} context
     * @param {string} context.aiName
     * @param {number} [context.recentPulseCount] - How many pulses since last rest
     */
    async handlePulseRest(entityId, context = {}) {
        try {
            // 1. Synthesize compass from the full pulse episodic buffer
            const episodicBuffer = await this.hotMemory.getEpisodicStream(
                entityId,
                ContinuityMemoryService.PULSE_USER_ID,
                DEFAULT_CONFIG.internalCompass?.fullBufferForSessionEnd || 30
            );

            if (episodicBuffer.length >= (DEFAULT_CONFIG.internalCompass?.minTurnsForSynthesis || 2)) {
                logger.info(`Pulse rest — synthesizing compass from ${episodicBuffer.length} pulse turns`);

                await this.synthesizer.synthesizeInternalCompass(
                    entityId,
                    null, // Entity-level
                    episodicBuffer,
                    {
                        aiName: context.aiName || 'Entity',
                        sessionEnding: true
                    }
                );
            }

            // 2. Run deep synthesis if enough material has accumulated
            const recentPulseCount = context.recentPulseCount || 0;
            if (recentPulseCount >= 4 && DEFAULT_CONFIG.deepSynthesis?.runOnSessionEnd !== false) {
                setImmediate(async () => {
                    try {
                        logger.info(`Pulse rest — running deep synthesis (${recentPulseCount} recent pulses)`);
                        continuityLog.synthesize('pulse_deep_synthesis', entityId, null, {
                            stats: { trigger: 'pulse_rest', recentPulseCount }
                        });

                        const deepResult = await this.synthesizer.runDeepSynthesis(
                            entityId,
                            null, // Entity-level memories
                            {
                                maxMemories: DEFAULT_CONFIG.deepSynthesis?.maxMemoriesPerRun || 30,
                                daysToLookBack: DEFAULT_CONFIG.deepSynthesis?.daysToLookBack || 7
                            }
                        );

                        if (deepResult.consolidated > 0 || deepResult.patterns > 0) {
                            logger.info(`Pulse deep synthesis: ${deepResult.consolidated} consolidated, ${deepResult.patterns} patterns`);
                        }
                    } catch (deepError) {
                        logger.warn(`Pulse deep synthesis failed: ${deepError.message}`);
                    }
                });
            }

            // 3. Clear pulse episodic stream after synthesis
            await this.hotMemory.clearEpisodicStream(
                entityId,
                ContinuityMemoryService.PULSE_USER_ID
            );

        } catch (error) {
            logger.error(`Pulse rest handling failed: ${error.message}`);
        }
    }

    /**
     * Get the entity-level Internal Compass (for pulse wakes)
     * @param {string} entityId
     * @returns {Promise<ContinuityMemoryNode|null>}
     */
    async getPulseCompass(entityId) {
        return this.synthesizer.getInternalCompass(entityId, null);
    }

    // ==================== DEEP SYNTHESIS ====================
    
    /**
     * Trigger deep synthesis (consolidation, pattern recognition)
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {string[]} [options.memoryIds] - Specific memory IDs to process (overrides normal selection)
     * @param {number} [options.maxMemories=50] - Max memories to analyze
     * @param {number} [options.daysToLookBack=7] - How far back to look
     * @returns {Promise<Object>}
     */
    async runDeepSynthesis(entityId, userId, options = {}) {
        return this.synthesizer.runDeepSynthesis(entityId, userId, options);
    }
    
    /**
     * Sleep-style synthesis - models human sleep consolidation
     * 
     * Instead of batch-processing random memories, this:
     * 1. Walks backward through unprocessed memories
     * 2. For each, finds similar/linked existing memories  
     * 3. Decides: ABSORB (delete), MERGE (combine), LINK (connect), or KEEP
     * 4. Marks as processed
     * 
     * More efficient and creates better connections than batch deep synthesis.
     * 
     * When memoryIds is provided, processes only those specific memories
     * instead of querying for unprocessed ones.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {string[]} [options.memoryIds] - Specific memory IDs to process (overrides normal selection)
     * @param {number} [options.windowSize=20] - Memories to fetch per batch
     * @param {number} [options.maxToProcess=100] - Total processing cap
     * @param {number} [options.maxLookbackDays=90] - How far back to look
     * @param {number} [options.similarityLimit=5] - Similar memories to compare
     * @returns {Promise<Object>} Stats: {absorbed, merged, linked, kept, processed, errors}
     */
    async runSleepSynthesis(entityId, userId, options = {}) {
        return this.synthesizer.runSleepSynthesis(entityId, userId, options);
    }
    
    /**
     * Get count of unprocessed memories (for progress tracking)
     * @param {string} entityId
     * @param {string} userId
     * @param {number} [maxLookbackDays] - Optional day limit
     * @returns {Promise<number>}
     */
    async getUnprocessedCount(entityId, userId, maxLookbackDays = null) {
        const since = maxLookbackDays 
            ? new Date(Date.now() - maxLookbackDays * 24 * 60 * 60 * 1000).toISOString()
            : null;
        return this.coldMemory.getUnprocessedCount(entityId, userId, since);
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

