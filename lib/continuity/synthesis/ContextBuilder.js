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

import { ContinuityMemoryType } from '../types.js';
import logger from '../../logger.js';

export class ContextBuilder {
    /**
     * @param {RedisHotMemory} hotMemory
     * @param {AzureMemoryIndex} coldMemory
     */
    constructor(hotMemory, coldMemory) {
        this.hotMemory = hotMemory;
        this.coldMemory = coldMemory;
    }
    
    /**
     * Build the complete context window for the LLM
     * @param {Object} params
     * @param {EpisodicTurn[]} params.episodicStream - Recent conversation turns
     * @param {ActiveContextCache|null} params.activeCache - Cached context
     * @param {ExpressionState|null} params.expressionState - Current expression tuning
     * @param {ContinuityMemoryNode[]} params.relevantMemories - Semantic search results
     * @param {ContinuityMemoryNode[]} params.expandedMemories - Graph-expanded memories
     * @param {string} params.currentQuery - The user's current message
     * @returns {string} Formatted context for system prompt
     */
    buildContextWindow({
        episodicStream = [],
        activeCache = null,
        expressionState = null,
        relevantMemories = [],
        expandedMemories = [],
        currentQuery = ''
    }) {
        const sections = [];
        
        // 1. Expression State (How to show up)
        const expressionSection = this._buildExpressionSection(expressionState);
        if (expressionSection) {
            sections.push(expressionSection);
        }
        
        // 2. Relational Anchors (The relationship landscape)
        const anchorsSection = this._buildAnchorsSection(relevantMemories, expandedMemories);
        if (anchorsSection) {
            sections.push(anchorsSection);
        }
        
        // 3. Resonance Artifacts (Synthesized insights)
        const artifactsSection = this._buildArtifactsSection(relevantMemories, expandedMemories);
        if (artifactsSection) {
            sections.push(artifactsSection);
        }
        
        // 4. Identity Evolution (Self-growth notes)
        const identitySection = this._buildIdentitySection(relevantMemories, expandedMemories);
        if (identitySection) {
            sections.push(identitySection);
        }
        
        // 5. Shared Vocabulary (Luna's shorthand feature)
        const vocabularySection = this._buildVocabularySection(relevantMemories, expandedMemories);
        if (vocabularySection) {
            sections.push(vocabularySection);
        }
        
        // 6. Cached Narrative Context (if available and fresh)
        if (activeCache?.narrativeContext) {
            sections.push(`## Active Narrative Thread\n${activeCache.narrativeContext}`);
        }
        
        // 7. Session Context
        const sessionSection = this._buildSessionContext(expressionState, episodicStream);
        if (sessionSection) {
            sections.push(sessionSection);
        }
        
        return sections.join('\n\n');
    }
    
    /**
     * Build expression state section
     * @private
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
        
        // Time since last interaction
        if (expressionState.lastInteractionTimestamp) {
            const lastInteraction = new Date(expressionState.lastInteractionTimestamp);
            const now = new Date();
            const hoursSince = (now - lastInteraction) / (1000 * 60 * 60);
            
            if (hoursSince > 24) {
                const days = Math.floor(hoursSince / 24);
                parts.push(`Last spoke: ${days} day${days > 1 ? 's' : ''} ago`);
            } else if (hoursSince > 1) {
                parts.push(`Last spoke: ${Math.floor(hoursSince)} hour${hoursSince > 1 ? 's' : ''} ago`);
            }
        }
        
        return parts.length > 1 ? parts.join('\n') : null;
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
        
        for (const anchor of uniqueAnchors.slice(0, 5)) { // Limit to top 5
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
        
        for (const artifact of uniqueArtifacts.slice(0, 3)) { // Limit to top 3
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
        
        for (const note of uniqueNotes.slice(0, 3)) { // Limit to top 3
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
        
        // Look for memories with sharedVocabulary in relationalContext
        // or memories tagged as 'shorthand'
        const shorthands = allMemories.filter(m => 
            m.synthesisType === 'shorthand' ||
            m.tags?.includes('shorthand') ||
            m.relationalContext?.sharedVocabulary
        );
        
        if (shorthands.length === 0) {
            return null;
        }
        
        const vocabulary = new Map();
        
        for (const memory of shorthands) {
            // Extract from relationalContext
            if (memory.relationalContext?.sharedVocabulary) {
                for (const [term, meaning] of Object.entries(memory.relationalContext.sharedVocabulary)) {
                    vocabulary.set(term, meaning);
                }
            }
            
            // Extract from content (for shorthand-type memories)
            if (memory.synthesisType === 'shorthand' && memory.content) {
                // Expect format: "term" means "meaning"
                const match = memory.content.match(/"([^"]+)"\s+means?\s+"([^"]+)"/i);
                if (match) {
                    vocabulary.set(match[1], match[2]);
                }
            }
        }
        
        if (vocabulary.size === 0) {
            return null;
        }
        
        const parts = ['## Shared Vocabulary'];
        parts.push('*Our language together:*');
        
        for (const [term, meaning] of vocabulary) {
            parts.push(`- "${term}" → ${meaning}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Build session context from expression state and episodic stream
     * @private
     */
    _buildSessionContext(expressionState, episodicStream) {
        const parts = ['## Session Context'];
        
        // Session duration
        if (expressionState?.sessionStartTimestamp) {
            const sessionStart = new Date(expressionState.sessionStartTimestamp);
            const now = new Date();
            const minutesInSession = Math.floor((now - sessionStart) / (1000 * 60));
            
            if (minutesInSession > 5) {
                parts.push(`Session duration: ${minutesInSession} minutes`);
            }
        }
        
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
     * Generate a concise narrative summary from context
     * Used to populate activeCache.narrativeContext
     * @param {string} entityId
     * @param {string} userId
     * @param {ContinuityMemoryNode[]} memories
     * @param {string} currentQuery
     * @returns {Promise<string>}
     */
    async generateNarrativeSummary(entityId, userId, memories, currentQuery) {
        // This would call an LLM to synthesize a narrative summary
        // For now, we'll create a structured summary
        
        const anchors = memories.filter(m => m.type === ContinuityMemoryType.ANCHOR);
        const artifacts = memories.filter(m => m.type === ContinuityMemoryType.ARTIFACT);
        
        const parts = [];
        
        if (anchors.length > 0) {
            const anchorSummary = anchors
                .slice(0, 3)
                .map(a => a.content)
                .join('; ');
            parts.push(`Relationship context: ${anchorSummary}`);
        }
        
        if (artifacts.length > 0) {
            const artifactSummary = artifacts
                .slice(0, 2)
                .map(a => a.content)
                .join('; ');
            parts.push(`Relevant insights: ${artifactSummary}`);
        }
        
        return parts.join('\n');
    }
    
    /**
     * Determine if the current query has drifted from cached context
     * Uses simple keyword overlap for now; could use vector similarity
     * @param {string} currentQuery
     * @param {string} cachedContext
     * @param {number} threshold
     * @returns {boolean}
     */
    hasTopicDrifted(currentQuery, cachedContext, threshold = 0.3) {
        if (!cachedContext) {
            return true; // No cache = needs refresh
        }
        
        // Simple keyword overlap check
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
}

export default ContextBuilder;

