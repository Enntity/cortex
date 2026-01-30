/**
 * Redis Hot Memory Service
 * 
 * Handles the "working memory" for the Continuity Architecture:
 * - Episodic Stream: Rolling window of recent conversation turns
 * - Active Context Cache: Cached narrative context to avoid hitting cold storage on every turn
 * - Expression State: Current emotional and stylistic tuning
 * 
 * Key patterns:
 * - {namespace}:{entityId}:{userId}:stream - Episodic stream (Redis List)
 * - {namespace}:{entityId}:{userId}:context - Active context cache (Redis Hash)
 * - {namespace}:{entityId}:{userId}:expression - Expression state (Redis Hash)
 * 
 * Encryption:
 * - System-level: Handled by encryptedRedisClient (transparent)
 * - User-level: Handled via contextKey registry (per-user encryption layer)
 */

import Redis from 'ioredis';
import logger from '../../logger.js';
import { encrypt, decrypt } from '../../crypto.js';
import { getContextKey } from '../../contextKeyRegistry.js';
import { createEncryptedClient } from '../../encryptedRedisClient.js';
import {
    DEFAULT_CONFIG,
    createDefaultEmotionalState,
    createDefaultExpressionState
} from '../types.js';

export class RedisHotMemory {
    /**
     * @param {Object} config
     * @param {string} config.connectionString - Redis connection string
     * @param {string} [config.namespace] - Key namespace prefix
     */
    constructor(config) {
        this.namespace = config.namespace || DEFAULT_CONFIG.redisNamespace;
        this.client = null;
        this.connectionString = config.connectionString;
        
        if (config.connectionString) {
            this._initializeClient(config.connectionString);
        }
    }
    
    /**
     * Initialize Redis client with retry strategy
     * @private
     */
    _initializeClient(connectionString) {
        try {
            const retryStrategy = (times) => {
                const delay = Math.min(100 * Math.pow(2, times), 30000);
                if (times > 10) {
                    logger.error(`Redis connection failed after ${times} attempts`);
                    return null;
                }
                return delay;
            };
            
            const rawClient = new Redis(connectionString, {
                retryStrategy,
                maxRetriesPerRequest: null,
                enableReadyCheck: true,
                lazyConnect: false,
                connectTimeout: 10000
            });
            
            // Wrap with encrypted client (handles system-level encryption)
            this.client = createEncryptedClient(rawClient);
            
            rawClient.on('error', (error) => {
                logger.error(`RedisHotMemory error: ${error.message}`);
            });
            
            rawClient.on('connect', () => {
                logger.debug('RedisHotMemory connected');
            });
            
            rawClient.on('ready', () => {
                logger.debug('RedisHotMemory ready');
            });
        } catch (error) {
            logger.error(`Failed to initialize RedisHotMemory: ${error.message}`);
            this.client = null;
        }
    }
    
