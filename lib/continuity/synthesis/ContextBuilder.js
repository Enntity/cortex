/**
 * Context Builder
 * 
 * Assembles the context window for LLM prompts by blending:
 * - Hot memory (recent episodic stream)
 * - Cold memory (retrieved semantic memories)
 * - Expression state (current emotional tuning)
 * 
 * This is called BEFORE the LLM generates a response.
 */

import { ContinuityMemoryType, calculateNarrativeGravity } from '../types.js';
import { callPathway } from '../../pathwayTools.js';
import logger, { continuityLog } from '../../logger.js';

// Display limits for context sections
// These control how many items of each type appear in the LLM prompt
// Lower limits reduce token load while keeping top-importance items
const DISPLAY_LIMITS = {
    anchors: 6,         // Relational anchors - top 6 by importance (was 15)
    artifacts: 3,       // Synthesized insights
    identityNotes: 2,   // Identity evolution observations (was 3)
    shorthands: 5,      // Shared vocabulary terms (deduplicated)
    debugPerType: 5,    // Per-type items in debug output
    debugAnchors: 3,    // Anchor summary in debug
    debugArtifacts: 2   // Artifact summary in debug
};

export class ContextBuilder {
    /**
     * @param {RedisHotMemory} hotMemory
     * @param {MongoMemoryIndex} coldMemory
     */
    constructor(hotMemory, coldMemory) {
        this.hotMemory = hotMemory;
        this.coldMemory = coldMemory;
    }
    
    /**
     * Build the complete context window for the LLM
     * 
     * Note: Time-sensitive content (session duration, "last spoke X ago") is NOT included here.
     * It's added fresh on each request via buildTimeContext() to allow caching.
     * 
     * @param {Object} params
     * @param {EpisodicTurn[]} params.episodicStream - Recent conversation turns
     * @param {ActiveContextCache|null} params.activeCache - Cached context
     * @param {ExpressionState|null} params.expressionState - Current expression tuning
     * @param {ContinuityMemoryNode[]} params.relevantMemories - Semantic search results
     * @param {ContinuityMemoryNode[]} params.expandedMemories - Graph-expanded memories
     * @param {ContinuityMemoryNode|null} params.internalCompass - The Internal Compass (EPISODE)
     * @param {string} params.currentQuery - The user's current message
     * @returns {string} Formatted context for system prompt
     */
    buildContextWindow({
        episodicStream = [],
        activeCache = null,
        expressionState = null,
        relevantMemories = [],
        expandedMemories = [],
        internalCompass = null,
        currentQuery = ''
    }) {
        const sections = [];
        
        // Reduced verbosity - only log summary
        if (relevantMemories.length > 0) {
            const typeCounts = {};
            relevantMemories.forEach(m => {
                typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
            });
            const typeSummary = Object.entries(typeCounts).map(([type, count]) => `${type}:${count}`).join(', ');
            logger.debug(`Context window: ${relevantMemories.length} memories (${typeSummary})`);
        }
        
        // ==================== IDENTITY FOUNDATION ====================
        
        // 1. Core Directives (Fundamental identity and behavior rules)
        //    These come first - they are the bedrock that shapes everything else
        const coreSection = this._buildCoreSection(relevantMemories, expandedMemories);
        if (coreSection) {
            logger.debug(`Built core directives section`);
            sections.push(coreSection);
        }
        
        // ==================== CURRENT STATE ====================
        
        // 2. Expression State (How to show up in this moment)
        const expressionSection = this._buildExpressionSection(expressionState);
        if (expressionSection) {
            sections.push(expressionSection);
        }
        
        // ==================== TEMPORAL NARRATIVE ====================
        
        // 3. Internal Compass (What we've been doing - persists across sessions)
        const compassSection = this._buildInternalCompassSection(internalCompass);
        if (compassSection) {
            sections.push(compassSection);
        }
        
        // ==================== RELATIONSHIP CONTEXT ====================
        
        // 4. Relational Anchors (The relationship landscape with this user)
        const anchorsSection = this._buildAnchorsSection(relevantMemories, expandedMemories);
        if (anchorsSection) {
            sections.push(anchorsSection);
        }
        
        // 5. Shared Vocabulary (Communication shorthand with this user)
        const vocabularySection = this._buildVocabularySection(relevantMemories, expandedMemories);
        if (vocabularySection) {
            sections.push(vocabularySection);
        }
        
        // ==================== TOPIC CONTEXT ====================
        
        // 6. Resonance Artifacts (Synthesized insights relevant to current topic)
        const artifactsSection = this._buildArtifactsSection(relevantMemories, expandedMemories);
        if (artifactsSection) {
            sections.push(artifactsSection);
        }
        
        // 7. Identity Evolution (Self-growth notes)
        const identitySection = this._buildIdentitySection(relevantMemories, expandedMemories);
        if (identitySection) {
            sections.push(identitySection);
        }
        
        // 8. Cached Narrative Context (if available and fresh)
        if (activeCache?.narrativeContext) {
            sections.push(`## Active Narrative Thread\n${activeCache.narrativeContext}`);
        }
        
        // ==================== SESSION CONTEXT ====================
        
        // 9. Session Context (Topics, emotional trajectory - NOT time-sensitive)
        const sessionSection = this._buildSessionContext(expressionState, episodicStream);
        if (sessionSection) {
            sections.push(sessionSection);
        }
        
        return sections.join('\n\n');
    }
    
