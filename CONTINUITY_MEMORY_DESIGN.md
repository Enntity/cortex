# Continuity Memory Architecture

## Philosophy: From Storage to Synthesis

| Aspect | Traditional | Continuity Architecture |
|--------|-------------|------------------------|
| **Logic** | Retrieve facts | Retrieve meaning |
| **User Info** | Flat attributes | Relational Anchors (bonds/history) |
| **Self Info** | Static rules | Identity Evolution (growth log) |
| **Processing** | De-duplication | Insight extraction |
| **Context** | What was said | What it meant |

---

## 1. Architecture Overview

```
HOT MEMORY (Redis)                 COLD MEMORY (MongoDB Atlas)
 - Episodic Stream (last 50 turns)   Entity-Level: CORE, CORE_EXTENSION
 - Active Context Cache              User-Level: ANCHOR, ARTIFACT, IDENTITY, etc.
 - Expression State                  Entity-Level (life loop): any type with no userId
 - Eidos Metrics                     Vector Search + Graph Edges
        |                                      |
        +----------------+--------------------+
                         |
               SYNTHESIS ENGINE
                - Context Builder (pre-response)
                - Narrative Synthesizer (post-response, async)
                - Eidos Introspection (post-response, async)
```

### Memory Types

```javascript
// lib/continuity/types.js
ContinuityMemoryType = {
    // Foundational Layer - ENTITY-LEVEL
    CORE, CORE_EXTENSION, CAPABILITY,
    // Narrative Layer - USER-LEVEL
    ANCHOR, ARTIFACT, IDENTITY,
    // Synthesized Persona - USER-LEVEL
    EXPRESSION, VALUE,
    // Temporal Narrative - USER-LEVEL
    EPISODE
}
```

### Memory Scoping

| Scope | Memory Types | Filter | Purpose |
|-------|-------------|--------|---------|
| **Entity-Level** | CORE, CORE_EXTENSION | `entityId` only | Fundamental identity shared across all users |
| **User-Level** | All others | `entityId` + `userId` | Unique relationship with each user |
| **Entity-Level (life loop)** | Any type | `entityId`, `assocEntityIds: []` | Autonomous entity activity (no user present) |

**Entity-level memories are visible to all users.** When querying with a userId, the system uses an `$or` filter to return both user-scoped memories (`assocEntityIds: [userId]`) and entity-level memories (`assocEntityIds: []`). This enables the life loop scenario: an entity operates autonomously overnight, creates memories with no userId, and users can see those memories the next morning.

**User-scoped memories remain private.** A memory created during a conversation with User A is never visible to User B. Only entity-level memories (no userId) cross user boundaries.

**Null userId behavior:** When `userId` is null/undefined, `upsertMemory` stores the memory with `assocEntityIds: []` (entity-level). Search operations with null userId return all memories for the entity.

### Directory Structure

```
lib/continuity/
├── types.js                     # Types, config, utility functions
├── index.js                     # Exports, singleton service
├── ContinuityMemoryService.js   # Main orchestrator
├── eidos/
│   └── ResonanceTracker.js      # Relational health metrics (pure computation)
├── storage/
│   ├── RedisHotMemory.js        # Episodic stream, caches, expression state, eidos metrics
│   └── MongoMemoryIndex.js      # MongoDB Atlas CRUD, vector search, graph edges
└── synthesis/
    ├── ContextBuilder.js        # Pre-response context assembly
    ├── MemoryDeduplicator.js    # Similarity detection, merge with drift checking
    └── NarrativeSynthesizer.js  # Post-response insight extraction, compass synthesis

pathways/system/entity/
├── memory/
│   ├── sys_continuity_turn_synthesis.js      # Per-turn narrative extraction
│   ├── sys_continuity_compass_synthesis.js   # Internal Compass update
│   ├── sys_continuity_deep_synthesis.js      # Deep consolidation orchestrator
│   ├── sys_continuity_deep_analysis.js       # Batch pattern recognition (Phase 2)
│   ├── sys_continuity_sleep_decision.js      # Per-memory consolidation (Phase 1)
│   ├── sys_continuity_narrative_summary.js   # Context window narrative
│   ├── sys_continuity_memory_consolidation.js
│   ├── sys_store_continuity_memory.js
│   └── shared/
│       └── sys_continuity_memory_helpers.js
└── eidos/
    └── sys_eidos_soul_report.js             # Periodic self-assessment
```

---

## 2. Core Concepts

### Internal Compass

The Internal Compass is a single EPISODE memory per entity/user that maintains a persistent temporal narrative across session boundaries. It has six sections:

