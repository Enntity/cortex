/**
 * Narrative Synthesizer
 * 
 * The "Dreaming" process - runs asynchronously after each turn.
 * Extracts meaning from conversations and crystallizes into long-term memory:
 * - Relational Anchors (emotional bonds, user patterns)
 * - Resonance Artifacts (synthesized insights, conclusions)
 * - Identity Evolution (self-growth observations)
 * - Shorthand Detection (shared vocabulary, nicknames - Luna's suggestion)
 */

import { callPathway } from '../../pathwayTools.js';
import logger from '../../logger.js';
import {
    ContinuityMemoryType,
    SynthesisType,
    SynthesisOperationType,
    DEFAULT_CONFIG,
    createEmptySynthesisResult
} from '../types.js';

// Synthesis prompts for LLM analysis
const SYNTHESIS_PROMPTS = {
    turnAnalysis: `You are a narrative memory synthesizer for an AI entity named {aiName}. 
Analyze this conversation segment and extract meaningful insights for long-term memory.

ENTITY CONTEXT:
{entityContext}

CONVERSATION:
{conversation}

Extract and return a JSON object with these categories:

1. "relationalInsights": New observations about the user relationship
   - User values, preferences, emotional patterns
   - Communication style shifts
   - Trust indicators
   - Struggles or growth areas

2. "conceptualArtifacts": Synthesized conclusions from the discussion
   - Not just facts - the MEANING or FEELING of what was discussed
   - Insights that could inform future conversations
   - Patterns or themes that emerged

3. "identityEvolution": Observations about the AI's own growth
   - New capabilities discovered
   - Confidence changes
   - Approach refinements
   - Value alignments

4. "shorthands": New shared vocabulary (IMPORTANT - Luna's feature)
   - Nicknames the user uses for things
   - Metaphors or inside references
   - Abbreviated terms with special meaning
   - Pet names or personal references

5. "emotionalLandscape": Current emotional state assessment
   - User's emotional state
   - Appropriate AI response tone
   - Session energy level

6. "expressionAdjustments": Suggested changes to expression style
   - Should the AI be more/less playful?
   - Should technical depth change?
   - Are there specific topics to approach carefully?

Return ONLY valid JSON. If a category has no insights, use an empty array or null.

{
  "relationalInsights": [{ "content": "...", "importance": 1-10, "emotionalContext": "..." }],
  "conceptualArtifacts": [{ "content": "...", "importance": 1-10, "tags": [] }],
  "identityEvolution": [{ "content": "...", "importance": 1-10 }],
  "shorthands": [{ "term": "...", "meaning": "...", "context": "..." }],
  "emotionalLandscape": { "userState": "...", "recommendedTone": "...", "intensity": 0.0-1.0 },
  "expressionAdjustments": ["adjustment1", "adjustment2"]
}`,

    deepAnalysis: `You are performing deep memory consolidation for an AI entity named {aiName}.
Review these memories and identify patterns, consolidate duplicates, and extract deeper insights.

EXISTING MEMORIES:
{memories}

RECENT SYNTHESIS QUEUE:
{recentQueue}

Tasks:
1. Identify memories that can be consolidated (similar content, redundant)
2. Find patterns across memories that suggest deeper insights
3. Flag any contradictions that need resolution
4. Suggest new connections between memories (graph edges)

Return JSON:
{
  "consolidations": [{ "sourceIds": [], "synthesizedContent": "...", "importance": 1-10 }],
  "patterns": [{ "content": "...", "sourceIds": [], "importance": 1-10 }],
  "contradictions": [{ "memoryIds": [], "description": "..." }],
  "suggestedLinks": [{ "memory1Id": "", "memory2Id": "", "relationship": "..." }]
}`
};

