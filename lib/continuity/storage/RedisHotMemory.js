/**
 * Redis Hot Memory Service
 * 
 * Handles the "working memory" for the Continuity Architecture:
 * - Episodic Stream: Rolling window of recent conversation turns
 * - Active Context Cache: Cached narrative context to avoid hitting Azure on every turn
 * - Expression State: Current emotional and stylistic tuning
 * 
 * Key patterns:
 * - {namespace}:{entityId}:{userId}:stream - Episodic stream (Redis List)
 * - {namespace}:{entityId}:{userId}:context - Active context cache (Redis Hash)
 * - {namespace}:{entityId}:{userId}:expression - Expression state (Redis Hash)
 */

import Redis from 'ioredis';
import logger from '../../logger.js';
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
            
            this.client = new Redis(connectionString, {
                retryStrategy,
                maxRetriesPerRequest: null,
                enableReadyCheck: true,
                lazyConnect: false,
                connectTimeout: 10000
            });
            
            this.client.on('error', (error) => {
                logger.error(`RedisHotMemory error: ${error.message}`);
            });
            
            this.client.on('connect', () => {
                logger.debug('RedisHotMemory connected');
            });
        } catch (error) {
            logger.error(`Failed to initialize RedisHotMemory: ${error.message}`);
            this.client = null;
        }
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
                    return JSON.parse(item);
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
            
            await this.client.rpush(key, JSON.stringify(turnWithTimestamp));
            
            // Keep only last N turns (configurable, default 50)
            await this.client.ltrim(key, -DEFAULT_CONFIG.episodicStreamLimit, -1);
            
            // Set TTL of 7 days
            await this.client.expire(key, 60 * 60 * 24 * 7);
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
            const data = await this.client.hgetall(key);
            
            if (!data || Object.keys(data).length === 0) {
                return null;
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
                lastUpdated: new Date().toISOString(),
                expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
            };
            
            if (cache.currentRelationalAnchors !== undefined) {
                data.currentRelationalAnchors = JSON.stringify(cache.currentRelationalAnchors);
            }
            if (cache.activeResonanceArtifacts !== undefined) {
                data.activeResonanceArtifacts = JSON.stringify(cache.activeResonanceArtifacts);
            }
            if (cache.currentExpressionStyle !== undefined) {
                data.currentExpressionStyle = cache.currentExpressionStyle;
            }
            if (cache.activeValues !== undefined) {
                data.activeValues = JSON.stringify(cache.activeValues);
            }
            if (cache.narrativeContext !== undefined) {
                data.narrativeContext = cache.narrativeContext;
            }
            
            await this.client.hset(key, data);
            await this.client.expire(key, ttlSeconds);
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
            const data = await this.client.hgetall(key);
            
            if (!data || Object.keys(data).length === 0) {
                return null;
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
                data.basePersonality = updates.basePersonality;
            }
            if (updates.situationalAdjustments !== undefined) {
                data.situationalAdjustments = JSON.stringify(updates.situationalAdjustments);
            }
            if (updates.emotionalResonance !== undefined) {
                data.emotionalResonance = JSON.stringify(updates.emotionalResonance);
            }
            if (updates.lastInteractionTimestamp !== undefined) {
                data.lastInteractionTimestamp = updates.lastInteractionTimestamp;
            }
            if (updates.lastInteractionTone !== undefined) {
                data.lastInteractionTone = updates.lastInteractionTone;
            }
            if (updates.sessionStartTimestamp !== undefined) {
                data.sessionStartTimestamp = updates.sessionStartTimestamp;
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
    async close() {
        if (this.client) {
            await this.client.quit();
            this.client = null;
        }
    }
}

export default RedisHotMemory;

