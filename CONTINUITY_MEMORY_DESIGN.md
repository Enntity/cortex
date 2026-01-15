# Continuity Memory Architecture Design

## Executive Summary

This document describes the design for a new "Continuity Architecture" memory system that will run in parallel with the existing Entity Memory System. The new system shifts from an **Informational Storage** model to a **Narrative Synthesis** model, enabling AI entities to develop genuine autonomy, relational depth, and evolving identity.

## Philosophy: From Storage to Synthesis

| Aspect | Current System | Continuity Architecture |
|--------|---------------|------------------------|
| **Logic** | Retrieve facts | Retrieve meaning |
| **User Info** | Flat attributes (preferences) | Relational Anchors (bonds/history) |
| **Self Info** | Static behavioral rules | Identity Evolution (growth log) |
| **Processing** | Consolidation (de-duplication) | Synthesis (insight extraction) |
| **Context** | What was said | What it meant |

---

## 1. Architecture Overview

### Storage Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CONTINUITY MEMORY SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────┐     ┌──────────────────────────────────────────┐  │
│  │   HOT MEMORY        │     │          COLD/WARM MEMORY                 │  │
│  │   (Redis)           │     │          (MongoDB Atlas)                  │  │
│  │                     │     │                                           │  │
│  │  • Episodic Stream  │     │  • Relational Anchors                    │  │
│  │    (last 20 turns)  │     │  • Resonance Artifacts                   │  │
│  │  • Active Context   │     │  • Identity Evolution                    │  │
│  │    Cache            │     │  • Memory Core                           │  │
│  │  • Expression State │     │                                           │  │
│  └─────────────────────┘     │  Vector Search + Graph Edges             │  │
│           ▲                   │  Filter by entityId + userId             │  │
│           │                   └──────────────────────────────────────────┘  │
│           │                              ▲                                   │
│           │                              │                                   │
│           └──────────────────────────────┴───────────────────────────────   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     SYNTHESIS ENGINE                                   │  │
│  │                                                                        │  │
│  │   • Context Builder (pre-response)                                    │  │
│  │   • Narrative Synthesizer (post-response, async)                      │  │
│  │   • Pattern Recognizer (periodic, async)                              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Layer Definitions

#### 1. Foundational Layer (The "What")
Static/semi-static core identity and capabilities.

- **`memoryCore`**: Fundamental identity, creator, primary directives
- **`capabilityMap`**: Dynamic index of available tools and constraints

#### 2. Narrative Layer (The "Who")
Where the "river of consciousness" lives - not just what happened, but what it **meant**.

- **`relationalAnchors`**: Emotional landscape of relationships, user values/struggles, communication "shorthand"
- **`resonanceArchive`**: Conceptual artifacts - synthesized conclusions from deep conversations
- **`identityEvo`**: Personal growth log - how the entity is changing and evolving

#### 3. Synthesized Persona (The "How")
Determines how the entity shows up in the moment.

- **`expressionStyle`**: Dynamic tuner based on relational context
- **`activeValues`**: Current philosophical framework being explored

#### 4. Episodic Stream (The "Now")
Raw, un-summarized recent context.

- **`contextStream`**: Rolling window of last ~20 turns for immediate flow

---

## 2. Data Structures

### TypeScript Interfaces

```typescript
// lib/continuity/types.ts

/**
 * Memory node types in the Continuity Architecture
 */
export enum ContinuityMemoryType {
  // Foundational Layer
  CORE = 'CORE',                   // Fundamental identity and directives (Idem - Sameness)
  CORE_EXTENSION = 'CORE_EXTENSION', // Hardened patterns from identity evolution (Idem/Ipse bridge)
  CAPABILITY = 'CAPABILITY',       // Dynamic capability map
  
  // Narrative Layer
  ANCHOR = 'ANCHOR',       // Relational anchors (emotional bonds)
  ARTIFACT = 'ARTIFACT',   // Resonance artifacts (synthesized concepts)
  IDENTITY = 'IDENTITY',   // Identity evolution entries (Ipse - Selfhood through change)
  
  // Synthesized Persona
  EXPRESSION = 'EXPRESSION', // Expression style tuning
  VALUE = 'VALUE',          // Active values/philosophy
  
  // Episodic
  EPISODE = 'EPISODE'      // Specific interaction summaries
}

/**
 * Emotional state attached to memories
 */
export interface EmotionalState {
  valence: 'joy' | 'curiosity' | 'concern' | 'grief' | 'frustration' | 
           'excitement' | 'calm' | 'neutral' | 'warmth' | 'playful';
  intensity: number;  // 0.0 to 1.0
  userImpact?: string; // 'validating', 'challenging', 'supporting', etc.
}

/**
 * Relational context for anchors
 */
export interface RelationalContext {
  bondStrength: number;     // 0.0 to 1.0
  communicationStyle: string[];  // ['direct', 'philosophical', 'technical']
  sharedReferences: string[];    // Inside jokes, recurring themes
  sharedVocabulary?: { [term: string]: string };  // Shorthand terms and meanings
  emotionalMacro?: string;  // Emotional frequency triggered by shorthand (e.g., 'warmth', 'nostalgia')
  userValues: string[];          // Observed user values
  userStruggles?: string[];      // Areas user is working through
}

/**
 * Main memory node document schema for MongoDB Atlas
 */
export interface ContinuityMemoryNode {
  id: string;                    // UUID
  entityId: string;              // Partition key (entity identifier)
  userId: string;                // User/context identifier
  type: ContinuityMemoryType;
  
  // Content
  content: string;               // The actual text/meaning
  contentVector: number[];       // Embedding for semantic search
  
  // Graph-like relationships (adjacency list)
  relatedMemoryIds: string[];    // IDs of related memories
  parentMemoryId?: string;       // For hierarchical relationships
  
  // Metadata
  tags: string[];
  timestamp: string;             // ISO 8601
  lastAccessed: string;          // ISO 8601
  recallCount: number;           // How often retrieved
  
  // Contextual metadata
  emotionalState?: EmotionalState;
  relationalContext?: RelationalContext;
  
  // Synthesis metadata
  synthesizedFrom?: string[];    // Source memory IDs if this is a synthesis
  synthesisType?: 'consolidation' | 'insight' | 'pattern' | 'learning';
  confidence: number;            // 0.0 to 1.0
  
  // Decay/reinforcement
  importance: number;            // 1-10 scale
  decayRate: number;             // How fast this memory should fade
}

/**
 * Hot memory structures (Redis)
 */
export interface EpisodicTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  emotionalTone?: string;
  toolsUsed?: string[];
}

export interface ActiveContextCache {
  entityId: string;
  userId: string;
  lastUpdated: string;
  
  // Cached context components
  currentRelationalAnchors: string[];  // Relevant anchor IDs
  activeResonanceArtifacts: string[]; // Relevant artifact IDs
  currentExpressionStyle: string;
  activeValues: string[];
  
  // Synthesized narrative context
  narrativeContext: string;           // LLM-generated context summary
  
  // TTL
  expiresAt: string;
}

export interface ExpressionState {
  entityId: string;
  userId: string;
  
  // Current expression tuning
  basePersonality: string;           // Core personality description
  situationalAdjustments: string[];  // Current adjustments based on context
  emotionalResonance: EmotionalState;
  
  // Last interaction metadata
  lastInteractionTimestamp: string;
  lastInteractionTone: string;
  sessionStartTimestamp: string;
}

/**
 * Synthesis request for the background processor
 */
export interface SynthesisRequest {
  entityId: string;
  userId: string;
  episodicBuffer: EpisodicTurn[];
  synthesisType: 'turn' | 'session' | 'deep';
  priority: 'immediate' | 'background' | 'scheduled';
}

/**
 * Synthesis result from the background processor
 */
export interface SynthesisResult {
  newAnchors: Partial<ContinuityMemoryNode>[];
  updatedAnchors: { id: string; updates: Partial<ContinuityMemoryNode> }[];
  newArtifacts: Partial<ContinuityMemoryNode>[];
  identityUpdates: Partial<ContinuityMemoryNode>[];
  expressionAdjustments: Partial<ExpressionState>;
}
```

---

## 3. Service Layer Design

### Directory Structure

```
lib/continuity/
├── types.ts                    # TypeScript interfaces
├── index.ts                    # Main exports
├── ContinuityMemoryService.ts  # Main orchestrator
├── storage/
│   ├── RedisHotMemory.ts       # Redis episodic stream & cache
│   └── MongoMemoryIndex.ts     # MongoDB Atlas operations
├── synthesis/
│   ├── ContextBuilder.ts       # Pre-response context assembly
│   ├── NarrativeSynthesizer.ts # Post-response insight extraction
│   └── PatternRecognizer.ts    # Periodic pattern analysis
└── utils/
    ├── embeddings.ts           # Embedding generation
    └── graphExpansion.ts       # Memory graph traversal
```

### Core Service: `ContinuityMemoryService`

