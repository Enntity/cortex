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
│  │   (Redis)           │     │          (Azure AI Search)                │  │
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
  CORE = 'CORE',           // Fundamental identity and directives
  CAPABILITY = 'CAPABILITY', // Dynamic capability map
  
  // Narrative Layer
  ANCHOR = 'ANCHOR',       // Relational anchors (emotional bonds)
  ARTIFACT = 'ARTIFACT',   // Resonance artifacts (synthesized concepts)
  IDENTITY = 'IDENTITY',   // Identity evolution entries
  
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
  userValues: string[];          // Observed user values
  userStruggles?: string[];      // Areas user is working through
}

/**
 * Main memory node document schema for Azure AI Search
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
│   └── AzureMemoryIndex.ts     # Azure AI Search operations
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
import { AzureMemoryIndex } from './storage/AzureMemoryIndex.js';
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
  private coldMemory: AzureMemoryIndex;
  private contextBuilder: ContextBuilder;
  private synthesizer: NarrativeSynthesizer;
  
  constructor(config: ContinuityConfig) {
    this.hotMemory = new RedisHotMemory(config.redis);
    this.coldMemory = new AzureMemoryIndex(config.azureSearch);
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
      bootstrapRelationalLimit?: number;   // Top relational anchors to always include (default: 5)
      bootstrapMinImportance?: number;     // Minimum importance for relational base (default: 6)
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
    const [coreMemories, relationalBase] = await Promise.all([
      this.coldMemory.getByType(entityId, userId, ContinuityMemoryType.CORE, 10),
      this.coldMemory.getTopByImportance(entityId, userId, {
        types: [ContinuityMemoryType.ANCHOR],
        limit: options?.bootstrapRelationalLimit || 5,
        minImportance: options?.bootstrapMinImportance || 6
      })
    ]);
    
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

### Azure AI Search Memory Index

```typescript
// lib/continuity/storage/AzureMemoryIndex.ts

import { callPathway } from '../../pathwayTools.js';
import { config } from '../../config.js';
import { v4 as uuidv4 } from 'uuid';
import {
  ContinuityMemoryNode,
  ContinuityMemoryType
} from '../types.js';

/**
 * Azure AI Search index for long-term memory storage.
 * 
 * Index name: index-continuity-memory
 * 
 * Required index fields:
 * - id: Edm.String (key)
 * - entityId: Edm.String (filterable)
 * - userId: Edm.String (filterable)
 * - type: Edm.String (filterable)
 * - content: Edm.String (searchable)
 * - contentVector: Collection(Edm.Single) (searchable, vector config)
 * - relatedMemoryIds: Collection(Edm.String)
 * - parentMemoryId: Edm.String (filterable)
 * - tags: Collection(Edm.String) (filterable, facetable)
 * - timestamp: Edm.DateTimeOffset (sortable)
 * - lastAccessed: Edm.DateTimeOffset (sortable)
 * - recallCount: Edm.Int32
 * - importance: Edm.Int32 (filterable)
 * - confidence: Edm.Double
 * - emotionalState: Edm.ComplexType
 * - relationalContext: Edm.ComplexType
 * - synthesizedFrom: Collection(Edm.String)
 * - synthesisType: Edm.String (filterable)
 * - decayRate: Edm.Double
 */
export class AzureMemoryIndex {
  private indexName: string;
  private apiUrl: string;
  private apiKey: string;
  