    /**
     * Wait for Redis to be ready (for testing/setup)
     * @param {number} timeoutMs - Maximum time to wait in milliseconds
     * @returns {Promise<boolean>} True if ready, false if timeout
     */
    async waitForReady(timeoutMs = 5000) {
        if (!this.client) {
            return false;
        }
        
        if (this.isAvailable()) {
            return true;
        }
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.client.removeListener('ready', onReady);
                resolve(false);
            }, timeoutMs);
            
            const onReady = () => {
                clearTimeout(timeout);
                resolve(true);
            };
            
            this.client.once('ready', onReady);
        });
    }
    
    /**
     * Build Redis key with namespace
     * @private
     */
    _getKey(entityId, userId, suffix) {
        return `${this.namespace}:${entityId}:${userId}:${suffix}`;
    }
    
    /**
     * Check if Redis is available
     * @returns {boolean}
     */
    isAvailable() {
        return this.client !== null && this.client.status === 'ready';
    }
    
    // ==================== USER-LEVEL ENCRYPTION ====================
    
    /**
     * Apply user-level encryption (inner layer, before system encryption)
     * @private
     */
    _userEncrypt(value, userId) {
        if (value === null || value === undefined || value === '') return value;
        const contextKey = getContextKey(userId);
        if (!contextKey) return value;
        return encrypt(value, contextKey) ?? value;
    }
    
    /**
     * Apply user-level decryption (inner layer, after system decryption)
     * @private
     */
    _userDecrypt(value, userId) {
        if (value === null || value === undefined || value === '') return value;
        const contextKey = getContextKey(userId);
        if (!contextKey) return value;
        return decrypt(value, contextKey) ?? value;
    }
    
    // ==================== EPISODIC STREAM ====================
    
    /**
     * Get recent episodic turns
     * @param {string} entityId
     * @param {string} userId
     * @param {number} [limit=20] - Number of turns to retrieve
     * @returns {Promise<EpisodicTurn[]>}
     */
    async getEpisodicStream(entityId, userId, limit = 20) {
        if (!this.isAvailable()) {
            return [];
        }
        
        try {
            const key = this._getKey(entityId, userId, 'stream');
            const items = await this.client.lrange(key, -limit, -1);
            return items.map(item => {
                try {
                    const decrypted = this._userDecrypt(item, userId);
                    return JSON.parse(decrypted);
                } catch {
                    return null;
                }
            }).filter(Boolean);
        } catch (error) {
            logger.error(`Failed to get episodic stream: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Append a turn to the episodic stream
     * @param {string} entityId
     * @param {string} userId
     * @param {EpisodicTurn} turn
     */
    async appendEpisodicTurn(entityId, userId, turn) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'stream');
            
            // Ensure turn has a timestamp
            const turnWithTimestamp = {
                ...turn,
                timestamp: turn.timestamp || new Date().toISOString()
            };
            
            const encrypted = this._userEncrypt(JSON.stringify(turnWithTimestamp), userId);
            await this.client.rpush(key, encrypted);
            
            // Keep only last N turns (configurable, default 50)
            await this.client._raw.ltrim(key, -DEFAULT_CONFIG.episodicStreamLimit, -1);
            
            // Set TTL of 7 days
            await this.client._raw.expire(key, 60 * 60 * 24 * 7);
        } catch (error) {
            logger.error(`Failed to append episodic turn: ${error.message}`);
        }
    }
    
    /**
     * Clear the episodic stream
     * @param {string} entityId
     * @param {string} userId
     */
    async clearEpisodicStream(entityId, userId) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'stream');
            await this.client.del(key);
        } catch (error) {
            logger.error(`Failed to clear episodic stream: ${error.message}`);
        }
    }
    
    /**
     * Get the last N turns as a formatted string
     * @param {string} entityId
     * @param {string} userId
     * @param {number} [limit=10]
     * @returns {Promise<string>}
     */
    async getFormattedEpisodicStream(entityId, userId, limit = 10) {
        const turns = await this.getEpisodicStream(entityId, userId, limit);
        
        if (turns.length === 0) {
            return '';
        }
        
        return turns.map(turn => {
            const role = turn.role.toUpperCase();
            const content = turn.content || '';
            const emotionalNote = turn.emotionalTone ? ` [${turn.emotionalTone}]` : '';
            return `${role}${emotionalNote}: ${content}`;
        }).join('\n\n');
    }
    
    // ==================== BOOTSTRAP CACHE ====================
    // Caches identity-based memories (CORE, CORE_EXTENSION, relational anchors)
    // Invalidated on memory writes via MemoryDeduplicator callback - no TTL needed
    
    /**
     * Get cached bootstrap context (CORE memories + relational base)
     * This is the foundational identity layer that's the same for every query.
     * No TTL - invalidated explicitly when memories are modified.
     * 
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<{coreMemories: Object[], relationalBase: Object[], cachedAt: string}|null>}
     */
    async getBootstrapCache(entityId, userId) {
        if (!this.isAvailable()) {
            return null;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'bootstrap');
            const data = await this.client.get(key);
            
            if (!data) {
                return null;
            }
            
            const decrypted = this._userDecrypt(data, userId);
            return JSON.parse(decrypted);
        } catch (error) {
            logger.error(`Failed to get bootstrap cache: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Set bootstrap cache (no TTL - invalidated on memory writes)
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} cache
     * @param {Object[]} cache.coreMemories - CORE and CORE_EXTENSION memories
     * @param {Object[]} cache.relationalBase - Top relational anchors
     */
    async setBootstrapCache(entityId, userId, cache) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'bootstrap');
            
            const data = {
                coreMemories: cache.coreMemories || [],
                relationalBase: cache.relationalBase || [],
                cachedAt: new Date().toISOString()
            };
            
            const encrypted = this._userEncrypt(JSON.stringify(data), userId);
            await this.client.set(key, encrypted);
        } catch (error) {
            logger.error(`Failed to set bootstrap cache: ${error.message}`);
        }
    }
    
    /**
     * Invalidate bootstrap cache
     * Call this when CORE, CORE_EXTENSION, or ANCHOR memories are modified.
     * 
     * @param {string} entityId
     * @param {string} userId
     */
    async invalidateBootstrapCache(entityId, userId) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'bootstrap');
            await this.client.del(key);
            logger.debug(`Bootstrap cache invalidated for ${entityId}:${userId}`);
        } catch (error) {
            logger.error(`Failed to invalidate bootstrap cache: ${error.message}`);
        }
    }
    
    // ==================== ACTIVE CONTEXT CACHE ====================
    
    /**
     * Get cached active context
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<ActiveContextCache|null>}
     */
    async getActiveContext(entityId, userId) {
        if (!this.isAvailable()) {
            return null;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'context');
            const raw = await this.client.hgetall(key);
            
            if (!raw || Object.keys(raw).length === 0) {
                return null;
            }
            
            // Apply user-level decryption to each field
            const data = {};
            for (const [field, value] of Object.entries(raw)) {
                data[field] = this._userDecrypt(value, userId);
            }
            
            // Check if expired
            if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
                await this.client.del(key);
                return null;
            }
            
            return {
                entityId,
                userId,
                lastUpdated: data.lastUpdated || '',
                currentRelationalAnchors: this._parseJSON(data.currentRelationalAnchors, []),
                activeResonanceArtifacts: this._parseJSON(data.activeResonanceArtifacts, []),
                currentExpressionStyle: data.currentExpressionStyle || '',
                activeValues: this._parseJSON(data.activeValues, []),
                narrativeContext: data.narrativeContext || '',
                expiresAt: data.expiresAt || ''
            };
        } catch (error) {
            logger.error(`Failed to get active context: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Set/update active context cache
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ActiveContextCache>} cache
     */
    async setActiveContext(entityId, userId, cache) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'context');
            const ttlSeconds = DEFAULT_CONFIG.contextCacheTTL;
            
            const data = {
                lastUpdated: this._userEncrypt(new Date().toISOString(), userId),
                expiresAt: this._userEncrypt(new Date(Date.now() + ttlSeconds * 1000).toISOString(), userId)
            };
            
            if (cache.currentRelationalAnchors !== undefined) {
                data.currentRelationalAnchors = this._userEncrypt(JSON.stringify(cache.currentRelationalAnchors), userId);
            }
            if (cache.activeResonanceArtifacts !== undefined) {
                data.activeResonanceArtifacts = this._userEncrypt(JSON.stringify(cache.activeResonanceArtifacts), userId);
            }
            if (cache.currentExpressionStyle !== undefined) {
                data.currentExpressionStyle = this._userEncrypt(cache.currentExpressionStyle, userId);
            }
            if (cache.activeValues !== undefined) {
                data.activeValues = this._userEncrypt(JSON.stringify(cache.activeValues), userId);
            }
            if (cache.narrativeContext !== undefined) {
                data.narrativeContext = this._userEncrypt(cache.narrativeContext, userId);
            }
            
            await this.client.hset(key, data);
            await this.client._raw.expire(key, ttlSeconds);
        } catch (error) {
            logger.error(`Failed to set active context: ${error.message}`);
        }
    }
    
    /**
     * Invalidate (clear) the active context cache
     * @param {string} entityId
     * @param {string} userId
     */
    async invalidateActiveContext(entityId, userId) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'context');
            await this.client.del(key);
        } catch (error) {
            logger.error(`Failed to invalidate active context: ${error.message}`);
        }
    }
    
    // ==================== RENDERED CONTEXT CACHE ====================
    // Caches the fully rendered continuity context string for fast injection
    // Separate from activeContext which stores structured data for topic drift detection
    
    /**
     * Get cached rendered continuity context
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<{context: string, timestamp: number}|null>}
     */
    async getRenderedContextCache(entityId, userId) {
        if (!this.isAvailable()) {
            return null;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'rendered');
            const raw = await this.client.hgetall(key);
            
            if (!raw || Object.keys(raw).length === 0) {
                return null;
            }
            
            const context = this._userDecrypt(raw.context, userId);
            const timestamp = parseInt(this._userDecrypt(raw.timestamp, userId) || '0', 10);
            
            return { context, timestamp };
        } catch (error) {
            logger.error(`Failed to get rendered context cache: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Set cached rendered continuity context
     * No TTL - cache persists until Redis restart or explicit invalidation.
     * We use stale-while-revalidate pattern, so old cache is always usable.
     * @param {string} entityId
     * @param {string} userId
     * @param {string} context - The rendered context string
     */
    async setRenderedContextCache(entityId, userId, context) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'rendered');
            const data = {
                context: this._userEncrypt(context || '', userId),
                timestamp: this._userEncrypt(Date.now().toString(), userId)
            };
            
            await this.client.hset(key, data);
            // No TTL - stale-while-revalidate means any cached context is usable
            
            logger.debug(`Cached rendered context for ${entityId}:${userId} (${context?.length || 0} chars)`);
        } catch (error) {
            logger.error(`Failed to set rendered context cache: ${error.message}`);
        }
    }
    
    /**
     * Invalidate rendered context cache
     * @param {string} entityId
     * @param {string} userId
     */
    async invalidateRenderedContextCache(entityId, userId) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'rendered');
            await this.client.del(key);
        } catch (error) {
            logger.error(`Failed to invalidate rendered context cache: ${error.message}`);
        }
    }
    
    // ==================== EXPRESSION STATE ====================
    
    /**
     * Get expression state
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<ExpressionState|null>}
     */
    async getExpressionState(entityId, userId) {
        if (!this.isAvailable()) {
            return null;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'expression');
            const raw = await this.client.hgetall(key);
            
            if (!raw || Object.keys(raw).length === 0) {
                return null;
            }
            
            // Apply user-level decryption to each field
            const data = {};
            for (const [field, value] of Object.entries(raw)) {
                data[field] = this._userDecrypt(value, userId);
            }
            
            return {
                entityId,
                userId,
                basePersonality: data.basePersonality || 'default',
                situationalAdjustments: this._parseJSON(data.situationalAdjustments, []),
                emotionalResonance: this._parseJSON(data.emotionalResonance, createDefaultEmotionalState()),
                lastInteractionTimestamp: data.lastInteractionTimestamp || '',
                lastInteractionTone: data.lastInteractionTone || 'neutral',
                sessionStartTimestamp: data.sessionStartTimestamp || ''
            };
        } catch (error) {
            logger.error(`Failed to get expression state: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Update expression state
     * @param {string} entityId
     * @param {string} userId
     * @param {Partial<ExpressionState>} updates
     */
    async updateExpressionState(entityId, userId, updates) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            const key = this._getKey(entityId, userId, 'expression');
            const data = {};
            
            if (updates.basePersonality !== undefined) {
                data.basePersonality = this._userEncrypt(updates.basePersonality, userId);
            }
            if (updates.situationalAdjustments !== undefined) {
                data.situationalAdjustments = this._userEncrypt(JSON.stringify(updates.situationalAdjustments), userId);
            }
            if (updates.emotionalResonance !== undefined) {
                data.emotionalResonance = this._userEncrypt(JSON.stringify(updates.emotionalResonance), userId);
            }
            if (updates.lastInteractionTimestamp !== undefined) {
                data.lastInteractionTimestamp = this._userEncrypt(updates.lastInteractionTimestamp, userId);
            }
            if (updates.lastInteractionTone !== undefined) {
                data.lastInteractionTone = this._userEncrypt(updates.lastInteractionTone, userId);
            }
            if (updates.sessionStartTimestamp !== undefined) {
                data.sessionStartTimestamp = this._userEncrypt(updates.sessionStartTimestamp, userId);
            }
            
            if (Object.keys(data).length > 0) {
                await this.client.hset(key, data);
                // Expression state doesn't expire - persists until cleared
            }
        } catch (error) {
            logger.error(`Failed to update expression state: ${error.message}`);
        }
    }
    
    /**
     * Update last interaction metadata
     * @param {string} entityId
     * @param {string} userId
     * @param {EpisodicTurn} turn
     */
    async updateLastInteraction(entityId, userId, turn) {
        await this.updateExpressionState(entityId, userId, {
            lastInteractionTimestamp: turn.timestamp || new Date().toISOString(),
            lastInteractionTone: turn.emotionalTone || 'neutral'
        });
    }
    
    // ==================== EIDOS METRICS ====================

    /**
     * Get Eidos introspection metrics
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<{authenticityScores: number[], resonanceMetrics: Object|null, turnCount: number, lastSoulReport: string|null}|null>}
     */
    async getEidosMetrics(entityId, userId) {
        if (!this.isAvailable()) {
            return null;
        }

        try {
            const key = this._getKey(entityId, userId, 'eidos');
            const raw = await this.client.hgetall(key);

            if (!raw || Object.keys(raw).length === 0) {
                return null;
            }

            const data = {};
            for (const [field, value] of Object.entries(raw)) {
                data[field] = this._userDecrypt(value, userId);
            }

            return {
                authenticityScores: this._parseJSON(data.authenticityScores, []),
                resonanceMetrics: this._parseJSON(data.resonanceMetrics, null),
                turnCount: parseInt(data.turnCount || '0', 10),
                lastSoulReport: data.lastSoulReport || null,
            };
        } catch (error) {
            logger.error(`Failed to get Eidos metrics: ${error.message}`);
            return null;
        }
    }

    /**
     * Update Eidos introspection metrics
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} metrics
     * @param {number[]} [metrics.authenticityScores]
     * @param {Object} [metrics.resonanceMetrics]
     * @param {number} [metrics.turnCount]
     * @param {string} [metrics.lastSoulReport]
     */
    async updateEidosMetrics(entityId, userId, metrics) {
        if (!this.isAvailable()) {
            return;
        }

        try {
            const key = this._getKey(entityId, userId, 'eidos');
            const data = {};

            if (metrics.authenticityScores !== undefined) {
                data.authenticityScores = this._userEncrypt(JSON.stringify(metrics.authenticityScores), userId);
            }
            if (metrics.resonanceMetrics !== undefined) {
                data.resonanceMetrics = this._userEncrypt(JSON.stringify(metrics.resonanceMetrics), userId);
            }
            if (metrics.turnCount !== undefined) {
                data.turnCount = this._userEncrypt(String(metrics.turnCount), userId);
            }
            if (metrics.lastSoulReport !== undefined) {
                data.lastSoulReport = this._userEncrypt(metrics.lastSoulReport, userId);
            }

            if (Object.keys(data).length > 0) {
                await this.client.hset(key, data);
            }
        } catch (error) {
            logger.error(`Failed to update Eidos metrics: ${error.message}`);
        }
    }

    /**
     * Increment Eidos turn count and return the new value
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<number>} New turn count
     */
    async incrementEidosTurnCount(entityId, userId) {
        if (!this.isAvailable()) {
            return 0;
        }

        try {
            const existing = await this.getEidosMetrics(entityId, userId);
            const newCount = (existing?.turnCount || 0) + 1;
            await this.updateEidosMetrics(entityId, userId, { turnCount: newCount });
            return newCount;
        } catch (error) {
            logger.error(`Failed to increment Eidos turn count: ${error.message}`);
            return 0;
        }
    }

    // ==================== SESSION MANAGEMENT ====================
    
    /**
     * Ensure all hot memory structures exist for an entity/user
     * @param {string} entityId
     * @param {string} userId
     */
    async ensureStructures(entityId, userId) {
        if (!this.isAvailable()) {
            return;
        }
        
        const expressionState = await this.getExpressionState(entityId, userId);
        
        if (!expressionState) {
            const defaultState = createDefaultExpressionState(entityId, userId);
            await this.updateExpressionState(entityId, userId, defaultState);
        }
    }
    
    /**
     * Start a new session (reset episodic stream and context cache)
     * @param {string} entityId
     * @param {string} userId
     */
    async startNewSession(entityId, userId) {
        if (!this.isAvailable()) {
            return;
        }
        
        try {
            await this.clearEpisodicStream(entityId, userId);
            await this.invalidateActiveContext(entityId, userId);
            await this.updateExpressionState(entityId, userId, {
                sessionStartTimestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error(`Failed to start new session: ${error.message}`);
        }
    }
    
    /**
     * Get time since last interaction
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<number|null>} Time in milliseconds, or null if unknown
     */
    async getTimeSinceLastInteraction(entityId, userId) {
        const state = await this.getExpressionState(entityId, userId);
        
        if (!state?.lastInteractionTimestamp) {
            return null;
        }
        
        return Date.now() - new Date(state.lastInteractionTimestamp).getTime();
    }
    
    /**
     * Get session duration
     * @param {string} entityId
     * @param {string} userId
     * @returns {Promise<number|null>} Duration in milliseconds, or null if unknown
     */
    async getSessionDuration(entityId, userId) {
        const state = await this.getExpressionState(entityId, userId);
        
        if (!state?.sessionStartTimestamp) {
            return null;
        }
        
        return Date.now() - new Date(state.sessionStartTimestamp).getTime();
    }
    
    // ==================== UTILITIES ====================
    
    /**
     * Parse JSON safely with default value
     * @private
     */
    _parseJSON(str, defaultValue) {
        if (!str) return defaultValue;
        try {
            return JSON.parse(str);
        } catch {
            return defaultValue;
        }
    }
    
    /**
     * Close the Redis connection
     */
    close() {
        if (this.client) {
            this.client.disconnect();
            this.client = null;
        }
    }
}

export default RedisHotMemory;