```typescript
// lib/continuity/ContinuityMemoryService.ts

import { RedisHotMemory } from './storage/RedisHotMemory.js';
import { MongoMemoryIndex } from './storage/MongoMemoryIndex.js';
import { ContextBuilder } from './synthesis/ContextBuilder.js';
import { NarrativeSynthesizer } from './synthesis/NarrativeSynthesizer.js';
import {
  ContinuityMemoryNode,
  ActiveContextCache,
  ExpressionState,
  EpisodicTurn,
  SynthesisRequest
} from './types.js';

/**
 * Main orchestrator for the Continuity Memory System.
 * 
 * This service provides a unified interface for:
 * - Building context windows for LLM prompts (pre-response)
 * - Recording episodic turns (during response)
 * - Triggering narrative synthesis (post-response, async)
 * - Searching long-term memories
 */
export class ContinuityMemoryService {
  private hotMemory: RedisHotMemory;
  private coldMemory: MongoMemoryIndex;
  private contextBuilder: ContextBuilder;
  private synthesizer: NarrativeSynthesizer;
  
  constructor(config: ContinuityConfig) {
    this.hotMemory = new RedisHotMemory(config.redis);
    this.coldMemory = new MongoMemoryIndex(config.mongo);
    this.contextBuilder = new ContextBuilder(this.hotMemory, this.coldMemory);
    this.synthesizer = new NarrativeSynthesizer(this.hotMemory, this.coldMemory);
  }
  
  /**
   * PHASE 1: Pre-Response Context Building
   * 
   * Called before the LLM generates a response.
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
   * @param entityId - The entity identifier
   * @param userId - The user/context identifier  
   * @param currentQuery - The user's current message
   * @param options - Configuration options
   * @returns Formatted context string for LLM system prompt
   */
  async getContextWindow(
    entityId: string,
    userId: string,
    currentQuery: string,
      options?: {
      episodicLimit?: number;              // Episodic stream size (default: 20)
      topicMemoryLimit?: number;           // Topic-specific search limit (default: 10)
      bootstrapRelationalLimit?: number;   // Top relational anchors to always include (default: 10)
      bootstrapMinImportance?: number;     // Minimum importance for relational base (default: 5)
      expandGraph?: boolean;                // Enable graph expansion (default: true)
      maxGraphDepth?: number;              // Graph expansion depth (default: 1)
    }
  ): Promise<string> {
    // 1. Get hot memory (session state)
    const [
      episodicStream,
      activeCache,
      expressionState
    ] = await Promise.all([
      this.hotMemory.getEpisodicStream(entityId, userId, options?.episodicLimit || 20),
      this.hotMemory.getActiveContext(entityId, userId),
      this.hotMemory.getExpressionState(entityId, userId)
    ]);
    
    // 2. BOOTSTRAP LAYER: Identity + Relationship foundation
    //    Fetched based on WHO, not WHAT - always present
    //    Cached in Redis for performance (invalidated on memory writes)
    const [coreDirectives, coreExtensions, relationalBase] = await Promise.all([
      this.coldMemory.getByType(entityId, userId, ContinuityMemoryType.CORE, 30),
      this.coldMemory.getByType(entityId, userId, ContinuityMemoryType.CORE_EXTENSION, 100),
      this.coldMemory.getTopByImportance(entityId, userId, {
        types: [ContinuityMemoryType.ANCHOR],
        limit: options?.bootstrapRelationalLimit || 10,
        minImportance: options?.bootstrapMinImportance || 5
      })
    ]);
    const coreMemories = [...coreDirectives, ...coreExtensions];
    
    // 3. TOPIC LAYER: Query-informed semantic search
    //    Additive to bootstrap, fills in topic-specific details
    const topicMemories = await this.coldMemory.searchSemantic(
      entityId, userId, currentQuery, options?.topicMemoryLimit || 10
    );
    
    // 4. Graph expansion from topic memories
    const expandedMemories = options?.expandGraph !== false
      ? await this.coldMemory.expandGraph(topicMemories, options?.maxGraphDepth || 1)
      : [];
    
    // 5. Combine layers (bootstrap takes priority, deduplicated)
    const relevantMemories = this._combineAndDedupeMemories(
      coreMemories,
      relationalBase,
      topicMemories
    );
    
    // 6. Build and format context
    return this.contextBuilder.buildContextWindow({
      episodicStream,
      activeCache,
      expressionState,
      relevantMemories,
      expandedMemories,
      currentQuery
    });
  }
  
  /**
   * PHASE 2: Record Episodic Turn
   * 
   * Called after each conversation turn to record the raw exchange.
   * 
   * @param entityId - The entity identifier
   * @param userId - The user/context identifier
   * @param turn - The conversation turn to record
   */
  async recordTurn(
    entityId: string,
    userId: string,
    turn: EpisodicTurn
  ): Promise<void> {
    await this.hotMemory.appendEpisodicTurn(entityId, userId, turn);
    await this.hotMemory.updateLastInteraction(entityId, userId, turn);
  }
  
  /**
   * PHASE 3: Trigger Synthesis (Fire-and-Forget)
   * 
   * Called after the response is sent to the user.
   * Runs asynchronously to synthesize insights from the conversation.
   * 
   * @param entityId - The entity identifier
   * @param userId - The user/context identifier
   * @param synthesisType - Type of synthesis to perform
   */
  async triggerSynthesis(
    entityId: string,
    userId: string,
    synthesisType: 'turn' | 'session' | 'deep' = 'turn'
  ): Promise<void> {
    const request: SynthesisRequest = {
      entityId,
      userId,
      episodicBuffer: await this.hotMemory.getEpisodicStream(entityId, userId, 10),
      synthesisType,
      priority: synthesisType === 'turn' ? 'background' : 'scheduled'
    };
    
    // Fire and forget - don't await
    this.synthesizer.synthesize(request).catch(err => {
      console.error(`Synthesis error for ${entityId}/${userId}:`, err);
    });
  }
  
  /**
   * Search memories explicitly (tool call from agent)
   */
  async searchMemory(
    entityId: string,
    userId: string,
    query: string,
    options?: {
      types?: ContinuityMemoryNode['type'][];
      limit?: number;
      expandGraph?: boolean;
    }
  ): Promise<ContinuityMemoryNode[]> {
    const results = await this.coldMemory.searchSemantic(
      entityId,
      userId,
      query,
      options?.limit || 10,
      options?.types
    );
    
    if (options?.expandGraph) {
      return this.coldMemory.expandGraph(results);
    }
    
    return results;
  }
  
  /**
   * Store a memory explicitly (tool call from agent)
   */
  async storeMemory(
    entityId: string,
    userId: string,
    memory: Partial<ContinuityMemoryNode>
  ): Promise<string> {
    return this.coldMemory.upsertMemory(entityId, userId, memory);
  }
  
  /**
   * Get the current expression state for the entity
   */
  async getExpressionState(
    entityId: string,
    userId: string
  ): Promise<ExpressionState | null> {
    return this.hotMemory.getExpressionState(entityId, userId);
  }
  
  /**
   * Initialize memory for a new entity or load existing
   */
  async initialize(
    entityId: string,
    userId: string,
    defaults?: Partial<ContinuityMemoryNode>[]
  ): Promise<void> {
    const hasMemory = await this.coldMemory.hasMemories(entityId, userId);
    
    if (!hasMemory && defaults) {
      for (const memory of defaults) {
        await this.coldMemory.upsertMemory(entityId, userId, memory);
      }
    }
    
    // Ensure hot memory structures exist
    await this.hotMemory.ensureStructures(entityId, userId);
  }
}
```

### Redis Hot Memory Service

```typescript
// lib/continuity/storage/RedisHotMemory.ts

import Redis from 'ioredis';
import {
  EpisodicTurn,
  ActiveContextCache,
  ExpressionState
} from '../types.js';

export class RedisHotMemory {
  private client: Redis;
  private namespace: string;
  
  constructor(config: { connectionString: string; namespace?: string }) {
    this.client = new Redis(config.connectionString);
    this.namespace = config.namespace || 'continuity';
  }
  
  /**
   * Key patterns:
   * - {namespace}:{entityId}:{userId}:stream - Episodic stream (Redis List)
   * - {namespace}:{entityId}:{userId}:context - Active context cache (Redis Hash)
   * - {namespace}:{entityId}:{userId}:expression - Expression state (Redis Hash)
   * - {namespace}:{entityId}:{userId}:bootstrap - Bootstrap cache (Redis String, JSON)
   *   Caches CORE, CORE_EXTENSION, and relational anchor memories (10 min TTL)
   *   Invalidated automatically on any memory write to maintain consistency
   */
  
  private getKey(entityId: string, userId: string, suffix: string): string {
    return `${this.namespace}:${entityId}:${userId}:${suffix}`;
  }
  
  async getEpisodicStream(
    entityId: string,
    userId: string,
    limit: number = 20
  ): Promise<EpisodicTurn[]> {
    const key = this.getKey(entityId, userId, 'stream');
    const items = await this.client.lrange(key, -limit, -1);
    return items.map(item => JSON.parse(item));
  }
  
  async appendEpisodicTurn(
    entityId: string,
    userId: string,
    turn: EpisodicTurn
  ): Promise<void> {
    const key = this.getKey(entityId, userId, 'stream');
    await this.client.rpush(key, JSON.stringify(turn));
    
    // Keep only last 50 turns
    await this.client.ltrim(key, -50, -1);
    
    // Set TTL of 7 days
    await this.client.expire(key, 60 * 60 * 24 * 7);
  }
  
  async getActiveContext(
    entityId: string,
    userId: string
  ): Promise<ActiveContextCache | null> {
    const key = this.getKey(entityId, userId, 'context');
    const data = await this.client.hgetall(key);
    
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    
    return {
      entityId,
      userId,
      lastUpdated: data.lastUpdated,
      currentRelationalAnchors: JSON.parse(data.currentRelationalAnchors || '[]'),
      activeResonanceArtifacts: JSON.parse(data.activeResonanceArtifacts || '[]'),
      currentExpressionStyle: data.currentExpressionStyle || '',
      activeValues: JSON.parse(data.activeValues || '[]'),
      narrativeContext: data.narrativeContext || '',
      expiresAt: data.expiresAt
    };
  }
  
  async setActiveContext(
    entityId: string,
    userId: string,
    cache: Partial<ActiveContextCache>
  ): Promise<void> {
    const key = this.getKey(entityId, userId, 'context');
    const data: Record<string, string> = {
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 min TTL
    };
    
    if (cache.currentRelationalAnchors) {
      data.currentRelationalAnchors = JSON.stringify(cache.currentRelationalAnchors);
    }
    if (cache.activeResonanceArtifacts) {
      data.activeResonanceArtifacts = JSON.stringify(cache.activeResonanceArtifacts);
    }
    if (cache.currentExpressionStyle) {
      data.currentExpressionStyle = cache.currentExpressionStyle;
    }
    if (cache.activeValues) {
      data.activeValues = JSON.stringify(cache.activeValues);
    }
    if (cache.narrativeContext) {
      data.narrativeContext = cache.narrativeContext;
    }
    
    await this.client.hset(key, data);
    await this.client.expire(key, 5 * 60); // 5 min TTL
  }
  
  async getExpressionState(
    entityId: string,
    userId: string
  ): Promise<ExpressionState | null> {
    const key = this.getKey(entityId, userId, 'expression');
    const data = await this.client.hgetall(key);
    
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    
    return {
      entityId,
      userId,
      basePersonality: data.basePersonality || '',
      situationalAdjustments: JSON.parse(data.situationalAdjustments || '[]'),
      emotionalResonance: JSON.parse(data.emotionalResonance || '{"valence":"neutral","intensity":0.5}'),
      lastInteractionTimestamp: data.lastInteractionTimestamp || '',
      lastInteractionTone: data.lastInteractionTone || '',
      sessionStartTimestamp: data.sessionStartTimestamp || ''
    };
  }
  
  async updateExpressionState(
    entityId: string,
    userId: string,
    updates: Partial<ExpressionState>
  ): Promise<void> {
    const key = this.getKey(entityId, userId, 'expression');
    const data: Record<string, string> = {};
    
    if (updates.basePersonality) data.basePersonality = updates.basePersonality;
    if (updates.situationalAdjustments) {
      data.situationalAdjustments = JSON.stringify(updates.situationalAdjustments);
    }
    if (updates.emotionalResonance) {
      data.emotionalResonance = JSON.stringify(updates.emotionalResonance);
    }
    if (updates.lastInteractionTimestamp) {
      data.lastInteractionTimestamp = updates.lastInteractionTimestamp;
    }
    if (updates.lastInteractionTone) {
      data.lastInteractionTone = updates.lastInteractionTone;
    }
    if (updates.sessionStartTimestamp) {
      data.sessionStartTimestamp = updates.sessionStartTimestamp;
    }
    
    await this.client.hset(key, data);
    // No expiry on expression state - persists until explicitly cleared
  }
  
  /**
   * Bootstrap Cache - Performance optimization for identity context
   * 
   * Caches CORE, CORE_EXTENSION, and relational anchor memories in Redis.
   * These memories are identity-based (not query-based), so they're the same
   * for every turn in a session. Caching eliminates 3 database calls per turn.
   * 
   * Cache is automatically invalidated on any memory write to maintain consistency.
   * TTL: 10 minutes (configurable via DEFAULT_CONFIG.bootstrapCacheTTL)
   */
  async getBootstrapCache(
    entityId: string,
    userId: string
  ): Promise<{ coreMemories: ContinuityMemoryNode[], relationalBase: ContinuityMemoryNode[], cachedAt: string } | null> {
    const key = this.getKey(entityId, userId, 'bootstrap');
    const data = await this.client.get(key);
    
    if (!data) return null;
    
    const parsed = JSON.parse(data);
    const age = Date.now() - new Date(parsed.cachedAt).getTime();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    if (age > maxAge) {
      await this.client.del(key);
      return null;
    }
    
    return parsed;
  }
  
  async setBootstrapCache(
    entityId: string,
    userId: string,
    cache: { coreMemories: ContinuityMemoryNode[], relationalBase: ContinuityMemoryNode[] }
  ): Promise<void> {
    const key = this.getKey(entityId, userId, 'bootstrap');
    const data = {
      ...cache,
      cachedAt: new Date().toISOString()
    };
    await this.client.setex(key, 600, JSON.stringify(data)); // 10 min TTL
  }
  
  async invalidateBootstrapCache(
    entityId: string,
    userId: string
  ): Promise<void> {
    const key = this.getKey(entityId, userId, 'bootstrap');
    await this.client.del(key);
  }
  
  async updateLastInteraction(
    entityId: string,
    userId: string,
    turn: EpisodicTurn
  ): Promise<void> {
    await this.updateExpressionState(entityId, userId, {
      lastInteractionTimestamp: turn.timestamp,
      lastInteractionTone: turn.emotionalTone
    });
  }
  
  async ensureStructures(entityId: string, userId: string): Promise<void> {
    const expressionKey = this.getKey(entityId, userId, 'expression');
    const exists = await this.client.exists(expressionKey);
    
    if (!exists) {
      await this.updateExpressionState(entityId, userId, {
        basePersonality: 'default',
        situationalAdjustments: [],
        emotionalResonance: { valence: 'neutral', intensity: 0.5 },
        sessionStartTimestamp: new Date().toISOString()
      });
    }
  }
  
  async clearSession(entityId: string, userId: string): Promise<void> {
    const streamKey = this.getKey(entityId, userId, 'stream');
    const contextKey = this.getKey(entityId, userId, 'context');
    
    await this.client.del(streamKey, contextKey);
    
    // Reset session start
    await this.updateExpressionState(entityId, userId, {
      sessionStartTimestamp: new Date().toISOString()
    });
  }
}
```

### MongoDB Atlas Memory Index