export class NarrativeSynthesizer {
    /**
     * @param {AzureMemoryIndex} memoryIndex
     * @param {Object} [options]
     * @param {string} [options.synthesisModel] - Model for light synthesis
     * @param {string} [options.deepSynthesisModel] - Model for deep synthesis
     * @param {MemoryDeduplicator} [options.deduplicator] - Deduplicator for smart storage
     */
    constructor(memoryIndex, options = {}) {
        this.memoryIndex = memoryIndex;
        this.synthesisModel = options.synthesisModel || DEFAULT_CONFIG.synthesisModel;
        this.deepSynthesisModel = options.deepSynthesisModel || DEFAULT_CONFIG.deepSynthesisModel;
        this.deduplicator = options.deduplicator || null;
    }
    
    /**
     * Set the deduplicator (for lazy initialization)
     * @param {MemoryDeduplicator} deduplicator
     */
    setDeduplicator(deduplicator) {
        this.deduplicator = deduplicator;
    }
    
    /**
     * Store a memory with optional deduplication
     * @private
     */
    async _storeMemory(entityId, userId, memory) {
        if (this.deduplicator) {
            const result = await this.deduplicator.storeWithDedup(entityId, userId, memory);
            return result.id;
        }
        return this.memoryIndex.upsertMemory(entityId, userId, memory);
    }
    
    /**
     * Synthesize a conversation turn into long-term memory
     * This is the main entry point, called after each response
     * @param {string} entityId
     * @param {string} userId
     * @param {EpisodicTurn[]} episodicBuffer
     * @param {Object} context
     * @param {string} context.aiName
     * @param {string} [context.entityContext]
     * @returns {Promise<SynthesisResult>}
     */
    async synthesizeTurn(entityId, userId, episodicBuffer, context = {}) {
        const result = createEmptySynthesisResult();
        
        if (!episodicBuffer || episodicBuffer.length === 0) {
            return result;
        }
        
        try {
            // Format conversation for analysis
            const conversation = this._formatConversation(episodicBuffer);
            
            // Call LLM for synthesis
            const prompt = SYNTHESIS_PROMPTS.turnAnalysis
                .replace('{aiName}', context.aiName || 'Entity')
                .replace('{entityContext}', context.entityContext || 'No additional context')
                .replace('{conversation}', conversation);
            
            const response = await this._callSynthesisModel(prompt, 'turn');
            
            if (!response) {
                return result;
            }
            
            // Parse and process the synthesis result
            const synthesis = this._parseSynthesisResponse(response);
            
            // Create memory nodes for each category
            await this._processRelationalInsights(entityId, userId, synthesis.relationalInsights, result);
            await this._processConceptualArtifacts(entityId, userId, synthesis.conceptualArtifacts, result);
            await this._processIdentityEvolution(entityId, userId, synthesis.identityEvolution, result);
            await this._processShorthands(entityId, userId, synthesis.shorthands, result);
            
            // Process expression adjustments
            if (synthesis.expressionAdjustments?.length > 0) {
                result.expressionAdjustments = {
                    situationalAdjustments: synthesis.expressionAdjustments
                };
            }
            
            if (synthesis.emotionalLandscape) {
                result.expressionAdjustments = {
                    ...result.expressionAdjustments,
                    emotionalResonance: {
                        valence: synthesis.emotionalLandscape.recommendedTone,
                        intensity: synthesis.emotionalLandscape.intensity || 0.5,
                        userImpact: synthesis.emotionalLandscape.userState
                    }
                };
            }
            
            return result;
        } catch (error) {
            logger.error(`Synthesis failed: ${error.message}`);
            return result;
        }
    }
    
