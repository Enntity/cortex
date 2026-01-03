/**
 * Continuity Memory Architecture
 * 
 * A narrative-based memory system that moves from "Storage" to "Synthesis".
 * Instead of just storing facts, it captures meaning, emotional bonds, and identity evolution.
 * 
 * Core Components:
 * - ContinuityMemoryService: Main orchestrator
 * - RedisHotMemory: Fast, session-scoped memory (episodic stream, expression state)
 * - AzureMemoryIndex: Long-term semantic memory with graph relationships
 * - ContextBuilder: Assembles context window for LLM prompts
 * - NarrativeSynthesizer: Extracts meaning and creates long-term memories
 * 
 * Integration:
 * - Pre-response: getContextWindow() injects narrative context
 * - Post-response: triggerSynthesis() runs asynchronously to crystallize meaning
 * 
 * @module continuity
 */

export { ContinuityMemoryService, getContinuityMemoryService } from './ContinuityMemoryService.js';
export { RedisHotMemory } from './storage/RedisHotMemory.js';
export { AzureMemoryIndex } from './storage/AzureMemoryIndex.js';
export { ContextBuilder } from './synthesis/ContextBuilder.js';
export { NarrativeSynthesizer } from './synthesis/NarrativeSynthesizer.js';
export { MemoryDeduplicator } from './synthesis/MemoryDeduplicator.js';

export {
    ContinuityMemoryType,
    EmotionalValence,
    SynthesisType,
    SynthesisPriority,
    SynthesisOperationType,
    DEFAULT_CONFIG,
    DEFAULT_DECAY_WEIGHTS,
    createEmptySynthesisResult,
    createDefaultEmotionalState,
    createDefaultExpressionState,
    calculateRecallScore,
    calculateNarrativeGravity,
    shouldPromoteToCore,
    sanitizeMemoryForLogging,
    sanitizeMemoriesForLogging
} from './types.js';

// Convenience factory for quick access
import { getContinuityMemoryService } from './ContinuityMemoryService.js';
export default getContinuityMemoryService;