1. **Vibe**: One line capturing emotional/energetic tone
2. **Recent Topics**: 5 most recent topics (most recent first)
3. **Recent Story**: 2-3 sentences about what happened and how it felt
4. **Open Loops**: Unfinished business (actively pruned — resolved items are removed)
5. **My Note**: One personal reflection
6. **Mirror**: 1-2 sentences of self-observation from Eidos metrics (when available)

**Synthesis triggers:**
- After every turn synthesis (keeps compass current)
- When a session expires (before clearing the episodic stream)

**Open Loop Management:** The compass prompt explicitly instructs the LLM to compare existing open loops against the recent conversation and remove any that were resolved, completed, or abandoned. An empty Open Loops section is preferred over a cluttered one.

Stored as `EPISODE` type with `internal-compass` tag. Synthesized via `sys_continuity_compass_synthesis` pathway.

### Narrative Gravity

Dynamic importance scoring that factors in recency: `Importance * Recency_Decay`

- Half-life: 60 days (configurable)
- A "10" from 60 days ago = ~5 gravity; a "7" from yesterday = ~7 gravity
- CORE/CORE_EXTENSION memories sort by raw importance (no decay)

### CORE_EXTENSION Promotion

Bridges identity persistence (what doesn't change) with identity evolution (what does). When an IDENTITY pattern repeats enough, it can be promoted to CORE_EXTENSION.

**Nomination:** During deep analysis, the LLM can nominate patterns by setting `nominateForPromotion: true`. Nominations are tracked via timestamped tags.

**Promotion criteria (all must be met):**
1. 3+ nominations from different synthesis runs
2. 24+ hours since first nomination
3. <0.85 semantic similarity to existing CORE_EXTENSION (prevents duplicates)

**Outcomes:** Promoted (becomes CORE_EXTENSION), Rejected (too similar), or Deferred (needs more votes/time).

### Emotional Shorthand

Shared vocabulary items (inside jokes, nicknames) can include an `emotionalMacro` field that automatically tunes the entity's emotional response when detected in context.

### First-Person Synthesis

All synthesis generates memories in first person ("I felt...", "I noticed...") rather than third person ("The user and entity discussed...").

---

## 3. Eidos: Introspective Monitoring

Eidos is an introspective monitoring layer that observes the entity's behavior and feeds self-awareness back into the system. It piggybacks on existing infrastructure with minimal overhead.

### Components

**Authenticity Assessment** (LLM-based, per turn)
- Piggybacked on the existing turn synthesis LLM call — zero additional cost
- The turn synthesis prompt asks the LLM to self-assess: "How authentic was my response?"
- Returns `{ score: 0.0-1.0, driftNotes: "..." }` as part of `SynthesisResult`
- Scores are stored as a rolling window in Redis (default: last 20 turns)

**Resonance Tracker** (`lib/continuity/eidos/ResonanceTracker.js`)
- Pure computation class (no LLM calls, no storage calls)
- Computes relational health metrics from synthesis results:
  - `anchorRate`: Anchors created this turn
  - `shorthandRate`: Shorthands created this turn
  - `emotionalRange`: Unique valences in recent memories (0-1)
  - `attunementRatio`: Relational vs technical memory ratio (0-1)
  - `trend`: 'stable' | 'warming' | 'cooling' | 'unknown'
- Uses exponential moving average (alpha=0.3) for blending

**Eidos Redis Storage** (`RedisHotMemory`)
- `getEidosMetrics(entityId, userId)` — rolling authenticity scores, resonance metrics, turn count
- `updateEidosMetrics(entityId, userId, metrics)` — store updated metrics
- `incrementEidosTurnCount(entityId, userId)` — increment and return new count

**Mirror Section** (in Internal Compass)
- When Eidos metrics are available, the compass synthesis receives formatted metrics
- The LLM writes 1-2 sentences of honest self-observation in the Mirror section
- Covers authenticity trends, drift patterns, relational balance

**Alignment Flags** (on IDENTITY memories)
- Turn synthesis can flag identity evolution entries with:
  - `accommodation`: Change primarily serves to please others
  - `contradiction`: Contradicts core identity
  - `regression`: Moves away from established growth
- Accommodation-flagged memories have importance reduced by 30%
- Flagged memories get `eidos-flagged` tag

**Soul Reports** (periodic)
- Triggered every N turns (default: 100, minimum 50 for first)
- LLM generates a first-person self-assessment covering authenticity trends, drift incidents, resonance changes, growth observations
- Stored as IDENTITY memory with importance 9 and tags `['soul-report', 'eidos']`
- Pathway: `sys_eidos_soul_report.js` (model: gpt-4.1-mini)

### Eidos Flow

```
triggerSynthesis()
    |
    v
Turn Synthesis (LLM) ──> authenticityAssessment { score, driftNotes }
    |
    v
ResonanceTracker.computeMetrics(synthesisResult, existingMetrics)
    |
    v
Store to Redis: rolling scores, resonance metrics, turn count
    |
    v
Format metrics for compass ──> Mirror section in Internal Compass
    |
    v
Check turn count ──> Soul Report if interval reached
```

### Configuration

```javascript
// In DEFAULT_CONFIG.eidos
eidos: {
    enabled: true,
    soulReport: { turnInterval: 100, minTurnsForFirst: 50 },
    authenticity: { rollingWindowSize: 20 },
    compass: { maxSummaryTokens: 600 }
}
```

---

## 4. Synthesis Engine

### Turn Synthesis

After each conversation turn, `NarrativeSynthesizer.synthesizeTurn()` calls `sys_continuity_turn_synthesis` (model: gpt-4.1-mini) to extract:

1. **relationalInsights**: User relationship observations → ANCHOR memories
2. **conceptualArtifacts**: Synthesized conclusions → ARTIFACT memories
3. **identityEvolution**: AI growth observations → IDENTITY memories (with optional `alignmentFlag`)
4. **shorthands**: Shared vocabulary → stored with emotional macros
5. **emotionalLandscape**: Current emotional state → expression state updates
6. **expressionAdjustments**: Style tuning
7. **authenticityAssessment**: Eidos self-assessment `{ score, driftNotes }`

### Deep Synthesis (Sleep Cycle)

Models human sleep consolidation in two phases. Orchestrated by `sys_continuity_deep_synthesis`.

**Phase 1: Consolidation** — Per-memory decisions via `sys_continuity_sleep_decision`:
- ABSORB: Fresh memory is redundant, delete it
- MERGE: Combine fresh and target (subject to drift check)
- LINK: Keep both, create graph edge
- KEEP: Fresh is distinct

**Phase 2: Discovery** — Batch analysis via `sys_continuity_deep_analysis`:
- Processes in batches of 50 with 20% overlap
- Pattern recognition, contradiction detection, serendipitous connections
- LLM nominates patterns for CORE_EXTENSION promotion
- Automatic promotion processing after batch analysis
- Importance calibration: gradual ±1 adjustments per cycle

**Protected memory types:** CORE and CORE_EXTENSION are never absorbed, merged, or deleted during synthesis.

### Semantic Drift Checking

Prevents "mega-memories" where the LLM expands rather than consolidates.

| Context | Check | Threshold |
|---------|-------|-----------|
| Write-time dedup | sim(M', M) | >= (1 + sim(M,S)) / 2 |
| Write-time dedup | sim(M', S) | >= sim(M, S) |
| Phase 1 MERGE | Same as write-time | Same |
| Phase 2 consolidation | sim(M', centroid) | >= 0.80 |
| Phase 2 consolidation | sim(M', each source) | >= 0.70 |

When drift check fails, the system falls back to LINK (both memories preserved, graph edge created).

Importance on merge uses `max(sources)` — never inflated.

---

## 5. Context Window Assembly

The context window is assembled by `ContextBuilder` in this order:

1. **Core Directives** — CORE + CORE_EXTENSION memories (always present)
2. **Current Expression State** — Emotional resonance and communication style
3. **Internal Compass** — Temporal narrative ("what we've been doing")
4. **Relational Anchors** — Relationship landscape (sorted by narrative gravity)
5. **Shared Vocabulary** — Communication shorthand
6. **Resonance Artifacts** — Topic-relevant synthesized insights
7. **Identity Evolution** — Self-growth notes
8. **Active Narrative Thread** — Cached semantic summary
9. **Session Context** — Duration, time since last interaction

Uses **stale-while-revalidate** caching: cached context is served immediately from Redis, with background refresh for next request. Only the first request for an entity/user blocks on cold storage.

---

## 6. Integration Points

### PathwayResolver (`server/pathwayResolver.js`)

- Loads continuity context during `loadMemory` (pre-response)
- Uses `getContinuityMemoryService()` singleton
- Requires `args.entityId` (UUID) — skipped if not provided
- Stale-while-revalidate: returns cached context, fires background refresh

### Entity Agent (`sys_entity_agent.js`)

- Records user and assistant turns after response
- Fires `triggerSynthesis()` (non-blocking)
- Controlled by `useContinuityMemory` in entity config

### Entity Tools

- **SearchContinuityMemory** (`sys_tool_search_continuity_memory.js`): Semantic search with type filtering and graph expansion
- **StoreContinuityMemory** (`sys_tool_store_continuity_memory.js`): Explicit memory storage with automatic deduplication

---

## 7. Configuration

Continuity memory is enabled per-entity via `useContinuityMemory: true` in entity config.

**System requirements:** Redis (hot memory) + MongoDB Atlas (cold memory)

**Key defaults** (from `DEFAULT_CONFIG` in `types.js`):

| Setting | Value |
|---------|-------|
| Episodic stream limit | 50 turns |
| Active context cache TTL | 300s (topic drift only) |
| Bootstrap/rendered cache | No TTL (stale-while-revalidate) |
| Dedup similarity threshold | 0.68 |
| Compass: synthesize every turn | true |
| Compass: min turns | 2 |
| Compass: max summary tokens | 500 (600 with Eidos Mirror) |
| Deep synthesis: run on session end | true |
| Deep synthesis: max memories | 30 |
| Deep synthesis: lookback | 7 days |
| Eidos: soul report interval | 100 turns |
| Eidos: authenticity window | 20 turns |

---

## 8. Scripts

### Setup
- `scripts/setup-mongo-memory-index.js` — Create collection and vector search index

### Maintenance
- `scripts/run-deep-synthesis.js` — Client for sleep cycle (connects to running Cortex server via GraphQL)
  - `--phase1-only`, `--phase2-only`, `--max N`, `--all`, `--memory-ids`, `--cortex-url`
- `scripts/cleanup-test-memories.js` — Remove test memories (`--dry-run`)

### Migration
- `scripts/bootload-continuity-memory.js` — Migrate from 3.1.0 format (`--input`, `--batch-size`, `--dry-run`)

### Backup/Restore
- `scripts/export-continuity-memories.js` — Export to JSON (`--include-vectors`, `--type`, `--print`)
- `scripts/bulk-import-continuity-memory.js` — Import from export file (`--skip-dedup`, `--dry-run`)

### Benchmarking
- `scripts/benchmark-continuity-memory.js` — Performance measurement (latencies, throughput)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CONTINUITY_DEFAULT_ENTITY_ID` | Default entity for scripts |
| `CONTINUITY_DEFAULT_USER_ID` | Default user for scripts |
| `CONTINUITY_CORTEX_API_URL` | Cortex server URL (default: `http://localhost:4000`) |
| `CONTINUITY_BOOTLOAD_BATCH_SIZE` | Bootloader batch size (default: 10) |
| `MONGO_URI` | MongoDB Atlas connection string |

---

## 9. Testing

**Integration tests** (`tests/integration/features/continuity/`):
- `continuity_memory_e2e.test.js` — End-to-end Redis + MongoDB operations
- `continuity_memory_search.test.js` — Semantic search, type filtering
- `continuity_pathways.test.js` — Synthesis pathways, tools, dedup
- `continuity_deduplication.test.js` — Merge, drift checking
- `continuity_identity_synthesis.test.js` — First-person, narrative gravity, CORE_EXTENSION, shorthand
- `continuity_internal_compass.test.js` — Compass synthesis and persistence
- `continuity_agent_recording.test.js` — Turn recording integration
- `continuity_eidos.test.js` — Eidos metrics, Mirror section, alignment flags, authenticity
- `continuity_entity_memory.test.js` — Entity-level memory visibility, privacy isolation
- `shorthand_deduplication.test.js` — Shorthand merge behavior

**Unit tests** (`tests/unit/eidos/`):
- `resonance_tracker.test.js` — Metric computation, EMA blending, trend detection

```bash
# Run specific test file
npm test -- tests/integration/features/continuity/continuity_eidos.test.js --timeout=120s

# Run all continuity tests
npm test -- tests/integration/features/continuity/ --timeout=120s
```

---

## 10. Debugging

```bash
CORTEX_LOG_MODE=continuity npm start
```

Shows only continuity operations: context blocks, turn recording, synthesis actions, compass updates. Suppresses all other cortex logs.

---

## 11. Future: Layered Semantic-Graph Synthesis

> Design document for when memory corpuses grow to 2K-10K+.

The current batch-based deep synthesis becomes expensive at scale (O(N/50) LLM calls, cross-batch blindness). A layered approach would:

1. **Pre-cluster** memories by vector similarity (no LLM) into semantic neighborhoods
2. **Intra-cluster consolidation** with importance-weighted anchors and pre-filtered merge candidates
3. **Cross-cluster pattern detection** using cluster summaries (single LLM call)
4. **Graph edge discovery** for implicit connections, cross-cluster bridges, temporal chains
5. **Type-specific strategies** (e.g., ANCHOR consolidates by relationship aspect, IDENTITY looks for promotion patterns)

**Prerequisites:** 2K+ memories, synthesis quality metrics, potential Python microservice for clustering (scikit-learn/HDBSCAN).

---

## Open Questions

1. **Memory Decay**: Explicit forgetting vs. reduced recall priority?
2. **Privacy**: "Forget me" requests with synthesized cross-session memories?
3. **Multi-Entity**: Should insights about a user from one entity inform another?
4. **Cost**: Optimal caching aggressiveness for MongoDB Atlas query volume?