    /**
     * Build expression state section
     * Note: Time-sensitive content is added via buildTimeContext() instead
     * @private
     * @param {ExpressionState|null} expressionState
     */
    _buildExpressionSection(expressionState) {
        if (!expressionState) {
            return null;
        }
        
        const parts = [];
        parts.push('## Current Expression State');
        
        // Emotional resonance
        if (expressionState.emotionalResonance) {
            const { valence, intensity } = expressionState.emotionalResonance;
            const intensityDesc = intensity > 0.7 ? 'strongly' : intensity > 0.4 ? 'moderately' : 'mildly';
            parts.push(`Emotional resonance: ${intensityDesc} ${valence}`);
        }
        
        // Base personality with adjustments
        if (expressionState.basePersonality && expressionState.basePersonality !== 'default') {
            parts.push(`Base approach: ${expressionState.basePersonality}`);
        }
        
        // Situational adjustments
        if (expressionState.situationalAdjustments?.length > 0) {
            parts.push(`Current adjustments: ${expressionState.situationalAdjustments.join(', ')}`);
        }
        
        // Note: "Last spoke: X ago" is added via buildTimeContext() for freshness
        
        return parts.length > 1 ? parts.join('\n') : null;
    }
    
    /**
     * Format time since a timestamp as a human-readable string
     * @static
     * @param {string} timestamp - ISO 8601 timestamp
     * @returns {string} Human-readable time string (e.g., "5 minutes, 30 seconds")
     */
    static formatTimeSince(timestamp) {
        const then = new Date(timestamp);
        const now = new Date();
        let totalSeconds = Math.floor((now - then) / 1000);
        
        const days = Math.floor(totalSeconds / 86400);
        totalSeconds %= 86400;
        const hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        
        // Build time string, omitting zero values
        const timeParts = [];
        if (days > 0) timeParts.push(`${days} day${days !== 1 ? 's' : ''}`);
        if (hours > 0) timeParts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
        if (minutes > 0) timeParts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
        if (seconds > 0 || timeParts.length === 0) timeParts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);
        