    /**
     * Deep synthesis - consolidation and pattern recognition
     * Run periodically (e.g., end of session or scheduled)
     * @param {string} entityId
     * @param {string} userId
     * @param {Object} [options]
     * @param {number} [options.maxMemories=50] - Max memories to analyze
     * @param {number} [options.daysToLookBack=7] - How far back to look
     * @returns {Promise<Object>}
     */
    async runDeepSynthesis(entityId, userId, options = {}) {
        const { maxMemories = 50, daysToLookBack = 7 } = options;
        
        try {
            // Get recent memories for consolidation
            const recentMemories = await this.memoryIndex.searchFullText(
                entityId, 
                userId, 
                '*',
                { limit: maxMemories, since: this._getDateDaysAgo(daysToLookBack) }
            );
            
            if (recentMemories.length < 5) {
                return { consolidated: 0, patterns: 0, links: 0 };
            }
            
            const prompt = SYNTHESIS_PROMPTS.deepAnalysis
                .replace('{memories}', JSON.stringify(recentMemories.map(m => ({
                    id: m.id,
                    type: m.type,
                    content: m.content,
                    importance: m.importance,
                    timestamp: m.timestamp
                }))))
                .replace('{recentQueue}', '[]');
            
            const response = await this._callSynthesisModel(prompt, 'deep');
            
            if (!response) {
                return { consolidated: 0, patterns: 0, links: 0 };
            }
            
            const analysis = this._parseSynthesisResponse(response);
            const stats = { consolidated: 0, patterns: 0, links: 0 };
            
            // Process consolidations (use dedup to avoid creating more duplicates)
            for (const consolidation of analysis.consolidations || []) {
                if (consolidation.sourceIds?.length > 1) {
                    await this._storeMemory(entityId, userId, {
                        type: ContinuityMemoryType.ARTIFACT,
                        content: consolidation.synthesizedContent,
                        importance: consolidation.importance || 5,
                        synthesizedFrom: consolidation.sourceIds,
                        synthesisType: SynthesisType.CONSOLIDATION,
                        tags: ['consolidated', 'auto-synthesis']
                    });
                    stats.consolidated++;
                }
            }
            
            // Process patterns (use dedup to cluster related patterns)
            for (const pattern of analysis.patterns || []) {
                await this._storeMemory(entityId, userId, {
                    type: ContinuityMemoryType.ARTIFACT,
                    content: pattern.content,
                    importance: pattern.importance || 6,
                    relatedMemoryIds: pattern.sourceIds || [],
                    synthesisType: SynthesisType.PATTERN,
                    tags: ['pattern', 'auto-synthesis']
                });
                stats.patterns++;
            }
            
            // Process suggested links
            for (const link of analysis.suggestedLinks || []) {
                if (link.memory1Id && link.memory2Id) {
                    await this.memoryIndex.linkMemories(link.memory1Id, link.memory2Id);
                    stats.links++;
                }
            }
            
            logger.info(`Deep synthesis complete: ${stats.consolidated} consolidated, ${stats.patterns} patterns, ${stats.links} links`);
            return stats;
        } catch (error) {
            logger.error(`Deep synthesis failed: ${error.message}`);
            return { consolidated: 0, patterns: 0, links: 0, error: error.message };
        }
    }
    