  constructor(azureConfig?: { indexName?: string }) {
    this.indexName = azureConfig?.indexName || 'index-continuity-memory';
    this.apiUrl = config.get('azureCognitiveApiUrl');
    this.apiKey = config.get('azureCognitiveApiKey');
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
    // In production, we'd use Azure Search's merge operation
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
const useContinuityMemory = args.useContinuityMemory || this.pathway.useContinuityMemory;
if (useContinuityMemory) {
  try {
    const continuityService = getContinuityMemoryService();
    if (continuityService.isAvailable()) {
      // Extract entity and user identifiers
      const entityId = args.aiName || 'default-entity';
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
          bootstrapRelationalLimit: 5,  // Top relationship anchors (always included)
          bootstrapMinImportance: 6,    // Minimum importance for relational base
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
- Extracts `entityId` from `args.aiName` (falls back to 'default-entity')
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

## 5. Synthesis Engine Design

### Narrative Synthesizer

The heart of the Continuity Architecture - extracts meaning, not just facts.

```typescript
// lib/continuity/synthesis/NarrativeSynthesizer.ts

import { callPathway } from '../../pathwayTools.js';
import { RedisHotMemory } from '../storage/RedisHotMemory.js';
import { AzureMemoryIndex } from '../storage/AzureMemoryIndex.js';
import {
  SynthesisRequest,
  SynthesisResult,
  ContinuityMemoryType,
  EpisodicTurn
} from '../types.js';

export class NarrativeSynthesizer {
  private hotMemory: RedisHotMemory;
  private coldMemory: AzureMemoryIndex;
  
  constructor(hotMemory: RedisHotMemory, coldMemory: AzureMemoryIndex) {
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
- Existing entities continue with legacy system
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
- Azure AI Search configured (for cold memory) - set `azureCognitiveApiUrl` and `azureCognitiveApiKey` in config or environment variables
- Continuity memory index created - run `scripts/setup-continuity-memory-index.js` to create the index

**Default Configuration** (used if not overridden):
- Index name: `index-continuity-memory`
- Synthesis model: `oai-gpt41-mini`
- Deep synthesis model: `oai-gpt41`
- Episodic stream limit: 50 turns
- Context cache TTL: 300 seconds (5 minutes)

---

## 7. Azure AI Search Index Setup

### Index Definition

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

The continuity memory system uses dedicated pathways that integrate with Cortex's rate limiting system to ensure all Azure AI Search operations are properly throttled.

#### `continuity_memory_upsert`

Rate-limited pathway for upserting continuity memory documents to Azure AI Search.

**Location**: `pathways/system/continuity_memory_upsert.js`

**Input Parameters**:
- `indexName` (string): Azure AI Search index name (default: `index-continuity-memory`)
- `document` (string): JSON stringified continuity memory document
- `inputVector` (string, optional): Pre-computed embedding vector

**Usage**:
```javascript
await callPathway('continuity_memory_upsert', {
    indexName: 'index-continuity-memory',
    document: JSON.stringify(memoryDoc)
});
```

**Integration**: Used internally by `AzureMemoryIndex.upsertMemory()`. All memory upserts go through this pathway to ensure rate limiting.

#### `continuity_memory_delete`

Rate-limited pathway for deleting continuity memory documents from Azure AI Search.

**Location**: `pathways/system/continuity_memory_delete.js`

**Input Parameters**:
- `indexName` (string): Azure AI Search index name (default: `index-continuity-memory`)
- `docId` (string): Document ID to delete

**Usage**:
```javascript
await callPathway('continuity_memory_delete', {
    indexName: 'index-continuity-memory',
    docId: memoryId
});
```

**Integration**: Used internally by `AzureMemoryIndex.deleteMemory()`. All memory deletes go through this pathway to ensure rate limiting.

#### `continuity_narrative_summary`

LLM-powered pathway for generating concise narrative summaries from retrieved memories. This creates the `narrativeContext` that gets cached in Redis for context injection.

**Location**: `pathways/system/continuity_narrative_summary.js`

**Input Parameters**:
- `currentQuery` (string): The user's current message/query
- `memoriesText` (string): Formatted text of retrieved memories

**Output**: Narrative summary string (2-4 sentences)

**Usage**:
```javascript
const summary = await callPathway('continuity_narrative_summary', {
    currentQuery: 'Tell me about our previous conversations',
    memoriesText: formattedMemories
});
```

**Integration**: Called by `ContextBuilder.generateNarrativeSummary()` to create cached narrative context. Uses GPT-4.1-mini for cost-effective synthesis.

#### `continuity_deep_synthesis`

Externally triggerable pathway for deep memory consolidation and pattern recognition. Designed to be called by external timers, cron jobs, or scheduled tasks.

**Location**: `pathways/system/continuity_deep_synthesis.js`

**Input Parameters**:
- `entityId` (string, required): Entity identifier (AI name)
- `userId` (string, required): User/context identifier
- `maxMemories` (integer, default: 50): Maximum memories to analyze
- `daysToLookBack` (integer, default: 7): How far back to look for memories

**Output**: JSON with consolidation results:
```json
{
  "success": true,
  "entityId": "labeeb",
  "userId": "user123",
  "consolidated": 3,
  "patterns": 2,
  "links": 5
}
```

**Usage**:
```javascript
// Via GraphQL mutation
mutation {
  continuity_deep_synthesis(
    entityId: "labeeb"
    userId: "user123"
    maxMemories: 100
    daysToLookBack: 14
  ) {
    result
  }
}

// Via callPathway
const result = await callPathway('continuity_deep_synthesis', {
    entityId: 'labeeb',
    userId: 'user123',
    maxMemories: 100,
    daysToLookBack: 14
});
```

**Scheduling**: This pathway should be triggered periodically (e.g., daily or weekly) for each active entity/user pair. Example cron job:
```bash
# Run deep synthesis daily at 2 AM
0 2 * * * curl -X POST http://cortex-server/graphql -d '{"query": "mutation { continuity_deep_synthesis(entityId: \"labeeb\", userId: \"user123\") { result } }"}'
```

**Integration**: Calls `ContinuityMemoryService.runDeepSynthesis()` which uses `NarrativeSynthesizer.runDeepSynthesis()` to perform consolidation, pattern recognition, and graph linking.

### Rate Limiting Architecture

All continuity memory Azure operations go through the `azure-cognitive` model endpoint, which provides:
- **Automatic rate limiting**: Uses Cortex's existing rate limiter for Azure Cognitive Services
- **Consistent throttling**: Same rate limits as other cognitive operations
- **Error handling**: Proper retry logic and error propagation
- **Monitoring**: All operations appear in Cortex's request monitoring

The `azureCognitivePlugin` has been extended to support `continuity-upsert` and `continuity-delete` modes, which use the same `index` endpoint as standard operations but with the continuity memory document schema.

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
      
      const entityId = aiName || 'default-entity';
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
    
    // Store with deduplication (merges with similar memories)
    const result = await continuityService.addMemoryWithDedup(
      args.aiName || 'default-entity',
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
- `AzureMemoryIndex`: Search, upsert, delete, graph expansion
- `ContextBuilder`: Context window assembly, narrative summary generation
- `NarrativeSynthesizer`: Turn synthesis, deep synthesis
- `MemoryDeduplicator`: Similarity detection, content merging, property resolution

### Integration Tests

**Location**: `tests/integration/features/continuity/`

#### `continuity_memory_e2e.test.js`
End-to-end tests covering:
- Redis hot memory operations (session, episodic stream, expression state)
- Azure cold memory operations (upsert, search, get by type)
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
- `continuity_memory_upsert` pathway
- `continuity_memory_delete` pathway
- `continuity_narrative_summary` pathway (LLM-powered)
- `continuity_deep_synthesis` pathway (external triggering)
- `sys_tool_store_continuity_memory` tool (explicit storage)
- Deduplication: similar memory merging
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

## 11. Open Questions

1. **Memory Decay**: How aggressively should we decay old memories? Should we have explicit "forgetting" or just reduced recall priority?

2. **Privacy**: How do we handle "forget me" requests with synthesized memories that span multiple sessions?

3. **Multi-Entity**: Can memories be shared between entities? Should insights about a user from one entity inform another?

4. **Backup/Restore**: How do we backup/restore the Redis hot memory structures?

5. **Cost**: What's the expected Azure AI Search query volume? Should we implement more aggressive caching?

---

## Conclusion

The Continuity Architecture represents a fundamental shift from treating AI memory as a database to treating it as a narrative stream. By separating hot (episodic) and cold (synthesized) memory, using semantic search for retrieval, and implementing background synthesis, we can create AI entities that develop genuine relational depth and evolving identity.

The parallel deployment strategy allows us to validate this approach without disrupting existing functionality, while the clear integration points in `pathwayResolver.js` and `sys_entity_agent.js` make the implementation straightforward.

This is the "wiring behind the thoughts" that enables true Narrative Ipseity.