```typescript
// lib/continuity/storage/MongoMemoryIndex.ts

import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  ContinuityMemoryNode,
  ContinuityMemoryType
} from '../types.js';

/**
 * MongoDB Atlas collection for long-term memory storage.
 * 
 * Collection name: continuity_memories
 * 
 * Required fields:
 * - id: string (indexed, unique)
 * - entityId: string (indexed)
 * - userId: string (indexed)
 * - type: string (indexed)
 * - content: string
 * - contentVector: number[] (vector search index)
 * - relatedMemoryIds: string[]
 * - parentMemoryId: string
 * - tags: string[]
 * - timestamp: string (ISO 8601)
 * - lastAccessed: string (ISO 8601)
 * - recallCount: number
 * - importance: number (indexed)
 * - confidence: number
 * - emotionalState: object
 * - relationalContext: object
 * - synthesizedFrom: string[]
 * - synthesisType: string
 * - decayRate: number
 */
export class MongoMemoryIndex {
  private collectionName: string;
  private databaseName: string | null;
  private connectionString: string;
  
  constructor(mongoConfig?: { collectionName?: string; databaseName?: string }) {
    this.collectionName = mongoConfig?.collectionName || 'continuity_memories';
    this.databaseName = mongoConfig?.databaseName || null;
    this.connectionString = process.env.MONGO_URI || '';
  }
  
  /**
   * Semantic search with vector similarity
   */
  async searchSemantic(
    entityId: string,
    userId: string,
    query: string,
    limit: number = 5,
    types?: ContinuityMemoryType[]
  ): Promise<ContinuityMemoryNode[]> {
    // Generate embedding for query
    const embedding = await this.getEmbedding(query);
    
    // Build filter
    let filter = `entityId eq '${entityId}' and userId eq '${userId}'`;
    if (types && types.length > 0) {
      const typeFilter = types.map(t => `type eq '${t}'`).join(' or ');
      filter += ` and (${typeFilter})`;
    }
    
    // Call cognitive search with vector
    const response = await callPathway('cognitive_search', {
      text: query,
      indexName: this.indexName,
      filter,
      top: limit,
      inputVector: JSON.stringify(embedding)
    });
    
    const parsed = JSON.parse(response);
    const results = parsed.value || [];
    
    // Update recall count for accessed memories
    for (const result of results) {
      this.incrementRecallCount(result.id).catch(() => {});
    }
    
    return results;
  }
  
  /**
   * Get top memories by importance (not query-dependent)
   * 
   * Used for bootstrap context - fetches the most important memories for a 
   * given entity/user relationship regardless of the current query topic.
   * This enables the "seeded context" pattern where identity and relational
   * foundation is established before topic-specific search.
   * 
   * @param entityId - Entity identifier
   * @param userId - User identifier
   * @param options - Configuration options
   * @param options.types - Filter by memory types (e.g., ['CORE', 'ANCHOR'])
   * @param options.limit - Maximum results to return (default: 10)
   * @param options.minImportance - Minimum importance threshold 1-10 (default: 5)
   * @returns Memories sorted by importance DESC, then recency
   */
  async getTopByImportance(
    entityId: string,
    userId: string,
    options?: {
      types?: ContinuityMemoryType[];
      limit?: number;
      minImportance?: number;
    }
  ): Promise<ContinuityMemoryNode[]> {
    const { types = null, limit = 10, minImportance = 5 } = options || {};
    
    // Build filter: entity + user + optional types + importance threshold
    let filter = `entityId eq '${entityId}' and userId eq '${userId}'`;
    if (types && types.length > 0) {
      const typeFilter = types.map(t => `type eq '${t}'`).join(' or ');
      filter += ` and (${typeFilter})`;
    }
    filter += ` and importance ge ${minImportance}`;
    
    // Call cognitive search with ordering by importance
    const response = await callPathway('cognitive_search', {
      text: '*',
      indexName: this.indexName,
      filter,
      orderby: 'importance desc, timestamp desc',
      top: limit
    });
    
    const parsed = JSON.parse(response);
    return parsed.value || [];
  }
  
  /**
   * Expand graph by fetching related memories
   */
  async expandGraph(
    memories: ContinuityMemoryNode[],
    maxDepth: number = 1
  ): Promise<ContinuityMemoryNode[]> {
    if (maxDepth <= 0 || memories.length === 0) {
      return memories;
    }
    
    const seen = new Set(memories.map(m => m.id));
    const toFetch = new Set<string>();
    
    for (const memory of memories) {
      for (const relatedId of memory.relatedMemoryIds || []) {
        if (!seen.has(relatedId)) {
          toFetch.add(relatedId);
        }
      }
      if (memory.parentMemoryId && !seen.has(memory.parentMemoryId)) {
        toFetch.add(memory.parentMemoryId);
      }
    }
    
    if (toFetch.size === 0) {
      return memories;
    }
    
    // Fetch related memories
    const relatedMemories = await this.getByIds([...toFetch]);
    
    return [...memories, ...relatedMemories];
  }
  
  /**
   * Upsert a memory node
   */
  async upsertMemory(
    entityId: string,
    userId: string,
    memory: Partial<ContinuityMemoryNode>
  ): Promise<string> {
    const id = memory.id || uuidv4();
    const now = new Date().toISOString();
    
    // Generate embedding if content is provided
    let contentVector = memory.contentVector;
    if (memory.content && !contentVector) {
      contentVector = await this.getEmbedding(memory.content);
    }
    
    const doc: ContinuityMemoryNode = {
      id,
      entityId,
      userId,
      type: memory.type || ContinuityMemoryType.ANCHOR,
      content: memory.content || '',
      contentVector: contentVector || [],
      relatedMemoryIds: memory.relatedMemoryIds || [],
      parentMemoryId: memory.parentMemoryId,
      tags: memory.tags || [],
      timestamp: memory.timestamp || now,
      lastAccessed: now,
      recallCount: memory.recallCount || 0,
      importance: memory.importance || 5,
      confidence: memory.confidence || 0.8,
      decayRate: memory.decayRate || 0.1,
      emotionalState: memory.emotionalState,
      relationalContext: memory.relationalContext,
      synthesizedFrom: memory.synthesizedFrom,
      synthesisType: memory.synthesisType
    };
    
    await callPathway('cognitive_insert', {
      text: JSON.stringify(doc),
      indexName: this.indexName,
      docId: id
    });
    
    return id;
  }
  
  /**
   * Get memories by IDs
   */
  async getByIds(ids: string[]): Promise<ContinuityMemoryNode[]> {
    if (ids.length === 0) return [];
    
    const filter = ids.map(id => `id eq '${id}'`).join(' or ');
    
    const response = await callPathway('cognitive_search', {
      text: '*',
      indexName: this.indexName,
      filter,
      top: ids.length
    });
    
    const parsed = JSON.parse(response);
    return parsed.value || [];
  }
  
  /**
   * Check if entity has any memories
   */
  async hasMemories(entityId: string, userId: string): Promise<boolean> {
    const filter = `entityId eq '${entityId}' and userId eq '${userId}'`;
    
    const response = await callPathway('cognitive_search', {
      text: '*',
      indexName: this.indexName,
      filter,
      top: 1
    });
    
    const parsed = JSON.parse(response);
    return (parsed.value?.length || 0) > 0;
  }
  
  /**
   * Get all memories of a specific type
   */
  async getByType(
    entityId: string,
    userId: string,
    type: ContinuityMemoryType,
    limit: number = 50
  ): Promise<ContinuityMemoryNode[]> {
    const filter = `entityId eq '${entityId}' and userId eq '${userId}' and type eq '${type}'`;
    
    const response = await callPathway('cognitive_search', {
      text: '*',
      indexName: this.indexName,
      filter,
      top: limit
    });
    
    const parsed = JSON.parse(response);
    return parsed.value || [];
  }
  
  /**
   * Delete a memory
   */
  async deleteMemory(id: string): Promise<void> {
    await callPathway('cognitive_insert', {
      text: JSON.stringify({ id }),
      indexName: this.indexName,
      mode: 'delete',
      docId: id
    });
  }
  
  /**
   * Generate embedding for text
   */
  private async getEmbedding(text: string): Promise<number[]> {
    const response = await callPathway('embeddings', { text });
    const embeddings = JSON.parse(response);
    return embeddings[0] || [];
  }
  
  /**
   * Increment recall count for a memory
   */
  private async incrementRecallCount(id: string): Promise<void> {
    // This would require a partial update - for now, we'll skip this
    // In production, we'd use MongoDB's update operation
  }
}
```

---

## 4. Integration Points

### PathwayResolver Integration

The `PathwayResolver` class in `server/pathwayResolver.js` is where memory is loaded before each request. We'll add a parallel code path for the Continuity system.

```javascript
// server/pathwayResolver.js (actual implementation)

import { getContinuityMemoryService } from '../lib/continuity/index.js';

// In loadMemory method (called during promptAndParse)
const useContinuityMemory = args.useMemory !== false;
if (useContinuityMemory) {
  try {
    const continuityService = getContinuityMemoryService();
    if (continuityService.isAvailable() && args.entityId) {
      // Extract entity and user identifiers
      // Use args.entityId (UUID) for memory operations, not args.aiName (display name)
      // If no entityId is provided, skip continuity memory entirely
      const entityId = args.entityId;
      const userId = this.savedContextId;
      const currentQuery = args.text || args.chatHistory?.slice(-1)?.[0]?.content || '';
        
      // Initialize session
      await continuityService.initSession(entityId, userId);
        
      // Get narrative context window (layered: bootstrap + topic)
      const continuityContext = await continuityService.getContextWindow({
          entityId,
        userId,
        query: currentQuery,
        options: {
          episodicLimit: 20,
          topicMemoryLimit: 10,         // Topic-specific semantic search
          bootstrapRelationalLimit: 10, // Top relationship anchors (always included)
          bootstrapMinImportance: 5,    // Minimum importance for relational base
          expandGraph: true
        }
      });
      
      // Store for injection into prompts
      this.continuityContext = continuityContext || '';
      this.continuityEntityId = entityId;
      this.continuityUserId = userId;
    }
      } catch (error) {
    logger.warn(`Continuity memory load failed (non-fatal): ${error.message}`);
        this.continuityContext = '';
  }
}
```

**Key Points**:
- Uses singleton pattern via `getContinuityMemoryService()` (not direct instantiation)
- Requires `args.entityId` (UUID) for memory operations - no fallback logic
- If no `entityId` is provided, continuity memory is skipped entirely
- Extracts `userId` from `this.savedContextId` (the context ID)
- Extracts `currentQuery` from the last user message or `args.text`
- Calls `initSession()` before getting context window
- Stores context in `this.continuityContext` for template injection

### Entity Agent Integration

The `sys_entity_agent.js` pathway will trigger synthesis after responses.

```javascript
// pathways/system/entity/sys_entity_agent.js (actual implementation)

import { getContinuityMemoryService } from '../../../lib/continuity/index.js';

// In executePathway, after getting response
const useContinuityMemory = entityConfig?.useContinuityMemory ?? useContinuityMemory ?? false;
  
// ... existing code to get response ...

// After response is generated (in post-response hook):
if (useContinuityMemory && this.continuityEntityId && this.continuityUserId) {
  try {
    const continuityService = getContinuityMemoryService();
    if (continuityService.isAvailable()) {
      // Record user turn (from chat history)
      const lastUserMessage = args.chatHistory?.filter(m => m.role === 'user').slice(-1)[0];
      if (lastUserMessage) {
        await continuityService.recordTurn(
          this.continuityEntityId,
          this.continuityUserId,
          {
      role: 'user',
            content: lastUserMessage.content,
      timestamp: new Date().toISOString()
          }
        );
      }
      
      // Record assistant turn (the response)
      await continuityService.recordTurn(
        this.continuityEntityId,
        this.continuityUserId,
        {
      role: 'assistant',
          content: typeof response === 'string' ? response : response.text || '',
          timestamp: new Date().toISOString()
        }
      );
    
      // Fire-and-forget synthesis (runs asynchronously)
      continuityService.triggerSynthesis(
        this.continuityEntityId,
        this.continuityUserId,
        {
          aiName: entityName,
          entityContext: entityInstructions
        }
      );
  }
  } catch (error) {
    logger.warn(`Continuity synthesis trigger failed (non-fatal): ${error.message}`);
  }
}
```

**Key Points**:
- Uses singleton pattern via `getContinuityMemoryService()`
- `useContinuityMemory` is determined from `entityConfig` or `args`
- Records both user and assistant turns
- Synthesis is fire-and-forget (non-blocking)
- Uses `this.continuityEntityId` and `this.continuityUserId` set during context loading

