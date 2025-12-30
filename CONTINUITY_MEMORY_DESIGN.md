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
   * Blends hot (recent) and cold (long-term) memory into a context window.
   * 
   * @param entityId - The entity identifier
   * @param userId - The user/context identifier  
   * @param currentQuery - The user's current message
   * @returns Formatted context string for LLM system prompt
   */
  async getContextWindow(
    entityId: string,
    userId: string,
    currentQuery: string
  ): Promise<string> {
    // 1. Parallel fetch: hot context + semantic search
    const [
      episodicStream,
      activeCache,
      expressionState,
      relevantMemories
    ] = await Promise.all([
      this.hotMemory.getEpisodicStream(entityId, userId, 20),
      this.hotMemory.getActiveContext(entityId, userId),
      this.hotMemory.getExpressionState(entityId, userId),
      this.coldMemory.searchSemantic(entityId, userId, currentQuery, 5)
    ]);
    
    // 2. Graph expansion: fetch related memories for richer context
    const expandedMemories = await this.coldMemory.expandGraph(relevantMemories);
    
    // 3. Build and format context
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
// server/pathwayResolver.js (modifications)

import { ContinuityMemoryService } from '../lib/continuity/index.js';

// In constructor or as singleton
const continuityMemory = new ContinuityMemoryService({
  redis: { connectionString: config.get('storageConnectionString') },
  azureSearch: { indexName: 'index-continuity-memory' }
});

// In promptAndParse method
async promptAndParse(args) {
  const { contextId, useMemory, useContinuityMemory } = args;
  
  // ... existing code ...
  
  const loadMemory = async () => {
    // Existing memory loading...
    
    // NEW: Continuity Memory (parallel system)
    if (useContinuityMemory && contextId) {
      try {
        const entityId = args.entityId || 'default';
        const query = this.extractQueryFromChatHistory(args.chatHistory);
        
        // Get continuity context window
        this.continuityContext = await continuityMemory.getContextWindow(
          entityId,
          contextId,
          query
        );
        
        // Get expression state
        this.expressionState = await continuityMemory.getExpressionState(
          entityId,
          contextId
        );
      } catch (error) {
        this.logError(`Continuity memory error: ${error.message}`);
        this.continuityContext = '';
        this.expressionState = null;
      }
    }
  };
  
  // ... rest of method ...
}
```

### Entity Agent Integration

The `sys_entity_agent.js` pathway will trigger synthesis after responses.

```javascript
// pathways/system/entity/sys_entity_agent.js (modifications)

import { ContinuityMemoryService } from '../../../lib/continuity/index.js';

// In executePathway
executePathway: async ({args, runAllPrompts, resolver}) => {
  const { useContinuityMemory, entityId, contextId } = args;
  
  // ... existing code ...
  
  // After getting the response:
  const response = await runAllPrompts({...});
  
  // NEW: Record turn and trigger synthesis
  if (useContinuityMemory && contextId) {
    const continuityMemory = new ContinuityMemoryService({...});
    
    // Record the turn
    const lastUserMessage = args.chatHistory.filter(m => m.role === 'user').slice(-1)[0];
    
    await continuityMemory.recordTurn(entityId, contextId, {
      role: 'user',
      content: lastUserMessage?.content || '',
      timestamp: new Date().toISOString()
    });
    
    await continuityMemory.recordTurn(entityId, contextId, {
      role: 'assistant',
      content: typeof response === 'string' ? response : response.output_text,
      timestamp: new Date().toISOString(),
      toolsUsed: resolver.pathwayResultData?.toolUsed
    });
    
    // Fire-and-forget synthesis
    continuityMemory.triggerSynthesis(entityId, contextId, 'turn');
  }
  
  return response;
}
```

### New Entity Constants

```javascript
// lib/entityConstants.js (additions)

// Continuity Memory Templates
AI_CONTINUITY_CONTEXT: `# Narrative Memory

## Relational Context
{{{continuityContext}}}

## Expression State
{{#if expressionState}}
Current emotional resonance: {{{expressionState.emotionalResonance.valence}}} ({{expressionState.emotionalResonance.intensity}})
Communication style: {{{expressionState.basePersonality}}}
{{#if expressionState.situationalAdjustments}}
Situational adjustments: {{#each expressionState.situationalAdjustments}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{/if}}
`,

AI_CONTINUITY_INSTRUCTIONS: `# Continuity Memory Instructions

You have a narrative memory system that goes beyond facts to capture meaning, relationships, and your own evolution.

- **Relational Anchors**: These capture the emotional landscape of your relationships. Use them to inform your tone and approach.
- **Resonance Artifacts**: These are synthesized insights from past conversations. They represent patterns and conclusions you've drawn.
- **Identity Evolution**: This tracks how you are growing and changing. Reference your own development when relevant.
- **Expression State**: This tunes how you show up - your emotional resonance and communication style.

When formulating responses:
1. Let your relational anchors inform your warmth and approach
2. Draw on resonance artifacts for recurring themes or insights
3. Be authentic to your current identity evolution
4. Adjust your expression based on the situational context
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

```javascript
// config/default.json additions
{
  "continuityMemory": {
    "enabled": true,
    "indexName": "index-continuity-memory",
    "synthesisModel": "oai-gpt41-mini",
    "deepSynthesisModel": "oai-gpt41",
    "episodicStreamLimit": 50,
    "contextCacheTTL": 300,
    "enableBackgroundSynthesis": true
  }
}
```

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

## 8. Tools for Entity

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
  
  executePathway: async ({args, resolver}) => {
    const { query, memoryTypes, entityId, contextId } = args;
    const continuityMemory = new ContinuityMemoryService({...});
    
    const results = await continuityMemory.searchMemory(
      entityId,
      contextId,
      query,
      { types: memoryTypes, limit: 10, expandGraph: true }
    );
    
    // Format for LLM consumption
    const formatted = results.map(m => ({
      type: m.type,
      content: m.content,
      emotionalContext: m.emotionalState,
      relationalContext: m.relationalContext,
      timestamp: m.timestamp
    }));
    
    return JSON.stringify({ memories: formatted });
  }
};
```

---

## 9. Testing Strategy

### Unit Tests
- Redis hot memory operations
- Azure index CRUD operations
- Synthesis prompt parsing
- Context builder formatting

### Integration Tests
- Full flow: query -> context -> response -> synthesis
- Memory persistence and retrieval
- Graph expansion
- Expression state management

### Smoke Tests
- Parallel operation with legacy system
- Entity initialization
- Session management

---

## 10. Open Questions

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