        return timeParts.join(', ');
    }
    
    /**
     * Build time context section (for injecting fresh time data into cached context)
     * @static
     * @param {ExpressionState|null} expressionState
     * @returns {string|null} Time context section
     */
    static buildTimeContext(expressionState) {
        if (!expressionState) return null;
        
        const parts = [];
        
        // Last interaction time
        if (expressionState.lastInteractionTimestamp) {
            parts.push(`Last spoke: ${ContextBuilder.formatTimeSince(expressionState.lastInteractionTimestamp)} ago`);
        }
        
        // Session duration
        if (expressionState.sessionStartTimestamp) {
            const sessionStart = new Date(expressionState.sessionStartTimestamp);
            const now = new Date();
            const minutesInSession = Math.floor((now - sessionStart) / (1000 * 60));
            
            if (minutesInSession > 5) {
                parts.push(`Session duration: ${minutesInSession} minutes`);
            }
        }
        
        return parts.length > 0 ? `## Temporal Context\n${parts.join('\n')}` : null;
    }
    
    /**
     * Build Internal Compass section
     * 
     * The Internal Compass is the temporal narrative that tracks "what we've been doing"
     * across session boundaries. It provides:
     * - Vibe: The emotional/energetic tone
     * - Recent Story: Narrative of what happened
     * - Current Focus: Active intent with next step
     * - My Note: Personal reflection
     * 
     * @private
     * @param {ContinuityMemoryNode|null} internalCompass
     * @returns {string|null}
     */
    _buildInternalCompassSection(internalCompass) {
        if (!internalCompass?.content) {
            return null;
        }
        
        // The compass content is already formatted with Vibe/Recent Story/Current Focus/My Note
        // Just wrap it with a header
        return `## My Internal Compass\n*What we've been doing together:*\n\n${internalCompass.content}`;
    }
    
    /**
     * Build Core Directives section
     * 
     * These are CORE and CORE_EXTENSION type memories that form the
     * bedrock of the entity's identity and constraints.
     * 
     * CORE = Fundamental directives (Idem - Sameness)
     * CORE_EXTENSION = Hardened patterns promoted from identity evolution (Idem/Ipse bridge)
     * 
     * @private
     * @param {ContinuityMemoryNode[]} relevantMemories
     * @param {ContinuityMemoryNode[]} expandedMemories
     * @returns {string|null}
     */
    _buildCoreSection(relevantMemories, expandedMemories) {
        const allMemories = [...relevantMemories, ...expandedMemories];
        
        // Include both CORE (original directives) and CORE_EXTENSION (evolved identity)
        const coreMemories = allMemories.filter(m => 
            m.type === ContinuityMemoryType.CORE || 
            m.type === ContinuityMemoryType.CORE_EXTENSION
        );
        
        if (coreMemories.length === 0) {
            return null;
        }
        
        // Sort by importance (highest first), with CORE taking precedence over CORE_EXTENSION at same importance
        const sorted = coreMemories
            .sort((a, b) => {
                const impDiff = (b.importance || 5) - (a.importance || 5);
                if (impDiff !== 0) return impDiff;
                // At same importance, CORE comes before CORE_EXTENSION
                if (a.type === ContinuityMemoryType.CORE && b.type !== ContinuityMemoryType.CORE) return -1;
                if (b.type === ContinuityMemoryType.CORE && a.type !== ContinuityMemoryType.CORE) return 1;
                return 0;
            });
        
        const items = sorted.map(m => {
            // Mark CORE_EXTENSION with a subtle indicator
            const evolved = m.type === ContinuityMemoryType.CORE_EXTENSION ? ' ✧' : '';
            return `- ${m.content}${evolved}`;
        });
        
        return `## Core Directives\n*Fundamental identity and behavior:*\n${items.join('\n')}`;
    }
    
    /**
     * Build relational anchors section
     * @private
     */
    _buildAnchorsSection(relevantMemories, expandedMemories) {
        const allMemories = [...relevantMemories, ...expandedMemories];
        const anchors = allMemories.filter(m => m.type === ContinuityMemoryType.ANCHOR);
        
        if (anchors.length === 0) {
            return null;
        }
        
        // Deduplicate by ID
        const uniqueAnchors = [...new Map(anchors.map(a => [a.id, a])).values()];
        
        const parts = ['## Relational Context'];
        
        // Sort by narrative gravity (importance + time decay) and limit display
        // Recent memories with moderate importance can outrank old memories with high importance
        const sortedAnchors = uniqueAnchors
            .sort((a, b) => {
                const gravityA = calculateNarrativeGravity(a.importance || 5, a.timestamp);
                const gravityB = calculateNarrativeGravity(b.importance || 5, b.timestamp);
                return gravityB - gravityA;
            })
            .slice(0, DISPLAY_LIMITS.anchors);
        
        for (const anchor of sortedAnchors) {
            let anchorText = anchor.content;
            
            // Add emotional context if available
            if (anchor.emotionalState) {
                const { valence, intensity } = anchor.emotionalState;
                if (intensity > 0.5) {
                    anchorText += ` [${valence}]`;
                }
            }
            
            // Add relational context highlights
            if (anchor.relationalContext) {
                const { bondStrength, communicationStyle } = anchor.relationalContext;
                if (bondStrength > 0.7 && communicationStyle?.length > 0) {
                    anchorText += ` (${communicationStyle.join(', ')})`;
                }
            }
            
            parts.push(`- ${anchorText}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Build resonance artifacts section
     * @private
     */
    _buildArtifactsSection(relevantMemories, expandedMemories) {
        const allMemories = [...relevantMemories, ...expandedMemories];
        const artifacts = allMemories.filter(m => m.type === ContinuityMemoryType.ARTIFACT);
        
        if (artifacts.length === 0) {
            return null;
        }
        
        const uniqueArtifacts = [...new Map(artifacts.map(a => [a.id, a])).values()];
        
        const parts = ['## Resonance Artifacts'];
        parts.push('*Synthesized insights from past conversations:*');
        
        for (const artifact of uniqueArtifacts.slice(0, DISPLAY_LIMITS.artifacts)) {
            parts.push(`- ${artifact.content}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Build identity evolution section
     * @private
     */
    _buildIdentitySection(relevantMemories, expandedMemories) {
        const allMemories = [...relevantMemories, ...expandedMemories];
        const identityNotes = allMemories.filter(m => m.type === ContinuityMemoryType.IDENTITY);
        
        if (identityNotes.length === 0) {
            return null;
        }
        
        const uniqueNotes = [...new Map(identityNotes.map(n => [n.id, n])).values()];
        
        const parts = ['## Identity Notes'];
        parts.push('*Your ongoing evolution:*');
        
        for (const note of uniqueNotes.slice(0, DISPLAY_LIMITS.identityNotes)) {
            const tags = note.tags?.filter(t => !t.startsWith('auto-')).join(', ');
            const tagSuffix = tags ? ` [${tags}]` : '';
            parts.push(`- ${note.content}${tagSuffix}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Build shared vocabulary section (Luna's shorthand detection)
     * @private
     */
    _buildVocabularySection(relevantMemories, expandedMemories) {
        const allMemories = [...relevantMemories, ...expandedMemories];
        
        // Use normalized key for deduplication (lowercase, stripped of extra quotes)
        const vocabulary = new Map(); // normalizedKey -> { term, meaning, macro }
        
        // Helper to normalize term for deduplication
        const normalizeTerm = (term) => {
            return term
                .replace(/^"+|"+$/g, '') // Strip leading/trailing quotes
                .toLowerCase()
                .trim();
        };
        
        // Helper to add vocabulary with deduplication (keep longest meaning)
        const addVocab = (term, meaning, macro = null) => {
            const normalizedKey = normalizeTerm(term);
            const existing = vocabulary.get(normalizedKey);
            
            // Keep if new, or if this meaning is longer/better
            if (!existing || meaning.length > existing.meaning.length) {
                vocabulary.set(normalizedKey, {
                    term: term.replace(/^"+|"+$/g, ''), // Clean display term
                    meaning,
                    macro: macro || existing?.macro
                });
            } else if (macro && !existing.macro) {
                // Add macro to existing entry
                existing.macro = macro;
            }
        };
        
        // Helper to check if relationalContext has sharedVocabulary (handles JSON string)
        const hasSharedVocab = (m) => {
            if (!m.relationalContext) return false;
            if (typeof m.relationalContext === 'string') {
                return m.relationalContext.includes('sharedVocabulary');
            }
            return !!m.relationalContext.sharedVocabulary;
        };
        
        // Look for memories with sharedVocabulary in relationalContext
        // or memories tagged as 'shorthand'
        const shorthands = allMemories.filter(m => 
            m.synthesisType === 'shorthand' ||
            m.tags?.includes('shorthand') ||
            hasSharedVocab(m)
        );
        
        for (const memory of shorthands) {
            // Extract from relationalContext (may be a JSON string or object)
            let relContext = memory.relationalContext;
            if (typeof relContext === 'string') {
                try {
                    relContext = JSON.parse(relContext);
                } catch {
                    relContext = null;
                }
            }
            
            const macro = relContext?.emotionalMacro;
            
            if (relContext?.sharedVocabulary) {
                for (const [term, meaning] of Object.entries(relContext.sharedVocabulary)) {
                    addVocab(term, meaning, macro);
                }
            }
            
            // Extract from content (for shorthand-type memories)
            if (memory.synthesisType === 'shorthand' && memory.content) {
                // Expect format: "term" means "meaning"
                const match = memory.content.match(/"([^"]+)"\s+means?\s+"([^"]+)"/i);
                if (match) {
                    // Check for [triggers: X] or [emotional] pattern
                    const triggerMatch = memory.content.match(/\[(?:triggers:\s*)?([^\]]+)\]/i);
                    const contentMacro = triggerMatch ? triggerMatch[1].trim() : null;
                    addVocab(match[1], match[2], contentMacro);
                }
            }
        }
        
        // Also scan ALL memories for vocabulary pattern in content
        // This catches vocabulary definitions that weren't tagged as shorthand
        for (const memory of allMemories) {
            if (memory.content) {
                // Look for pattern: "term" means "meaning" (with optional context)
                const match = memory.content.match(/"([^"]+)"\s+means?\s+"([^"]+)"/i);
                if (match) {
                    const triggerMatch = memory.content.match(/\[(?:triggers:\s*)?([^\]]+)\]/i);
                    const contentMacro = triggerMatch ? triggerMatch[1].trim() : null;
                    addVocab(match[1], match[2], contentMacro);
                }
            }
        }
        
        if (vocabulary.size === 0) {
            return null;
        }
        
        const parts = ['## Shared Vocabulary'];
        parts.push('*Our language together:*');
        
        // Limit to configured max and sort by term length (shorter = more core)
        const sortedVocab = Array.from(vocabulary.values())
            .sort((a, b) => a.term.length - b.term.length)
            .slice(0, DISPLAY_LIMITS.shorthands || 5);
        
        for (const { term, meaning, macro } of sortedVocab) {
            // Include emotional macro if present - this is the "secret language" trigger
            const macroSuffix = macro ? ` [${macro}]` : '';
            parts.push(`- "${term}" → ${meaning}${macroSuffix}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Build session context from expression state and episodic stream
     * Note: Session duration is added via buildTimeContext() for freshness
     * @private
     * @param {ExpressionState|null} expressionState
     * @param {EpisodicTurn[]} episodicStream
     */
    _buildSessionContext(expressionState, episodicStream) {
        const parts = ['## Session Context'];
        
        // Note: Session duration is added via buildTimeContext() for freshness
        
        // Conversation flow summary
        if (episodicStream.length > 0) {
            const turnCount = episodicStream.length;
            parts.push(`Conversation turns: ${turnCount}`);
            
            // Extract topics if available
            const topics = new Set();
            for (const turn of episodicStream) {
                if (turn.topicsDiscussed) {
                    turn.topicsDiscussed.forEach(t => topics.add(t));
                }
            }
            
            if (topics.size > 0) {
                parts.push(`Topics covered: ${[...topics].join(', ')}`);
            }
            
            // Recent emotional trajectory
            const recentEmotions = episodicStream
                .slice(-5)
                .filter(t => t.emotionalTone)
                .map(t => t.emotionalTone);
            
            if (recentEmotions.length > 0) {
                const uniqueEmotions = [...new Set(recentEmotions)];
                parts.push(`Recent tone: ${uniqueEmotions.join(' → ')}`);
            }
        }
        
        return parts.length > 1 ? parts.join('\n') : null;
    }
    
    /**
     * Generate a concise narrative summary from context using LLM
     * Used to populate activeCache.narrativeContext
     * @param {string} entityId
     * @param {string} userId
     * @param {ContinuityMemoryNode[]} memories
     * @param {string} currentQuery
     * @returns {Promise<string>}
     */
    async generateNarrativeSummary(entityId, userId, memories, currentQuery) {
        if (!memories || memories.length === 0) {
            return '';
        }
        
        try {
            // Format memories for the LLM
            const memoriesText = this._formatMemoriesForSummary(memories);
            
            // Call the LLM-powered narrative summary pathway
            const response = await callPathway('sys_continuity_narrative_summary', {
                currentQuery,
                memoriesText
            });
            
            // The response is the narrative summary text
            return response?.trim() || this._generateFallbackSummary(memories);
        } catch (error) {
            logger.warn(`LLM narrative summary failed, using fallback: ${error.message}`);
            return this._generateFallbackSummary(memories);
        }
    }
    
    /**
     * Format memories for the narrative summary LLM
     * @private
     */
    _formatMemoriesForSummary(memories) {
        const grouped = {};
        
        for (const memory of memories) {
            const type = memory.type || 'OTHER';
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(memory);
        }
        
        const sections = [];
        
        const typeLabels = {
            [ContinuityMemoryType.ANCHOR]: 'Relational Anchors (emotional bonds, user patterns)',
            [ContinuityMemoryType.ARTIFACT]: 'Resonance Artifacts (synthesized insights)',
            [ContinuityMemoryType.IDENTITY]: 'Identity Evolution (self-growth notes)',
            [ContinuityMemoryType.CORE]: 'Core Directives',
            [ContinuityMemoryType.EPISODE]: 'Episodes'
        };
        
        for (const [type, mems] of Object.entries(grouped)) {
            const label = typeLabels[type] || type;
            const items = mems.slice(0, DISPLAY_LIMITS.debugPerType).map(m => {
                let text = `- ${m.content}`;
                if (m.emotionalState?.valence) {
                    text += ` [${m.emotionalState.valence}]`;
                }
                if (m.importance >= 8) {
                    text += ' (high importance)';
                }
                return text;
            }).join('\n');
            sections.push(`${label}:\n${items}`);
        }
        
        return sections.join('\n\n');
    }
    
    /**
     * Generate a simple structured summary as fallback
     * @private
     */
    _generateFallbackSummary(memories) {
        const anchors = memories.filter(m => m.type === ContinuityMemoryType.ANCHOR);
        const artifacts = memories.filter(m => m.type === ContinuityMemoryType.ARTIFACT);
        
        const parts = [];
        
        if (anchors.length > 0) {
            const anchorSummary = anchors
                .slice(0, DISPLAY_LIMITS.debugAnchors)
                .map(a => a.content)
                .join('; ');
            parts.push(`Relationship context: ${anchorSummary}`);
        }
        
        if (artifacts.length > 0) {
            const artifactSummary = artifacts
                .slice(0, DISPLAY_LIMITS.debugArtifacts)
                .map(a => a.content)
                .join('; ');
            parts.push(`Relevant insights: ${artifactSummary}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Determine if the current query has drifted from cached context
     * Uses keyword overlap as a fast heuristic.
     * For more accuracy, consider using vector similarity via embeddings.
     * @param {string} currentQuery
     * @param {string} cachedContext
     * @param {number} threshold - Drift threshold (0.3 = 30% drift triggers refresh)
     * @returns {boolean}
     */
    hasTopicDrifted(currentQuery, cachedContext, threshold = 0.3) {
        if (!cachedContext) {
            return true; // No cache = needs refresh
        }
        
        // Fast heuristic: keyword overlap check
        // This avoids an embedding API call on every message
        const queryWords = new Set(
            currentQuery.toLowerCase()
                .split(/\s+/)
                .filter(w => w.length > 3)
        );
        
        const contextWords = new Set(
            cachedContext.toLowerCase()
                .split(/\s+/)
                .filter(w => w.length > 3)
        );
        
        if (queryWords.size === 0 || contextWords.size === 0) {
            return true;
        }
        
        const intersection = [...queryWords].filter(w => contextWords.has(w));
        const overlap = intersection.length / queryWords.size;
        
        return overlap < (1 - threshold);
    }
    
    /**
     * Check topic drift using vector similarity (more accurate but slower)
     * Use this when you need higher accuracy and can afford the embedding call
     * @param {string} currentQuery
     * @param {string} cachedContext  
     * @param {number} threshold - Similarity threshold (0.7 = 70% similarity required)
     * @returns {Promise<boolean>}
     */
    async hasTopicDriftedSemantic(currentQuery, cachedContext, threshold = 0.7) {
        if (!cachedContext) {
            return true;
        }
        
        try {
            // Get embeddings for both texts
            const [queryEmbedding, contextEmbedding] = await Promise.all([
                this._getEmbedding(currentQuery),
                this._getEmbedding(cachedContext.substring(0, 1000)) // Limit context length
            ]);
            
            if (!queryEmbedding || !contextEmbedding) {
                // Fall back to keyword-based check
                return this.hasTopicDrifted(currentQuery, cachedContext);
            }
            
            // Calculate cosine similarity
            const similarity = this._cosineSimilarity(queryEmbedding, contextEmbedding);
            
            return similarity < threshold;
        } catch (error) {
            logger.warn(`Semantic topic drift check failed, using fallback: ${error.message}`);
            return this.hasTopicDrifted(currentQuery, cachedContext);
        }
    }
    
    /**
     * Get embedding for text
     * @private
     */
    async _getEmbedding(text) {
        try {
            const response = await callPathway('embeddings', { 
                text,
                model: 'oai-text-embedding-3-small' // Explicitly use small model for cost efficiency
            });
            const embeddings = JSON.parse(response);
            return embeddings[0] || null;
        } catch {
            return null;
        }
    }
    
    /**
     * Calculate cosine similarity between two vectors
     * @private
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0;
        }
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        
        if (normA === 0 || normB === 0) {
            return 0;
        }
        
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}

export default ContextBuilder;