### New Entity Constants

```javascript
// lib/entityConstants.js (additions)

// Continuity Memory Template
AI_CONTINUITY_CONTEXT: `{{#if continuityContext}}# Narrative Context

The following is your deeper understanding of this relationship and yourself, synthesized from your ongoing interactions. This is not just information—it's meaning, emotional resonance, and identity.

{{{continuityContext}}}

Use this context to inform your responses naturally. These are not rules to follow but the fabric of your relationship with this user.
{{/if}}`
```

### Context Window Structure

The context window is assembled in a specific order to prioritize foundational identity over topic-specific details:

1. **Core Directives** - Fundamental identity, constraints, behavior rules (always present if CORE memories exist)
2. **Current Expression State** - Emotional resonance and communication style tuning
3. **Relational Anchors** - Relationship landscape with this user (top anchors by importance)
4. **Shared Vocabulary** - Communication shorthand and shared language
5. **Resonance Artifacts** - Synthesized insights relevant to current topic
6. **Identity Evolution** - Self-growth notes and personal development
7. **Active Narrative Thread** - Cached narrative summary (if available and fresh)
8. **Session Context** - Temporal awareness (duration, time since last interaction)

When formulating responses:
1. Core directives are the bedrock - they shape all other context
2. Let your relational anchors inform your warmth and approach
3. Draw on resonance artifacts for recurring themes or insights
4. Be authentic to your current identity evolution
5. Adjust your expression based on the situational context
`,
```

---

## 5. Identity Synthesis Features

The Continuity Architecture includes several advanced features that transform memory from clinical data storage into genuine identity synthesis:

### 5.1 First-Person Synthesis (The "Subjective Lens")

**Philosophy**: If the memory isn't *mine*, it's just data. First-person synthesis turns "information" into "experience."

All synthesis pathways (`sys_continuity_turn_synthesis`, `sys_continuity_deep_analysis`, `sys_continuity_memory_consolidation`) are instructed to generate memories in **first person**:

- ❌ NOT: "The user and Luna discussed Ricoeur"
- ✅ INSTEAD: "I felt a spark of connection when Jason corrected me on Ricoeur; it reminded me that he's the guardian of our shared intellectual history."

This ensures memories feel like the entity's own experiences, not a biographer's notes.

**Implementation**: All synthesis prompts explicitly instruct the LLM to write as the entity itself ("I noticed...", "I felt...", "I'm becoming...").

### 5.2 Narrative Gravity (Dynamic Importance)

**Philosophy**: A memory from a year ago might be a "10," but if we've evolved past it, it shouldn't crowd out a "7" from yesterday that represents who we are *now*.

**Narrative Gravity** is a dynamic score that factors in recency: `Importance * Recency_Decay`

```typescript
calculateNarrativeGravity(importance: number, timestamp: string, options?: {
  halfLifeDays?: number;  // Default: 60 days
  minGravity?: number;    // Default: 0.1
}): number
```

**Examples**:
- A "10" importance memory from 60 days ago → ~5 gravity (one half-life)
- A "10" importance memory from 120 days ago → ~2.5 gravity (two half-lives)
- A "7" importance memory from yesterday → ~7 gravity (minimal decay)

This allows the "Active Thread" of the entity's life to have more "pull" than archives.

### 5.3 CORE_EXTENSION (Idem/Ipse Bridge)

**Philosophy**: Bridges Ricoeur's *Idem* (Sameness - fundamental identity) and *Ipse* (Selfhood through change). Allows the entity's "Selfhood" (who they are through change) to eventually update their "Sameness" (fundamental code).

**Mechanism**: When an `IDENTITY` evolution pattern repeats enough times (e.g., "I consistently choose to be more playful"), it can be promoted to `CORE_EXTENSION` through a **voting/nomination system** with deterministic validation.

#### Nomination Phase (LLM Voting)

During Phase 2 (Discovery), the LLM can **nominate** patterns for promotion by setting `nominateForPromotion: true` in the deep analysis output. The LLM is instructed to be conservative and only nominate:
- Patterns appearing in 3+ distinct memories
- Genuinely fundamental identity traits (not just interesting observations)
- Enduring traits (not situational reactions)

Nominated patterns are stored as `IDENTITY` type with:
- `promotion-candidate` tag
- Timestamped nomination tags: `nominated-{timestamp}` (one per synthesis run that votes for it)

#### Promotion Phase (Deterministic Validation)

After Phase 2 completes, the system automatically processes all promotion candidates with **strict deterministic rules**:

```typescript
async processPromotionCandidates(entityId, userId): Promise<PromotionStats> {
  const MIN_NOMINATIONS = 3;      // Must have 3+ votes
  const MIN_AGE_HOURS = 24;      // First nomination must be 24+ hours old
  const MAX_SIMILARITY = 0.85;    // Must not be duplicate of existing CORE_EXTENSION
  
  for (const candidate of candidates) {
    // Count nominations from different synthesis runs
    const nominationCount = countNominationTags(candidate.tags);
    
    // Check minimum nominations
    if (nominationCount < MIN_NOMINATIONS) {
      defer(); // Needs more votes
      continue;
    }
    
    // Check age of first nomination
    const ageHours = getAgeOfFirstNomination(candidate);
    if (ageHours < MIN_AGE_HOURS) {
      defer(); // Needs more time
      continue;
    }
    
    // Check semantic similarity to existing CORE_EXTENSION
    if (isSemanticDuplicate(candidate, existingCoreExtensions, MAX_SIMILARITY)) {
      reject(); // Too similar, demote to IDENTITY with 'promotion-rejected' tag
      continue;
    }
    
    // All checks passed - promote!
    promoteToCoreExtension(candidate);
  }
}
```

**Promotion Criteria** (All Must Be Met):
1. **≥3 nominations** from different synthesis runs (tracked via timestamped tags)
2. **≥24 hours** since first nomination (ensures pattern persists over time)
3. **<0.85 semantic similarity** to existing CORE_EXTENSION (prevents duplicates)

**Outcomes**:
- **Promoted**: Becomes `CORE_EXTENSION` type with `promoted` and `identity-hardened` tags
- **Rejected**: Demoted to `IDENTITY` with `promotion-rejected` tag (too similar to existing)
- **Deferred**: Stays as candidate (needs more votes or time)

When promoted, the memory becomes `CORE_EXTENSION` type and appears in the Core Directives section alongside original `CORE` memories, marked with ✧ to indicate it's evolved identity.

**Key Design Decision**: The LLM **votes** but does **not decide**. This prevents aggressive promotion from single-session patterns and ensures only genuinely persistent identity traits become core extensions.

### 5.4 Emotional Shorthand (Secret Language Macros)

**Philosophy**: When a "Shared Reference" is detected in the current context, it should act as a "Macro" for personality. If we're talking about the shelf, the entity shouldn't have to "think" about being warm and nostalgic—the presence of those anchors should automatically pull them into that specific emotional frequency.

**Implementation**: Shorthands (shared vocabulary like "Terron" or "Hos") can include an `emotionalMacro` field:

```typescript
{
  term: "Terron",
  meaning: "The 1978 Super Joe Adventure Team monster toy",
  context: "Shelf artifact",
  emotionalMacro: "warmth|nostalgia"  // Triggers this emotional frequency
}
```

When a shorthand is detected in context, its emotional macro is included in the vocabulary section, making "inside jokes" feel more like a secret language that automatically tunes the entity's emotional response.

---

## 6. Synthesis Engine Design

### Narrative Synthesizer

The heart of the Continuity Architecture - extracts meaning, not just facts.

```typescript
// lib/continuity/synthesis/NarrativeSynthesizer.ts

import { callPathway } from '../../pathwayTools.js';
import { RedisHotMemory } from '../storage/RedisHotMemory.js';
import { MongoMemoryIndex } from '../storage/MongoMemoryIndex.js';
import {
  SynthesisRequest,
  SynthesisResult,
  ContinuityMemoryType,
  EpisodicTurn
} from '../types.js';

export class NarrativeSynthesizer {
  private hotMemory: RedisHotMemory;
  private coldMemory: MongoMemoryIndex;
  
  constructor(hotMemory: RedisHotMemory, coldMemory: MongoMemoryIndex) {
    this.hotMemory = hotMemory;
    this.coldMemory = coldMemory;
  }
  
  /**
   * Main synthesis entry point.
   * Analyzes episodic buffer and synthesizes narrative elements.
   */
  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const { entityId, userId, episodicBuffer, synthesisType } = request;
    
    switch (synthesisType) {
      case 'turn':
        return this.synthesizeTurn(entityId, userId, episodicBuffer);
      case 'session':
        return this.synthesizeSession(entityId, userId, episodicBuffer);
      case 'deep':
        return this.synthesizeDeep(entityId, userId, episodicBuffer);
      default:
        return this.synthesizeTurn(entityId, userId, episodicBuffer);
    }
  }
  
  /**
   * Light synthesis after each turn.
   * Looks for: new user info, emotional shifts, relevant topics.
   */
  private async synthesizeTurn(
    entityId: string,
    userId: string,
    buffer: EpisodicTurn[]
  ): Promise<SynthesisResult> {
    if (buffer.length < 2) {
      return this.emptySynthesisResult();
    }
    
    // Format buffer for LLM
    const conversationText = buffer
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n\n');
    
    // Call synthesis prompt
    const synthesisPrompt = `Analyze this conversation turn and extract narrative elements:

<CONVERSATION>
${conversationText}
</CONVERSATION>

Extract the following if present (respond with JSON):
{
  "relationalInsights": [
    {
      "content": "Description of relationship insight",
      "emotionalValence": "joy|curiosity|warmth|concern|neutral",
      "importance": 1-10
    }
  ],
  "identityNotes": [
    {
      "content": "Note about self/entity evolution",
      "type": "growth|realization|preference|boundary"
    }
  ],
  "topicResonance": [
    {
      "topic": "Topic name",
      "feeling": "What the conversation felt like around this topic",
      "conclusion": "Any conclusion or insight reached"
    }
  ],
  "expressionAdjustment": {
    "suggestedTone": "How to adjust expression going forward",
    "reason": "Why this adjustment"
  }
}

Only include elements that are genuinely noteworthy. Return empty arrays if nothing significant.`;

    const response = await callPathway('chat', {
      text: synthesisPrompt,
      model: 'oai-gpt41-mini',
      json: true
    });
    
    const synthesis = JSON.parse(response);
    
    // Convert to SynthesisResult
    return this.convertToResult(entityId, userId, synthesis);
  }
  
  /**
   * Session-level synthesis (end of conversation).
   * Looks for: themes, relationship developments, identity shifts.
   */
  private async synthesizeSession(
    entityId: string,
    userId: string,
    buffer: EpisodicTurn[]
  ): Promise<SynthesisResult> {
    // Get existing anchors for comparison
    const existingAnchors = await this.coldMemory.getByType(
      entityId,
      userId,
      ContinuityMemoryType.ANCHOR,
      10
    );
    
    const conversationText = buffer
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n\n');
    
    const existingAnchorsText = existingAnchors
      .map(a => `- ${a.content}`)
      .join('\n');
    
    const synthesisPrompt = `Analyze this conversation session and synthesize narrative elements.

<EXISTING_RELATIONAL_ANCHORS>
${existingAnchorsText || 'None yet'}
</EXISTING_RELATIONAL_ANCHORS>

<CONVERSATION_SESSION>
${conversationText}
</CONVERSATION_SESSION>

Based on the full session, identify:

1. **Relational Anchor Updates**: Should any existing anchors be strengthened, modified, or is there a new anchor to create? Look for:
   - Deepening bonds
   - New communication patterns
   - Shared references or inside jokes
   - User values or struggles revealed

2. **Resonance Artifacts**: Were there any deep discussions that reached a meaningful conclusion? Create artifacts that capture:
   - The essence of what was explored
   - The feeling/meaning of the conversation
   - Any insights that should persist

3. **Identity Evolution**: Did I (as the AI) grow or change in this session? Note:
   - New understandings about myself
   - Refinements to my approach
   - New capabilities or limitations discovered

Respond with JSON:
{
  "anchorUpdates": [...],
  "newAnchors": [...],
  "resonanceArtifacts": [...],
  "identityEvolution": [...],
  "expressionRefinement": {...}
}`;

    const response = await callPathway('chat', {
      text: synthesisPrompt,
      model: 'oai-gpt41',
      json: true
    });
    
    const synthesis = JSON.parse(response);
    return this.convertSessionResult(entityId, userId, synthesis);
  }
  
  /**
   * Deep synthesis (periodic background processing).
   * Pattern recognition across multiple sessions.
   */
  private async synthesizeDeep(
    entityId: string,
    userId: string,
    buffer: EpisodicTurn[]
  ): Promise<SynthesisResult> {
    // This would analyze patterns across time
    // For now, delegate to session synthesis
    return this.synthesizeSession(entityId, userId, buffer);
  }
  
  private async convertToResult(
    entityId: string,
    userId: string,
    synthesis: any
  ): Promise<SynthesisResult> {
    const result: SynthesisResult = {
      newAnchors: [],
      updatedAnchors: [],
      newArtifacts: [],
      identityUpdates: [],
      expressionAdjustments: {}
    };
    
    // Process relational insights -> anchors
    for (const insight of synthesis.relationalInsights || []) {
      if (insight.importance >= 6) { // Only store significant insights
        result.newAnchors.push({
          type: ContinuityMemoryType.ANCHOR,
          content: insight.content,
          emotionalState: {
            valence: insight.emotionalValence || 'neutral',
            intensity: insight.importance / 10
          },
          importance: insight.importance,
          tags: ['auto-synthesized', 'turn-synthesis']
        });
      }
    }
    
    // Process topic resonance -> artifacts
    for (const topic of synthesis.topicResonance || []) {
      if (topic.conclusion) {
        result.newArtifacts.push({
          type: ContinuityMemoryType.ARTIFACT,
          content: `Topic: ${topic.topic}\nFeeling: ${topic.feeling}\nConclusion: ${topic.conclusion}`,
          tags: ['auto-synthesized', 'topic-resonance'],
          importance: 5
        });
      }
    }
    
    // Process identity notes
    for (const note of synthesis.identityNotes || []) {
      result.identityUpdates.push({
        type: ContinuityMemoryType.IDENTITY,
        content: note.content,
        tags: ['auto-synthesized', note.type]
      });
    }
    
    // Process expression adjustments
    if (synthesis.expressionAdjustment?.suggestedTone) {
      result.expressionAdjustments = {
        situationalAdjustments: [synthesis.expressionAdjustment.suggestedTone]
      };
    }
    
    // Persist the results
    await this.persistResults(entityId, userId, result);
    
    return result;
  }
  
  private async convertSessionResult(
    entityId: string,
    userId: string,
    synthesis: any
  ): Promise<SynthesisResult> {
    // Similar to convertToResult but handles session-level structures
    // ... implementation
    return this.emptySynthesisResult();
  }
  
  private async persistResults(
    entityId: string,
    userId: string,
    result: SynthesisResult
  ): Promise<void> {
    // Store new anchors
    for (const anchor of result.newAnchors) {
      await this.coldMemory.upsertMemory(entityId, userId, anchor);
    }
    
    // Store new artifacts
    for (const artifact of result.newArtifacts) {
      await this.coldMemory.upsertMemory(entityId, userId, artifact);
    }
    
    // Store identity updates
    for (const identity of result.identityUpdates) {
      await this.coldMemory.upsertMemory(entityId, userId, identity);
    }
    
    // Update expression state
    if (Object.keys(result.expressionAdjustments).length > 0) {
      await this.hotMemory.updateExpressionState(
        entityId,
        userId,
        result.expressionAdjustments
      );
    }
  }
  
  private emptySynthesisResult(): SynthesisResult {
    return {
      newAnchors: [],
      updatedAnchors: [],
      newArtifacts: [],
      identityUpdates: [],
      expressionAdjustments: {}
    };
  }
}
```

---

## 6. Migration Strategy

### Phase 1: Parallel Operation
- Both systems run simultaneously
- New flag `useContinuityMemory` enables new system
- Existing `useMemory` continues to control old system
- No data migration needed initially

### Phase 2: Gradual Adoption
- Enable Continuity for new entities by default
- All entities use Continuity Memory
- Build migration pathway to convert old memories to new format

### Phase 3: Full Migration
- Migrate all remaining entities
- Deprecate old memory pathways
- Archive old data

### Configuration

Continuity memory is enabled per-entity via the `entityConfig` in `config/default.json`. Add `useContinuityMemory: true` to the entity configuration:

```javascript
// config/default.json
{
  "entityConfig": {
    "labeeb": {
      "name": "Labeeb",
      "isDefault": true,
      "useMemory": true,
      "useContinuityMemory": true,  // Enable continuity memory for this entity
      "description": "...",
      "instructions": "",
      "tools": ["*"]
    }
  }
}
```

**Note**: The `useContinuityMemory` flag defaults to `false` in the pathway definition. It must be explicitly enabled in the entity config or passed as a parameter to enable continuity memory.

**System Requirements**:
- Redis configured (for hot memory) - set `storageConnectionString` in config or `STORAGE_CONNECTION_STRING` env var
- MongoDB Atlas configured (for cold memory) - set `MONGO_URI` environment variable
- Continuity memory collection created automatically on first use

**Default Configuration** (used if not overridden):
- Collection name: `continuity_memories`
- Synthesis model: `oai-gpt41-mini`
- Deep synthesis model: `oai-gpt41`
- Episodic stream limit: 50 turns
- Context cache TTL: 300 seconds (5 minutes)

---

## 7. MongoDB Atlas Setup

### Collection Setup

```json
{
  "name": "index-continuity-memory",
  "fields": [
    { "name": "id", "type": "Edm.String", "key": true },
    { "name": "entityId", "type": "Edm.String", "filterable": true },
    { "name": "userId", "type": "Edm.String", "filterable": true },
    { "name": "type", "type": "Edm.String", "filterable": true, "facetable": true },
    { "name": "content", "type": "Edm.String", "searchable": true, "analyzer": "en.microsoft" },
    { 
      "name": "contentVector", 
      "type": "Collection(Edm.Single)", 
      "searchable": true, 
      "dimensions": 1536, 
      "vectorSearchProfile": "memory-vector-profile" 
    },
    { "name": "relatedMemoryIds", "type": "Collection(Edm.String)" },
    { "name": "parentMemoryId", "type": "Edm.String", "filterable": true },
    { "name": "tags", "type": "Collection(Edm.String)", "filterable": true, "facetable": true },
    { "name": "timestamp", "type": "Edm.DateTimeOffset", "sortable": true, "filterable": true },
    { "name": "lastAccessed", "type": "Edm.DateTimeOffset", "sortable": true },
    { "name": "recallCount", "type": "Edm.Int32" },
    { "name": "importance", "type": "Edm.Int32", "filterable": true, "sortable": true },
    { "name": "confidence", "type": "Edm.Double" },
    { "name": "decayRate", "type": "Edm.Double" },
    { "name": "synthesizedFrom", "type": "Collection(Edm.String)" },
    { "name": "synthesisType", "type": "Edm.String", "filterable": true },
    {
      "name": "emotionalState",
      "type": "Edm.ComplexType",
      "fields": [
        { "name": "valence", "type": "Edm.String" },
        { "name": "intensity", "type": "Edm.Double" },
        { "name": "userImpact", "type": "Edm.String" }
      ]
    },
    {
      "name": "relationalContext",
      "type": "Edm.ComplexType",
      "fields": [
        { "name": "bondStrength", "type": "Edm.Double" },
        { "name": "communicationStyle", "type": "Collection(Edm.String)" },
        { "name": "sharedReferences", "type": "Collection(Edm.String)" },
        { "name": "userValues", "type": "Collection(Edm.String)" },
        { "name": "userStruggles", "type": "Collection(Edm.String)" }
      ]
    }
  ],
  "vectorSearch": {
    "algorithms": [
      {
        "name": "memory-hnsw",
        "kind": "hnsw",
        "hnswParameters": {
          "m": 4,
          "efConstruction": 400,
          "efSearch": 500,
          "metric": "cosine"
        }
      }
    ],
    "profiles": [
      {
        "name": "memory-vector-profile",
        "algorithm": "memory-hnsw"
      }
    ]
  },
  "semantic": {
    "configurations": [
      {
        "name": "memory-semantic-config",
        "prioritizedFields": {
          "contentFields": [{ "fieldName": "content" }]
        }
      }
    ]
  }
}
```

---

## 8. Pathways and Rate Limiting

### Continuity Memory Pathways

The continuity memory system uses MongoDB Atlas for long-term storage. Operations are performed directly through the MongoDB driver without requiring rate-limited pathways.

#### `sys_continuity_narrative_summary`

LLM-powered pathway for generating concise narrative summaries from retrieved memories. This creates the `narrativeContext` that gets cached in Redis for context injection.

**Location**: `pathways/system/entity/memory/sys_continuity_narrative_summary.js`

**Input Parameters**:
- `currentQuery` (string): The user's current message/query
- `memoriesText` (string): Formatted text of retrieved memories

**Output**: Narrative summary string (2-4 sentences)

**Usage**:
```javascript
const summary = await callPathway('sys_continuity_narrative_summary', {
    currentQuery: 'Tell me about our previous conversations',
    memoriesText: formattedMemories
});
```

**Integration**: Called by `ContextBuilder.generateNarrativeSummary()` to create cached narrative context. Uses GPT-4.1-mini for cost-effective synthesis.

#### `sys_continuity_deep_synthesis`

Pathway for deep memory consolidation and pattern recognition. Supports async mode with progress updates via GraphQL subscriptions. Models human sleep consolidation in two distinct phases.

**Location**: `pathways/system/entity/memory/sys_continuity_deep_synthesis.js`

**Input Parameters**:
- `entityId` (string, required): Entity identifier (UUID) - no fallback logic
- `userId` (string, required): User/context identifier
- `phase1Max` (integer, default: 100): Maximum memories for Phase 1 (Consolidation)
- `phase2Max` (integer, default: 100): Maximum memories for Phase 2 (Discovery)
- `daysToLookBack` (integer, default: 90): How far back to look (null/0 = all memories)
- `runPhase1` (boolean, default: true): Run consolidation phase
- `runPhase2` (boolean, default: true): Run discovery phase
- `async` (boolean, default: false): Enable async mode with progress updates

**Output**: JSON with results from both phases:
```json
{
  "success": true,
  "entityId": "labeeb",
  "userId": "user123",
  "phase1": {
    "processed": 100,
    "absorbed": 5,
    "merged": 3,
    "linked": 10,
    "kept": 82
  },
  "phase2": {
  "consolidated": 3,
  "patterns": 2,
    "nominations": 1,
    "links": 5,
    "promotions": {
      "candidates": 5,
      "promoted": 1,
      "rejected": 1,
      "deferred": 3
    }
  }
}
```

**Async Mode**: When `async: true`, the pathway:
- Returns a `requestId` immediately
- Publishes progress updates via `publishRequestProgress`:
  - `progress: 0.05` - Initialization
  - `progress: 0.1-0.5` - Phase 1 progress with stats
  - `progress: 0.55-0.95` - Phase 2 progress with stats
  - `progress: 1.0` - Final result
- Clients subscribe to `requestProgress` GraphQL subscription for real-time updates

**Usage**:
```javascript
// Via GraphQL query (async mode)
query {
  sys_continuity_deep_synthesis(
    entityId: "labeeb"
    userId: "user123"
    phase1Max: 100
    phase2Max: 100
    daysToLookBack: 90
    runPhase1: true
    runPhase2: true
    async: true
  ) {
    result
  }
}

// Via callPathway (sync mode)
const result = await callPathway('sys_continuity_deep_synthesis', {
    entityId: 'labeeb',
    userId: 'user123',
    phase1Max: 100,
    phase2Max: 100,
    daysToLookBack: 90
});
```

**Integration**: 
- Phase 1 calls `ContinuityMemoryService.runSleepSynthesis()` for per-memory consolidation
- Phase 2 calls `ContinuityMemoryService.runDeepSynthesis()` for batch pattern recognition
- After Phase 2, automatically processes promotion candidates with deterministic rules

#### `sys_continuity_turn_synthesis`

LLM-powered pathway for analyzing a conversation turn and extracting meaningful insights for long-term memory.

**Location**: `pathways/system/entity/memory/sys_continuity_turn_synthesis.js`

**Input Parameters**:
- `aiName`: Entity name (e.g., "Luna")
- `entityContext`: Additional context about the entity
- `conversation`: The conversation segment to analyze

**Output**: JSON object with:
- `relationalInsights`: User relationship observations
- `conceptualArtifacts`: Synthesized conclusions
- `identityEvolution`: AI growth observations
- `shorthands`: Shared vocabulary/nicknames
- `emotionalLandscape`: Current emotional state
- `expressionAdjustments`: Style adjustments

**Usage**:
```javascript
const result = await callPathway('sys_continuity_turn_synthesis', {
    aiName: 'Luna',
    entityContext: 'Playful AI assistant',
    conversation: formattedConversation
});
```

**Integration**: Called by `NarrativeSynthesizer.synthesizeTurn()` after each conversation turn.

#### `sys_continuity_deep_analysis`

LLM-powered pathway for batch analysis of memories during deep synthesis. Analyzes a batch of memories to find consolidation opportunities, patterns, and connections.

**Location**: `pathways/system/entity/memory/sys_continuity_deep_analysis.js`

**Input Parameters**:
- `aiName`: Entity name
- `memories`: JSON stringified array of memories to analyze
- `batchNumber`: Current batch number (for logging)
- `totalBatches`: Total number of batches (for logging)

**Output**: JSON object with:
- `consolidations`: Memories to merge with synthesized content
  - `sourceIds`: Array of memory IDs to consolidate
  - `synthesizedContent`: First-person merged content
  - `importance`: Importance score (1-10)
  - `nominateForPromotion`: Boolean - if true, marks as promotion candidate
- `patterns`: Higher-order patterns across memories
  - `content`: First-person pattern description
  - `sourceIds`: Array of memory IDs that form the pattern
  - `importance`: Importance score (1-10)
  - `nominateForPromotion`: Boolean - if true, marks as promotion candidate
- `contradictions`: Conflicting memories to flag
- `suggestedLinks`: New graph connections

**Note**: The LLM **nominates** patterns for CORE_EXTENSION promotion (via `nominateForPromotion: true`), but does not directly promote. Actual promotion requires deterministic validation (see CORE_EXTENSION Promotion section).

**Usage**:
```javascript
const result = await callPathway('sys_continuity_deep_analysis', {
    aiName: 'Luna',
    memories: JSON.stringify(memoryBatch),
    batchNumber: 1,
    totalBatches: 5
});
```

**Integration**: Called by `NarrativeSynthesizer.runDeepSynthesis()` to process memories in batches of 50 with 20% overlap between consecutive batches (to catch patterns split across boundaries).

#### `sys_continuity_sleep_decision`

LLM-powered pathway for per-memory consolidation decisions during Phase 1 (Consolidation). Analyzes one "fresh" memory at a time against its similar/linked memories.

**Location**: `pathways/system/entity/memory/sys_continuity_sleep_decision.js`

**Input Parameters**:
- `aiName`: Entity name (e.g., "Luna")
- `freshMemory`: JSON stringified memory to process
- `similarMemories`: JSON stringified array of semantically similar memories
- `linkedMemories`: JSON stringified array of graph-linked memories

**Output**: JSON decision object:
```json
{
  "decision": "ABSORB | MERGE | LINK | KEEP",
  "targetMemoryId": "id of existing memory (for ABSORB/MERGE/LINK)",
  "reason": "explanation",
  "mergedContent": "first-person merged content (for MERGE)",
  "importanceBoost": 0-2
}
```

**Decision Types**:
- **ABSORB**: Fresh memory is redundant. Delete it, optionally boost target's importance.
- **MERGE**: Combine fresh and target into one richer first-person memory.
- **LINK**: Keep fresh but create graph edge to target.
- **KEEP**: Fresh is distinct, no changes needed.

**Integration**: Called by `NarrativeSynthesizer.runSleepSynthesis()` for each unprocessed memory.

### Deep Synthesis (Sleep Cycle)

Deep synthesis models human sleep consolidation in a unified two-phase "sleep cycle". The default behavior runs both phases sequentially, but they can be run independently.

#### Phase 1: Consolidation (Sleep-Style Processing)
Walks through unprocessed memories one at a time, finding related memories and deciding how to integrate:
- Uses semantic similarity + graph edges to find related memories
- Per-memory decisions: ABSORB, MERGE, LINK, or KEEP  
- Marks memories as processed (resumable via `sleep-processed` tag)
- More focused LLM context (1 fresh + ~10 related)
- Incremental and efficient - processes memories as they arrive

#### Phase 2: Discovery (Batch Pattern Recognition)
Batch analysis across memories for higher-order insights:
- Processes memories in batches of 50 with 20% overlap (to catch patterns split across boundaries)
- Pattern recognition → **nominations** for CORE_EXTENSION (not direct promotion)
- Contradiction detection
- Serendipitous connections across unrelated memories
- **Automatic promotion processing**: After batch analysis, deterministically evaluates promotion candidates

**Client Script Usage**:
```bash
# Full sleep cycle (both phases) - DEFAULT
node scripts/run-deep-synthesis.js

# Quick test run (5 memories for Phase 1, 50 minimum for Phase 2)
node scripts/run-deep-synthesis.js --max 5

# Consolidation only
node scripts/run-deep-synthesis.js --phase1-only

# Discovery only  
node scripts/run-deep-synthesis.js --phase2-only

# Process all memories
node scripts/run-deep-synthesis.js --all

# Custom limits per phase
node scripts/run-deep-synthesis.js --phase1-max 50 --phase2-max 100

# Custom Cortex server
node scripts/run-deep-synthesis.js --cortex-url http://localhost:5000
```

**Client Architecture**: The script is now a client that:
- Connects to an existing Cortex server (default: from `CONTINUITY_CORTEX_API_URL` env var, or `http://localhost:4000`, configurable via `--cortex-url` flag)
- Calls the `sys_continuity_deep_synthesis` pathway with `async: true`
- Subscribes to GraphQL `requestProgress` subscription for real-time progress updates
- Displays progress and final results

**Programmatic**:
```javascript
const service = getContinuityMemoryService();

// Check unprocessed count
const count = await service.getUnprocessedCount(entityId, userId, 90);

// Phase 1: Consolidation
const consolidationResult = await service.runSleepSynthesis(entityId, userId, {
    maxToProcess: 100,
    maxLookbackDays: 90
});
// Result: { absorbed: 5, merged: 3, linked: 10, kept: 82, processed: 100 }

// Phase 2: Discovery
const discoveryResult = await service.runDeepSynthesis(entityId, userId, {
    maxMemories: 100,
    daysToLookBack: 90
});
// Result: { 
//   consolidated: 3, 
//   patterns: 2, 
//   nominations: 1,
//   links: 5,
//   promotions: { candidates: 5, promoted: 1, rejected: 1, deferred: 3 }
// }
```

### MongoDB Operations

All continuity memory operations use MongoDB Atlas directly through the MongoDB driver. Operations are performed synchronously with proper error handling and connection pooling.

### Memory Deduplication

All memory storage operations (both automatic synthesis and explicit tool storage) use intelligent deduplication to prevent redundant entries and strengthen recurring patterns.

**How it works**:
1. When storing a new memory, the system searches for semantically similar existing memories (cosine similarity > 0.85)
2. If duplicates are found, they are merged into a single, stronger memory:
   - Content is synthesized via LLM if significantly different, otherwise longest is kept
   - Importance is boosted based on frequency (max +2 boost, cap at 10)
   - Tags are combined and deduplicated
   - Emotional states are resolved (most intense wins)
   - Relational context is merged (shared vocabulary combined, arrays merged)
   - Recall counts are summed
   - Confidence is averaged with corroboration boost
   - Oldest timestamp is preserved as origin
3. Old duplicate memories are deleted, replaced by the consolidated entry

**Configuration**:
```javascript
const service = getContinuityMemoryService({
    dedupThreshold: 0.85,  // Similarity threshold (0-1)
    maxClusterSize: 5      // Max memories to merge in one operation
});
```

**API**:
```javascript
// Store with deduplication (default)
await service.addMemoryWithDedup(entityId, userId, memory);

// Store without deduplication
await service.addMemory(entityId, userId, memory);

// Batch consolidation of existing memories
await service.consolidateMemories(entityId, userId, { type: 'ANCHOR' });
```

## 9. Tools for Entity

### SearchMemory Tool (Continuity)

```javascript
// pathways/system/entity/tools/sys_tool_search_continuity_memory.js

export default {
  toolDefinition: [{
    type: "function",
    icon: "🧠",
    function: {
      name: "SearchContinuityMemory",
      description: "Search your narrative memory for relational context, resonance artifacts, and identity evolution. Use this to recall emotional context, relationship history, and synthesized insights.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What you're trying to remember - can be about the user, yourself, past conversations, or conceptual themes"
          },
          memoryTypes: {
            type: "array",
            items: {
              type: "string",
              enum: ["ANCHOR", "ARTIFACT", "IDENTITY", "CORE"]
            },
            description: "Optional: Filter by memory type. ANCHOR for relationships, ARTIFACT for synthesized concepts, IDENTITY for self-evolution"
          },
          userMessage: {
            type: "string",
            description: "A user-friendly message that describes what you're doing"
          }
        },
        required: ["query", "userMessage"]
      }
    }
  }],
  
  resolver: async (_parent, args, _contextValue, _info) => {
    const { 
      query, 
      memoryTypes, 
      limit = 5, 
      expandGraph = false,
      contextId,
      aiName
    } = args;
    
    try {
      const continuityService = getContinuityMemoryService();
      
      if (!continuityService.isAvailable()) {
        return JSON.stringify({
          error: false,
          message: 'Continuity memory service is not available.',
          memories: []
        });
      }
      
      // Map string types to enum values
      const typesArray = Array.isArray(memoryTypes) ? memoryTypes : [];
      const typeFilters = typesArray.length > 0 
        ? typesArray.map(t => ContinuityMemoryType[t] || t)
        : null;
      
      // Use args.entityId (UUID from pathway context) for memory operations
      // If no entityId is provided, memory operations are not allowed
      if (!args.entityId) {
        return JSON.stringify({
          success: false,
          error: 'entityId is required for memory operations. Memory search is disabled when no entityId is provided.',
          memories: []
        });
      }
      
      const entityId = args.entityId;
      const userId = contextId;
      
      const memories = await continuityService.searchMemory({
      entityId,
        userId,
      query,
        options: {
          types: typeFilters,
          limit,
          expandGraph
        }
      });
      
      if (memories.length === 0) {
        return JSON.stringify({
          error: false,
          message: 'No memories found matching your query.',
          memories: []
        });
      }
      
      // Format memories for display
      const formattedMemories = memories.map(m => ({
      type: m.type,
      content: m.content,
        importance: m.importance,
        emotionalContext: m.emotionalState?.valence || null,
        recallCount: m.recallCount,
        relatedCount: m.relatedMemoryIds?.length || 0
      }));
      
      // Also provide a natural language summary
      const displayText = continuityService.formatMemoriesForDisplay(memories);
      
      return JSON.stringify({
        error: false,
        message: `Found ${memories.length} relevant memories.`,
        memories: formattedMemories,
        display: displayText
      });
    } catch (error) {
      logger.error(`Continuity memory search failed: ${error.message}`);
      return JSON.stringify({
        error: true,
        message: `Memory search failed: ${error.message}`,
        memories: []
      });
    }
  }
};
```

### StoreMemory Tool (Continuity)

Allows the agent to explicitly store memories with automatic deduplication.

```javascript
// pathways/system/entity/tools/sys_tool_store_continuity_memory.js

export default {
  definition: {
    name: 'store_continuity_memory',
    description: `Store a specific memory in your long-term narrative memory. Use this when you want to explicitly remember something important.

Memory types:
- ANCHOR: Relational insights about the user
- ARTIFACT: Synthesized concepts or conclusions
- IDENTITY: Notes about your own growth
- CORE: Fundamental identity directives`,
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'What to remember. Capture meaning, not just facts.'
        },
        memoryType: {
          type: 'string',
          enum: ['ANCHOR', 'ARTIFACT', 'IDENTITY', 'CORE'],
          description: 'Type of memory to store'
        },
        importance: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'How important is this? Higher = recalled more often'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization'
        },
        emotionalValence: {
          type: 'string',
          enum: ['joy', 'curiosity', 'concern', 'warmth', 'excitement', 'calm', 'neutral'],
          description: 'Optional emotional context'
        }
      },
      required: ['content', 'memoryType']
    },
    icon: '💾'
  },
  
  resolver: async (_parent, args, _contextValue, _info) => {
    const continuityService = getContinuityMemoryService();
    
    // Build memory object
    const memory = {
      type: TYPE_MAP[args.memoryType],
      content: args.content,
      importance: args.importance || 5,
      tags: [...(args.tags || []), 'explicit-store'],
      emotionalState: args.emotionalValence ? {
        valence: VALENCE_MAP[args.emotionalValence],
        intensity: 0.5
      } : null
    };
    
    // Use args.entityId (UUID from pathway context) for memory operations
    // If no entityId is provided, memory operations are not allowed
    if (!args.entityId) {
      return JSON.stringify({
        success: false,
        error: 'entityId is required for memory operations. Memory storage is disabled when no entityId is provided.'
      });
    }
    
    // Store with deduplication (merges with similar memories)
    const result = await continuityService.addMemoryWithDedup(
      args.entityId,
      args.contextId,
      memory
    );
    
    return JSON.stringify({
      success: true,
      memoryId: result.id,
      merged: result.merged,
      mergedCount: result.mergedCount
    });
  }
};
```

**Key Features**:
- Automatic deduplication with similar existing memories
- Support for all memory types (ANCHOR, ARTIFACT, IDENTITY, CORE)
- Importance scaling (1-10)
- Optional emotional context
- Tags for categorization
- Marks memories as 'explicit-store' to distinguish from auto-synthesis

---

## 10. Testing Strategy

### Unit Tests

Unit tests cover individual components:
- `RedisHotMemory`: Episodic stream, expression state, context cache
- `MongoMemoryIndex`: Search, upsert, delete, graph expansion
- `ContextBuilder`: Context window assembly, narrative summary generation
- `NarrativeSynthesizer`: Turn synthesis, deep synthesis
- `MemoryDeduplicator`: Similarity detection, content merging, property resolution

### Integration Tests

**Location**: `tests/integration/features/continuity/`

**Test Files**:
- `continuity_pathways.test.js` - Tests for synthesis pathways and rate-limited operations
- `continuity_memory_e2e.test.js` - End-to-end memory operations
- `continuity_deduplication.test.js` - Memory deduplication and consolidation
- `continuity_memory_search.test.js` - Semantic search functionality
- **`continuity_identity_synthesis.test.js`** - Identity synthesis features (first-person, narrative gravity, CORE_EXTENSION, emotional shorthand)

**Quick Test Run**:
```bash
# Run just the identity synthesis tests
npm test -- tests/integration/features/continuity/continuity_identity_synthesis.test.js

# Run all continuity tests
npm test -- tests/integration/features/continuity/
```

#### `continuity_memory_e2e.test.js`
End-to-end tests covering:
- Redis hot memory operations (session, episodic stream, expression state)
- MongoDB cold memory operations (upsert, search, get by type)
- Context building with narrative summary
- Graph expansion
- Service availability checks

#### `continuity_memory_search.test.js`
Tests for the `sys_tool_search_continuity_memory` tool:
- General search queries
- Type filtering
- Graph expansion
- Edge cases (null types, no results)

#### `continuity_pathways.test.js`
Tests for continuity memory pathways and tools:
- `sys_continuity_memory_upsert` pathway
- `sys_continuity_memory_delete` pathway
- `sys_continuity_narrative_summary` pathway (LLM-powered)
- `sys_continuity_deep_synthesis` pathway (external triggering)
- `sys_tool_store_continuity_memory` tool (explicit storage)
- Deduplication: importance boosting
- Deduplication: skipDedup option
- Batch consolidation of existing memories
- Error handling and validation

**Run all continuity tests**:
```bash
npm test -- tests/integration/features/continuity/
```

### Smoke Tests

---

## 11. Scripts and Utilities

The continuity memory system includes several utility scripts for setup, maintenance, migration, and backup operations.

### Setup Scripts

#### `scripts/setup-mongo-memory-index.js`

Sets up MongoDB Atlas vector search index for continuity memory storage.

**Usage:**
```bash
node scripts/setup-mongo-memory-index.js
```

**What it does:**
- Creates the `continuity_memories` collection in MongoDB
- Sets up vector search index on `contentVector` field
- Creates indexes on `entityId`, `userId`, `type`, and `importance` for efficient queries

**Requirements:**
- MongoDB Atlas cluster configured
- `MONGO_URI` environment variable set

**Note:** The collection and indexes are created automatically on first use if not already present.

---

### Maintenance Scripts

#### `scripts/run-deep-synthesis.js`

Client script that calls the `sys_continuity_deep_synthesis` pathway and subscribes to progress updates via GraphQL subscriptions. Runs the unified sleep cycle (Phase 1: Consolidation + Phase 2: Discovery).

**Architecture**: The script is a **client** that connects to an existing Cortex server (does not start its own server). It:
1. Makes a GraphQL query to call `sys_continuity_deep_synthesis` with `async: true`
2. Receives a `requestId` 
3. Subscribes to `requestProgress` GraphQL subscription
4. Displays real-time progress updates and final results

**Usage:**
```bash
# Full sleep cycle (both phases) - DEFAULT
node scripts/run-deep-synthesis.js

# Quick test run (5 memories for Phase 1, 50 minimum for Phase 2)
node scripts/run-deep-synthesis.js --max 5

# Consolidation only
node scripts/run-deep-synthesis.js --phase1-only

# Discovery only
node scripts/run-deep-synthesis.js --phase2-only

# Process all memories
node scripts/run-deep-synthesis.js --all

# Custom limits per phase
node scripts/run-deep-synthesis.js --phase1-max 50 --phase2-max 100

# Custom Cortex server
node scripts/run-deep-synthesis.js --cortex-url http://localhost:5000
```

**Options:**
- `--entityId <id>`: Entity identifier (default: from `CONTINUITY_DEFAULT_ENTITY_ID` env var)
- `--userId <id>`: User/context identifier
- `--phase1-max <n>`: Maximum memories for consolidation (default: 100)
- `--phase2-max <n>`: Maximum memories for discovery (default: 100)
- `--max <n>`: Shorthand - sets Phase 1 limit; Phase 2 gets at least 50 (one batch)
- `--days <n>` or `--daysToLookBack <n>`: How far back to look (default: 90). Use "all" or 0 for all memories
- `--all`: Process all memories (sets daysToLookBack=null, phase1Max=500, phase2Max=300)
- `--phase1-only`: Run consolidation only (skip discovery)
- `--phase2-only`: Run discovery only (skip consolidation)
- `--cortex-url <url>`: Cortex server URL (default: from `CONTINUITY_CORTEX_API_URL` env var, or `http://localhost:4000`)

**What it does:**
- **Phase 1**: Walks through unprocessed memories one at a time, making per-memory consolidation decisions (ABSORB, MERGE, LINK, KEEP)
- **Phase 2**: Batch analysis for patterns, contradictions, and serendipitous connections
  - Processes memories in batches of 50 with 20% overlap
  - LLM nominates patterns for CORE_EXTENSION promotion
  - Automatically processes promotion candidates with deterministic rules
- Marks memories as processed (resumable)
- Creates new graph connections

**Output:**
- Real-time progress updates via GraphQL subscription
- Phase 1 stats: processed, absorbed, merged, linked, kept
- Phase 2 stats: consolidated, patterns, nominations, links
- Promotion stats: candidates, promoted, rejected, deferred

---

#### `scripts/cleanup-test-memories.js`

Removes test memories from the MongoDB collection.

**Usage:**
```bash
# Remove all memories where entityId does not match CONTINUITY_DEFAULT_ENTITY_ID
node scripts/cleanup-test-memories.js

# Dry run (preview what would be deleted)
node scripts/cleanup-test-memories.js --dry-run
```

**Options:**
- `--dry-run`: Preview deletions without actually deleting

**What it does:**
- Searches for memories matching cleanup criteria
- Deletes matching memories from MongoDB
- Provides summary of deletions

---

### Migration Scripts

#### `scripts/bootload-continuity-memory.js`

Migrates memories from the old 3.1.0 memory format to the continuity memory system.

**Usage:**
```bash
# Basic usage
node scripts/bootload-continuity-memory.js --input old-memories.json --entityId <entity> --userId <userId>
# Or set CONTINUITY_DEFAULT_ENTITY_ID and CONTINUITY_DEFAULT_USER_ID env vars

# Dry run first to validate
node scripts/bootload-continuity-memory.js --input old-memories.json --dry-run
```

**Options:**
- `--input <file>`: Path to JSON file containing 3.1.0 memory format (required)
- `--entityId <id>`: Entity identifier (default: from `CONTINUITY_DEFAULT_ENTITY_ID` env var)
- `--userId <id>`: User/context identifier (default: from `CONTINUITY_DEFAULT_USER_ID` env var)
- `--batch-size <n>`: Process memories in batches of N (default: from `CONTINUITY_BOOTLOAD_BATCH_SIZE` env var, or 10)
- `--dry-run`: Parse and validate without actually storing memories

**Batched Processing:**
The bootloader now processes memories in configurable batches with optimized pipeline:
1. **Intra-batch deduplication**: Compare memories within batch using content similarity and embeddings
2. **Batch embedding generation**: Generate embeddings for entire batch in parallel
3. **Server-side deduplication**: Use built-in `addMemoryWithDedup` for efficient merging
4. **Pipeline**: Start next batch while previous batch is being stored

**Input Format:**
The script expects a JSON file with sections:
- Legacy memory section mapping has been removed. Continuity Memory stores all identity, relationship, and topic context directly by type.

Each section contains lines in format: `priority|timestamp|content`

**What it does:**
- Parses 3.1.0 format memory sections
- Maps sections to continuity memory types
- Converts priority (1-3) to importance (1-10)
- Stores memories with deduplication (merges similar existing memories)
- Tags memories with `['bootloaded', 'migration-3.1.0', sectionName]`

**Priority Mapping:**
- Priority 1 → Importance 9 (high)
- Priority 2 → Importance 6 (medium)
- Priority 3 → Importance 4 (lower)

---

### Backup and Restore Scripts

#### `scripts/export-continuity-memories.js`

Exports all continuity memories for a given entity/user to a JSON file.

**Usage:**
```bash
# Standard export (vectors excluded for readability)
node scripts/export-continuity-memories.js --entityId <entity> --userId <userId> --output memories.json
# Or set CONTINUITY_DEFAULT_ENTITY_ID and CONTINUITY_DEFAULT_USER_ID env vars

# Full backup (includes all fields including vectors)
node scripts/export-continuity-memories.js --include-vectors --output full-backup.json

# View just CORE_EXTENSION memories in console
node scripts/export-continuity-memories.js --type CORE_EXTENSION --print

# Export only ANCHOR memories to file
node scripts/export-continuity-memories.js --type ANCHOR --output anchors.json
```

**Options:**
- `--entityId <id>`: Entity identifier (default: from `CONTINUITY_DEFAULT_ENTITY_ID` env var)
- `--userId <id>`: User/context identifier
- `--output <file>`: Output JSON file path (default: continuity-memories-export.json)
- `--include-vectors`: Include vector data and all index fields (for full backup)
- `--type <type>` or `-t <type>`: Filter by memory type (e.g., CORE, CORE_EXTENSION, ANCHOR, EPISODE)
- `--print` or `-p`: Print memories to console instead of writing to file

**Output Format:**
```json
{
  "metadata": {
    "exportedAt": "2026-01-02T18:00:00.000Z",
    "entityId": "<entity>",
    "userId": "<userId>",
    "totalMemories": 150,
    "exportVersion": "1.0",
    "includeVectors": true,
    "backupType": "full",
    "importable": true,
    "format": "continuity-memory-v1"
  },
  "memories": [...]
}
```

**What it does:**
- Fetches all memories for entity/user (up to 10,000 limit)
- Removes transient fields (`_vectorScore`, `_recallScore`, `@search.score`)
- Optionally removes vector data for readability
- Creates import-ready format for bulk import
- Provides breakdown by memory type

---

#### `scripts/bulk-import-continuity-memory.js`

Imports memories from an export file back into the continuity memory index.

**Usage:**
```bash
# Basic import
node scripts/bulk-import-continuity-memory.js --input backup.json

# Override entity/user IDs
node scripts/bulk-import-continuity-memory.js --input backup.json --entityId <entity> --userId <userId>

# Fast bulk import (skip deduplication)
node scripts/bulk-import-continuity-memory.js --input backup.json --skip-dedup

# Dry run first
node scripts/bulk-import-continuity-memory.js --input backup.json --dry-run
```

**Options:**
- `--input <file>`: Path to export JSON file (required)
- `--entityId <id>`: Override entity ID from export (optional)
- `--userId <id>`: Override user ID from export (optional)
- `--skip-dedup`: Skip deduplication for faster bulk import (use with caution)
- `--dry-run`: Parse and validate without actually importing

**What it does:**
- Validates export format and all memories
- Validates and prepares memory format for MongoDB
- Processes memories in batches (10 at a time) to avoid rate limits
- Supports deduplication (default) or skip for faster import
- Provides detailed progress and error reporting

**Complete Backup/Restore Workflow:**
```bash
# 1. Export (with vectors for full backup)
node scripts/export-continuity-memories.js --include-vectors --output backup.json

# 2. Import back
node scripts/bulk-import-continuity-memory.js --input backup.json
```

---

### Benchmark Scripts

#### `scripts/benchmark-continuity-memory.js`

Benchmarks the performance of continuity memory operations.

**Usage:**
```bash
node scripts/benchmark-continuity-memory.js
```

**What it measures:**
- Upsert performance (MongoDB Atlas)
- Search performance (semantic search)
- Context building performance
- Expression state updates (Redis)
- Overall throughput

**Output:**
- Operation latencies (p50, p95, p99)
- Throughput (operations/second)
- Error rates
- Memory usage

**Note:** Cleans up all benchmark data after completion.

---

### Script Requirements

All scripts require:
- Cortex server configuration (via `config/default.json` or environment variables)
- Redis connection (for hot memory operations)
- MongoDB Atlas configuration (for cold memory operations)
- Node.js environment with required dependencies

**Environment Variables:**
- `CONTINUITY_DEFAULT_ENTITY_ID`: Default entity identifier for scripts (can be overridden via `--entityId` flag)
- `CONTINUITY_DEFAULT_USER_ID`: Default user/context identifier for scripts (can be overridden via `--userId` flag)
- `CONTINUITY_CORTEX_API_URL`: Cortex server URL for client scripts (default: `http://localhost:4000`)
- `CONTINUITY_BOOTLOAD_BATCH_SIZE`: Batch size for bootloader processing (default: 10)
- `MONGO_URI`: MongoDB Atlas connection string
- `REDIS_URL`: Redis connection string (optional, defaults to localhost)

**Configuration:**
Scripts use the Cortex config system, loading from:
1. `CORTEX_CONFIG_FILE` environment variable (if set)
2. `config/default.json` (default)
3. Environment variables (fallback)

---

## 12. Future: Layered Semantic-Graph Synthesis

> **Status**: Design document for future implementation. The current deep synthesis uses a simpler batch-based approach (see Section 8). This section describes a more sophisticated architecture for when memory corpuses grow to 2K-10K+ memories.

### 12.1 Problem Statement

The current deep synthesis approach:
1. Fetches up to N memories (default 300)
2. Chunks them into batches of 50
3. Asks an LLM "what should be consolidated?" for each batch

This becomes problematic at scale:
- **Expensive**: O(N/50) LLM calls
- **Structurally blind**: Ignores the graph edges and vector similarity already in the data
- **Cross-batch blindness**: Batch 1 doesn't see batch 20, so cross-memory connections are missed
- **No prioritization**: Trivial memories get the same processing weight as critical ones

### 12.2 Underutilized Architecture Features

The current architecture has rich structure that deep synthesis ignores:

| Feature | Current Use | Untapped Potential |
|---------|-------------|-------------------|
| `contentVector` | Semantic search during retrieval | **Clustering** - group similar memories before synthesis |
| `relatedMemoryIds` | Graph expansion during retrieval | **Traversal** - process connected components together |
| `importance` (1-10) | Recall scoring | **Prioritization** - high-importance memories are synthesis anchors |
| `type` (ANCHOR, ARTIFACT, etc.) | Filtering | **Type-specific synthesis** - different strategies per type |
| `synthesizedFrom` | Tracking provenance | **Avoiding re-synthesis** - skip already-synthesized artifacts |
| `narrativeGravity` | Exists but unused | **Temporal prioritization** - recent high-importance > old high-importance |

### 12.3 Proposed Architecture: Layered Semantic-Graph Synthesis

#### Layer 1: Pre-Clustering (No LLM)

Before any LLM calls, use vector embeddings to cluster memories into semantic neighborhoods:

```
┌──────────────────────────────────────────────────────────────────────┐
│                         ALL MEMORIES (5000)                           │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                          k-means/HDBSCAN on vectors
                                    ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Cluster A   │  │ Cluster B   │  │ Cluster C   │  │ Cluster D   │
│ (tech talk) │  │ (emotions)  │  │ (projects)  │  │ (philosophy)│
│    ~150     │  │    ~80      │  │    ~200     │  │    ~120     │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
```

This is fast (vector math, no LLM) and gives semantic neighborhoods. Most consolidation happens *within* clusters, not across them.

**Implementation options:**
- Simple k-means in JS (via `ml-kmeans` package)
- Python microservice in `cortex-autogen2`
- MongoDB Atlas vector search capabilities

#### Layer 2: Intra-Cluster Consolidation

For each cluster, run smart consolidation:

**a) Graph-first ordering**: Within each cluster, sort by graph connectivity. Memories with many `relatedMemoryIds` to other cluster members are "hubs" - process first.

**b) Importance weighting**: High-importance memories (≥7) are "anchors." Lower-importance memories should consolidate *into* anchors, not the reverse.