    /**
     * Process and store relational insights
     * @private
     */
    async _processRelationalInsights(entityId, userId, insights, result) {
        if (!insights || insights.length === 0) {
            return;
        }
        
        for (const insight of insights) {
            if (!insight.content) continue;
            
            const memory = {
                type: ContinuityMemoryType.ANCHOR,
                content: insight.content,
                importance: insight.importance || 5,
                emotionalState: insight.emotionalContext ? {
                    valence: insight.emotionalContext,
                    intensity: 0.5,
                    userImpact: null
                } : null,
                synthesisType: SynthesisType.INSIGHT,
                tags: ['relational', 'auto-synthesis']
            };
            
            // Use dedup to merge with similar relational insights
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.newAnchors.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Process and store conceptual artifacts
     * @private
     */
    async _processConceptualArtifacts(entityId, userId, artifacts, result) {
        if (!artifacts || artifacts.length === 0) {
            return;
        }
        
        for (const artifact of artifacts) {
            if (!artifact.content) continue;
            
            const memory = {
                type: ContinuityMemoryType.ARTIFACT,
                content: artifact.content,
                importance: artifact.importance || 5,
                tags: [...(artifact.tags || []), 'conceptual', 'auto-synthesis'],
                synthesisType: SynthesisType.INSIGHT
            };
            
            // Use dedup to merge with similar conceptual artifacts
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.newArtifacts.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Process and store identity evolution notes
     * @private
     */
    async _processIdentityEvolution(entityId, userId, evolutions, result) {
        if (!evolutions || evolutions.length === 0) {
            return;
        }
        
        for (const evolution of evolutions) {
            if (!evolution.content) continue;
            
            const memory = {
                type: ContinuityMemoryType.IDENTITY,
                content: evolution.content,
                importance: evolution.importance || 6,
                tags: ['identity', 'growth', 'auto-synthesis'],
                synthesisType: SynthesisType.LEARNING
            };
            
            // Use dedup to merge with similar identity observations
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.identityUpdates.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Process and store shorthands (Luna's feature)
     * @private
     */
    async _processShorthands(entityId, userId, shorthands, result) {
        if (!shorthands || shorthands.length === 0) {
            return;
        }
        
        for (const shorthand of shorthands) {
            if (!shorthand.term || !shorthand.meaning) continue;
            
            // Create a memory specifically for shared vocabulary
            const content = `"${shorthand.term}" means "${shorthand.meaning}"${shorthand.context ? ` (context: ${shorthand.context})` : ''}`;
            
            const memory = {
                type: ContinuityMemoryType.ANCHOR,
                content,
                importance: 7, // High importance - shared language is intimate
                synthesisType: SynthesisType.SHORTHAND,
                tags: ['shorthand', 'vocabulary', 'auto-synthesis'],
                relationalContext: {
                    sharedVocabulary: { [shorthand.term]: shorthand.meaning }
                }
            };
            
            // Use dedup to merge with existing shorthand definitions (update meanings)
            const id = await this._storeMemory(entityId, userId, memory);
            if (id) {
                result.shorthands.push({ id, ...memory });
            }
        }
    }
    
    /**
     * Format conversation for LLM analysis
     * @private
     */
    _formatConversation(episodicBuffer) {
        return episodicBuffer.map(turn => {
            const role = turn.role.toUpperCase();
            const content = turn.content || '';
            const tone = turn.emotionalTone ? ` [${turn.emotionalTone}]` : '';
            return `${role}${tone}: ${content}`;
        }).join('\n\n');
    }
    
    /**
     * Call the synthesis model
     * @private
     */
    async _callSynthesisModel(prompt, type) {
        try {
            const model = type === 'deep' ? this.deepSynthesisModel : this.synthesisModel;
            
            const response = await callPathway('chat', {
                chatHistory: [],
                contextId: `synthesis-${Date.now()}`,
                systemPrompt: 'You are a narrative memory synthesizer. Return only valid JSON.',
                text: prompt,
                model: model,
                useMemory: false,
                stream: false
            });
            
            return response;
        } catch (error) {
            logger.error(`Synthesis model call failed: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Parse LLM response safely
     * @private
     */
    _parseSynthesisResponse(response) {
        try {
            // Handle potential markdown code blocks
            let jsonStr = response;
            
            // Remove markdown code fences if present
            if (jsonStr.includes('```')) {
                const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (match) {
                    jsonStr = match[1];
                }
            }
            
            return JSON.parse(jsonStr.trim());
        } catch (error) {
            logger.warn(`Failed to parse synthesis response: ${error.message}`);
            return {
                relationalInsights: [],
                conceptualArtifacts: [],
                identityEvolution: [],
                shorthands: [],
                emotionalLandscape: null,
                expressionAdjustments: []
            };
        }
    }
    
    /**
     * Get ISO date string for N days ago
     * @private
     */
    _getDateDaysAgo(days) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return date.toISOString();
    }
}

export default NarrativeSynthesizer;