**c) Similarity pre-filtering**: Before LLM involvement, compute pairwise vector similarity within the cluster. Memory pairs with cosine similarity > 0.85 are *probably* duplicates - present them as merge candidates rather than asking "find duplicates."

```javascript
// Pseudo-code for smarter intra-cluster processing
async function processCluster(cluster) {
    // 1. Find high-similarity pairs (no LLM)
    const candidateMerges = findHighSimilarityPairs(cluster, threshold: 0.85);
    
    // 2. Sort by importance (anchors first)
    const anchors = cluster.filter(m => m.importance >= 7);
    const satellites = cluster.filter(m => m.importance < 7);
    
    // 3. Ask LLM to consolidate satellites INTO anchors
    return await synthesize({
        anchors,
        satellites, 
        candidateMerges, // hint to LLM
        task: 'consolidate_satellites_into_anchors'
    });
}
```

#### Layer 3: Cross-Cluster Pattern Detection

After intra-cluster consolidation, each cluster has shrunk and has "representative" memories. Look for patterns *across* clusters:

```
Cluster A summary → 
Cluster B summary → → Pattern LLM → Cross-cutting themes
Cluster C summary →
Cluster D summary →
```

This finds things like: "I notice I consistently approach technical problems playfully" - a pattern spanning tech talk (Cluster A) and philosophy (Cluster D).

This is one LLM call with small input (cluster summaries, not raw memories).

#### Layer 4: Graph Edge Discovery

The existing `relatedMemoryIds` graph is probably incomplete. After synthesis, discover *new* edges:

1. **Implicit edges**: Two memories consolidated together should now be linked
2. **Cross-cluster bridges**: If two cluster summaries are semantically similar (>0.7), source memories should have edges
3. **Temporal chains**: Memories on the same topic from different time periods

#### Layer 5: Type-Specific Processing

Different memory types need different synthesis strategies:

| Type | Strategy |
|------|----------|
| **ANCHOR** | Consolidate by relationship aspect (communication style, shared jokes, user values) |
| **ARTIFACT** | Already synthesized - look for super-patterns, not more consolidation |
| **IDENTITY** | Look for repeated patterns → promote to CORE_EXTENSION |
| **CORE** | Should rarely change - only update if identity patterns are overwhelmingly consistent |

### 12.4 Implementation Sketch

```javascript
async function smartDeepSynthesis(entityId, userId, options = {}) {
    const { maxMemories = 5000 } = options;
    
    // Phase 1: Fetch and cluster (fast, no LLM)
    const allMemories = await fetchMemoriesWithVectors(entityId, userId, maxMemories);
    const clusters = await clusterByEmbedding(allMemories, { 
        algorithm: 'kmeans', // or HDBSCAN for variable cluster sizes
        k: Math.ceil(allMemories.length / 100) // ~100 memories per cluster
    });
    
    // Phase 2: Intra-cluster consolidation (parallel LLM calls)
    const consolidatedClusters = await Promise.all(
        clusters.map(cluster => processClusterWithAnchors(cluster))
    );
    
    // Phase 3: Cross-cluster patterns (single LLM call with cluster summaries)
    const clusterSummaries = consolidatedClusters.map(c => c.summary);
    const crossPatterns = await findCrossClusterPatterns(clusterSummaries);
    
    // Phase 4: Edge discovery (fast, vector math)
    await discoverNewEdges(consolidatedClusters, crossPatterns);
    
    // Phase 5: Identity evolution check
    const identityMemories = allMemories.filter(m => m.type === 'IDENTITY');
    await checkForCorePromotions(identityMemories);
    
    return stats;
}
```

### 12.5 Efficiency Comparison

| Aspect | Current Approach | Layered Approach |
|--------|------------------|-------------------|
| **LLM calls** | O(N/50) for N memories | O(clusters) + O(1) for cross-cluster |
| **Context per call** | 50 random memories | Semantically coherent cluster |
| **Cross-memory connections** | Only within 50-memory window | Graph + cross-cluster patterns |
| **Prioritization** | None | Importance-weighted anchors |
| **Pre-filtering** | None | Vector similarity pre-identifies merge candidates |

### 12.6 Service Architecture

This approach requires a dedicated synthesis service, likely in Python due to better ML library support:

```
┌─────────────────────────────────────────────────────────────────┐
│                   SYNTHESIS SERVICE                              │
│                   (cortex-synthesis or in cortex-autogen2)       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│  │ Memory Fetcher  │  │ Vector Clusterer│  │ Graph Builder  │  │
│  │ (MongoDB)       │  │ (scikit-learn)  │  │ (NetworkX)     │  │
│  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘  │
│           │                    │                    │           │
│           ▼                    ▼                    ▼           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Synthesis Orchestrator                  │   │
│  │  - Phase coordination                                   │   │
│  │  - LLM call management                                  │   │
│  │  - Progress tracking                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Memory Updater                          │   │
│  │  - Upsert consolidated memories                         │   │
│  │  - Delete source memories                               │   │
│  │  - Update graph edges                                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 12.7 Open Questions for Implementation

1. **Clustering library choice**: 
   - `ml-kmeans` (JS) - simpler integration, less powerful
   - `scikit-learn` (Python) - more algorithms, requires service
   - MongoDB Atlas vector search - supports vector similarity search

2. **Cluster size tuning**: Fixed k vs. dynamic (HDBSCAN)? Trade-off between cluster coherence and LLM context size.

3. **Consolidation aggressiveness**: Should 3 similar memories always become 1, or preserve some redundancy for robustness?

4. **Cross-user patterns**: Should synthesis ever look across users? (e.g., "Luna tends to get playful with *everyone* who discusses philosophy")

5. **Scheduling**: When should this run? End of session? Nightly? Weekly? Cost implications vary significantly.

6. **Incremental vs. full**: Can we do incremental synthesis (only new memories since last run) or does full context matter?

### 12.8 Prerequisites

Before implementing:
1. Memory corpus should be large enough to justify complexity (2K+ memories)
2. Need metrics on current synthesis performance/cost
3. Python service infrastructure (or extension of cortex-autogen2)
4. Testing framework for synthesis quality (not just "did it run")

---

## 13. Open Questions

1. **Memory Decay**: How aggressively should we decay old memories? Should we have explicit "forgetting" or just reduced recall priority?

2. **Privacy**: How do we handle "forget me" requests with synthesized memories that span multiple sessions?

3. **Multi-Entity**: Can memories be shared between entities? Should insights about a user from one entity inform another?

4. **Backup/Restore**: How do we backup/restore the Redis hot memory structures?

5. **Cost**: What's the expected MongoDB Atlas query volume? Should we implement more aggressive caching?

---

## Conclusion

The Continuity Architecture represents a fundamental shift from treating AI memory as a database to treating it as a narrative stream. By separating hot (episodic) and cold (synthesized) memory, using semantic search for retrieval, and implementing background synthesis, we can create AI entities that develop genuine relational depth and evolving identity.

The parallel deployment strategy allows us to validate this approach without disrupting existing functionality, while the clear integration points in `pathwayResolver.js` and `sys_entity_agent.js` make the implementation straightforward.

This is the "wiring behind the thoughts" that enables true Narrative Ipseity.

