# Agentic Memory Architecture Documentation

## Overview

The Cortex system implements a sophisticated dual-layer memory architecture designed to support both conversational AI entities and multi-agent task execution systems. This architecture enables persistent, structured, and context-aware memory management across different use cases.

## Architecture Components

The memory system consists of two primary subsystems:

1. **Entity Memory System** - For conversational AI entities with persistent user context
2. **Context Memory System** - For multi-agent task execution with event tracking

---

## 1. Entity Memory System

### Purpose

The Entity Memory System provides persistent, structured memory for conversational AI entities (like "Labeeb" or "Jarvis"). It enables agents to remember user preferences, conversation history, directives, and topics across sessions.

### Memory Sections

Memory is organized into distinct sections, each serving a specific purpose:

#### `memorySelf`
- **Purpose**: Information about the AI entity itself
- **Content**: Identity, capabilities, values, tone, and behavioral characteristics
- **Priority**: Typically high (priority 1)
- **Example**: "You are a professional colleague and your tone should reflect that."

#### `memoryUser`
- **Purpose**: Information about users and their preferences
- **Content**: User names, preferences, locations, communication styles, interests
- **Priority**: Variable (1-3)
- **Example**: "User prefers concise explanations" or "User is located in New York"

#### `memoryDirectives`
- **Purpose**: Instructions and learned behaviors for the AI
- **Content**: Behavioral directives, operational guidelines, learned preferences
- **Priority**: Typically high (priority 1)
- **Example**: "Learn and adapt to the user's communication style through interactions"

#### `memoryTopics`
- **Purpose**: Conversation topics and contextual information
- **Content**: Major discussion topics, decisions made, important context
- **Priority**: Variable (1-3), supports recency filtering
- **Example**: "Discussed project timeline for Q2 2025"

#### `memoryContext`
- **Purpose**: Temporary context for the current conversation turn
- **Content**: Relevant memories extracted for current conversation
- **Priority**: Not stored permanently, regenerated each turn
- **Usage**: Cached search results for performance

#### `memoryVersion`
- **Purpose**: Version tracking for memory format migration
- **Content**: Current version string (e.g., "3.1.0")
- **Usage**: Enables automatic migration and format normalization

### Memory Format

Each memory entry follows a structured format:

```
priority|timestamp|content
```

Where:
- **priority**: Integer (1-3), where 1 = highest priority
- **timestamp**: ISO 8601 format (e.g., "2025-01-26T12:00:00Z")
- **content**: The actual memory content

**Example**:
```
1|2025-01-26T12:00:00Z|User prefers concise explanations
2|2025-01-26T13:30:00Z|Discussed project timeline for Q2 2025
3|2025-01-26T14:15:00Z|User mentioned interest in machine learning
```

### Storage Architecture

#### Key-Value Storage
- **Backend**: Redis (via Keyv)
- **Namespace**: `{cortexId}-cortex-context`
- **Key Format**: `{contextId}-{section}` (e.g., `user123-memoryUser`)
- **Encryption**: Double encryption layer
  - Layer 1: Redis-level encryption using `redisEncryptionKey`
  - Layer 2: Context-level encryption using `contextKey` (optional, per-entity)

#### Storage Functions

```javascript
// Basic storage (single encryption)
setv(key, value)
getv(key)

// Double encryption (with context key)
setvWithDoubleEncryption(key, value, contextKey)
getvWithDoubleDecryption(key, contextKey)
```

### Core Pathways

#### `sys_read_memory`
**Purpose**: Read memory from storage with filtering options

**Parameters**:
- `contextId`: Unique identifier for the entity/user
- `section`: Memory section to read (`memoryAll` for all sections)
- `priority`: Filter by priority (0 = all, 1-3 = specific priority)
- `recentHours`: Filter by recency (0 = all, N = last N hours)
- `numResults`: Limit number of results (0 = all)
- `stripMetadata`: Remove priority/timestamp metadata (boolean)
- `contextKey`: Encryption key for decryption

**Features**:
- Validates ISO timestamps and priority values
- Sorts results by timestamp (newest first)
- Supports filtering and pagination
- Returns JSON object for `memoryAll`, string for single sections

#### `sys_save_memory`
**Purpose**: Save memory to storage

**Parameters**:
- `contextId`: Unique identifier
- `aiMemory`: Memory content (string or JSON object)
- `section`: Target section (`memoryAll` for multi-section save)
- `contextKey`: Encryption key

**Features**:
- Supports single section or multi-section saves
- Handles legacy format migration
- Validates section names
- Encrypts data before storage

#### `sys_memory_manager`
**Purpose**: Orchestrates memory lifecycle management

**Workflow**:
1. **Version Check**: Verifies memory version, triggers migration if needed
2. **Format Normalization**: Ensures all memories follow correct format
3. **Context Update**: Searches and updates `memoryContext` for current turn
4. **Memory Analysis**: Determines if conversation requires memory updates
5. **Memory Processing**: Executes add/update/delete operations
6. **Topic Extraction**: Generates topics from conversation

**Key Features**:
- Automatic version migration
- Format normalization
- Intelligent memory requirement detection
- Batch operation processing

#### `sys_memory_required`
**Purpose**: Determines if conversation turn requires memory updates

**Process**:
- Analyzes last conversation turn (user message + AI response)
- Identifies memory-worthy information:
  - Personal user details
  - Important topics/decisions
  - Specific instructions
  - Explicit remember/forget requests
- Returns JSON array of memory operations:
  ```json
  [
    {
      "memoryOperation": "add" | "delete",
      "memoryContent": "complete description",
      "memorySection": "memoryUser" | "memorySelf" | "memoryDirectives",
      "priority": 1-3
    }
  ]
  ```

#### `sys_memory_update`
**Purpose**: Applies memory modifications (add/change/delete)

**Process**:
1. Reads current section memory
2. Normalizes format
3. Uses LLM to determine exact modifications:
   - Checks for duplicates before adding
   - Finds matching patterns for changes/deletes
   - Combines substantially duplicate memories
4. Applies modifications
5. Enforces token limits (25,000 tokens per section)
6. Saves updated memory

**Modification Types**:
- `add`: Add new memory (if not duplicate)
- `change`: Update existing memory (matched by pattern)
- `delete`: Remove memory (matched by pattern)

#### `sys_memory_process`
**Purpose**: Consolidates and optimizes memory during "rest periods"

**Process**:
- Runs iteratively (up to 5 iterations or until no changes)
- LLM-powered consolidation:
  - **Consolidation**: Combines similar/related memories
  - **Learning**: Extracts general principles from specific experiences
  - **Cleanup**: Removes redundant or irrelevant memories
  - **Prioritization**: Updates priority for important memories
- Applies modifications and enforces token limits

**Use Case**: Periodic memory optimization to prevent bloat

#### `sys_search_memory`
**Purpose**: Intelligently searches memory for relevant information

**Process**:
1. Reads memory section(s)
2. Uses LLM to analyze conversation history
3. Extracts relevant memories based on:
   - Current conversation context
   - Predicted future needs
   - Semantic relevance
4. Optionally updates `memoryContext` cache
5. Returns concise, relevant memory excerpts

**Features**:
- Context-aware search
- Predictive memory retrieval
- Multi-section search support
- Caching via `memoryContext`

#### `sys_memory_topic`
**Purpose**: Extracts conversation topics for `memoryTopics` section

**Process**:
- Analyzes conversation history
- Identifies major topics and themes
- Generates topic entries with appropriate priority
- Returns topic string in memory format

### Memory Tools

#### `sys_tool_store_memory`
**Purpose**: Allows agents to explicitly store memories via tool calls

**Tool Definition**:
```json
{
  "name": "StoreMemory",
  "description": "Store information to memory",
  "parameters": {
    "memories": [
      {
        "content": "string",
        "section": "memoryUser" | "memorySelf" | "memoryDirectives" | "memoryTopics",
        "priority": 1 | 2 | 3
      }
    ],
    "userMessage": "string"
  }
}
```

**Features**:
- Batch memory storage
- Automatic timestamp generation
- Section validation
- Priority assignment
- Appends to existing memories

### Memory Lifecycle

```
┌─────────────────┐
│  Conversation   │
│     Turn        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Load Memory     │
│ (pathwayResolver)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Search Memory   │
│ (sys_search_    │
│  memory)        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Generate        │
│ Response       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check if Memory │
│ Update Needed   │
│ (sys_memory_    │
│  required)      │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌─────────┐ ┌─────────┐
│ Update  │ │ Extract  │
│ Memory  │ │ Topic    │
│ (sys_   │ │ (sys_    │
│ memory_ │ │ memory_  │
│ update) │ │ topic)   │
└─────────┘ └─────────┘
```

### Version Management

#### Current Version: 3.1.0

**Version History**:
- **3.1.0**: Current version with structured sections
- **Legacy**: Single `memoryContext` field in `savedContext`

**Migration Process**:
1. Check `memoryVersion` section
2. If version mismatch or missing:
   - Read all sections
   - Normalize format (ensure `priority|timestamp|content` format)
   - Migrate from legacy if needed
   - Set version to current
3. Format normalization:
   - Validates timestamp format (ISO 8601)
   - Validates priority (1-3)
   - Adds missing metadata if needed

**Legacy Support**:
- `memoryLegacy` section for backward compatibility
- Automatic migration via `labeeb_memory_migrate` pathway
- Preserves existing data during migration

### Security

#### Encryption Layers

1. **Redis-Level Encryption**:
   - Uses `redisEncryptionKey` from config
   - Applied to all stored data
   - Handled by Keyv serialization

2. **Context-Level Encryption**:
   - Uses `contextKey` (per-entity/user)
   - Optional additional layer
   - Applied via `setvWithDoubleEncryption`
   - Enables per-entity data isolation

#### Access Control

- Memory is scoped by `contextId`
- Each entity/user has isolated memory
- `contextKey` provides additional access control
- No cross-entity memory access

---

## 2. Context Memory System (AutoGen2)

### Purpose

The Context Memory System tracks agent actions, decisions, and outcomes during multi-agent task execution. It provides comprehensive context for agents and generates intelligent summaries for presentation.

### Architecture Components

#### `ContextMemory` (Orchestrator)
**Location**: `helper-apps/cortex-autogen2/context/context_memory.py`

**Responsibilities**:
- Coordinates all context memory operations
- Provides unified interface for event recording
- Delegates to specialized modules

**Key Methods**:
- `record_agent_action()`: Record agent actions
- `record_file_creation()`: Track file creation
- `record_tool_execution()`: Log tool usage
- `record_handoff()`: Track agent transitions
- `record_accomplishment()`: Log achievements
- `record_decision()`: Track important decisions
- `record_error()`: Log errors and recovery
- `generate_context_summary()`: LLM-powered summary
- `get_presenter_context()`: Comprehensive context for presenter
- `get_focused_agent_context()`: Focused context for execution agents

#### `EventRecorder`
**Location**: `helper-apps/cortex-autogen2/context/event_recorder.py`

**Purpose**: Records all agent events to JSONL files

**Event Types**:
- `agent_action`: General agent actions
- `file_creation`: File creation events
- `tool_execution`: Tool usage
- `handoff`: Agent transitions
- `accomplishment`: Achievements
- `decision`: Important decisions
- `error`: Errors and recovery

**Log Files** (JSONL format):
- `events.jsonl`: All events
- `messages.jsonl`: Agent messages
- `context_summary.jsonl`: Execution summaries
- `presenter_context.jsonl`: Presenter context
- `worklog.jsonl`: Work tracking
- `learnings.jsonl`: Extracted learnings

**Features**:
- Prevents duplicate file logging
- In-memory event storage for quick access
- Structured event format with metadata
- Automatic timestamping

#### `ContextGenerator`
**Location**: `helper-apps/cortex-autogen2/context/context_generator.py`

**Purpose**: Generates intelligent context summaries using LLM

**Capabilities**:
1. **Full Context Summary**:
   - Agent flow walkthrough
   - Accomplishments summary
   - Files created with previews
   - Key decisions
   - Data sources
   - Current state

2. **Focused Agent Context**:
   - Current status
   - Steps taken (for loop detection)
   - Available files
   - Recent accomplishments
   - What to do next
   - Token-limited (1-5k tokens per agent)

3. **Presenter Context**:
   - Comprehensive execution summary
   - Complete event history
   - File summaries with content previews
   - Upload results
   - Up to 50k tokens

**Features**:
- LLM-powered summarization
- Token estimation and limiting
- Loop detection via step tracking
- File metadata extraction
- Fallback summaries on LLM failure

#### `FileSummarizer`
**Purpose**: Extracts and summarizes file contents

**Capabilities**:
- CSV: Column detection, row counts, sample data
- JSON: Key detection, structure analysis, sample records
- Images: Dimensions, format, mode
- Text: Content previews

**Output Format**:
```python
{
  "file_path": "...",
  "file_name": "...",
  "file_type": "csv|json|image|text",
  "content_preview": {
    "columns": [...],  # For CSV
    "keys": [...],     # For JSON
    "dimensions": "...", # For images
    "sample_data": "..." # For any type
  }
}
```

#### `LearningMemory`
**Location**: `helper-apps/cortex-autogen2/context/learning_memory_system.py`

**Purpose**: Stores successful strategies, failure patterns, and insights

**Data Structures**:
- `success_patterns`: Successful strategies by task type
- `failure_patterns`: Failed strategies with lessons
- `task_insights`: General insights about task handling
- `agent_profiles`: Agent performance profiles
- `strategy_effectiveness`: Strategy success metrics

**Key Methods**:
- `record_success_pattern()`: Store successful strategies
- `record_failure_pattern()`: Store failures with lessons
- `record_task_insight()`: Store general insights
- `get_recommended_strategies()`: Get strategy recommendations
- `get_failure_warnings()`: Warn about failed strategies
- `update_agent_profile()`: Update agent performance data

**Features**:
- Success score calculation
- Context similarity matching
- Strategy effectiveness tracking
- Agent profile management
- Learning extraction from outcomes

### Context Flow

```
┌──────────────┐
│ Task Start   │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Initialize   │
│ ContextMemory│
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Planner      │
│ Agent        │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Record Plan  │
│ & Decisions  │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Execution    │
│ Agents       │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Record       │
│ Actions &    │
│ Files        │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Generate     │
│ Context      │
│ Summary      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Presenter    │
│ Agent        │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Final        │
│ Presentation │
└──────────────┘
```

### Event Structure

```json
{
  "timestamp": "2025-01-26T12:00:00Z",
  "event_type": "agent_action|file_creation|tool_execution|handoff|accomplishment|decision|error",
  "agent_name": "planner_agent",
  "action": "action_description",
  "details": {
    // Event-specific details
  },
  "result": {
    // Action results
  },
  "metadata": {
    "work_dir": "/tmp/coding/req_123",
    "request_id": "req_123"
  }
}
```

### Context Generation Process

1. **Event Collection**: All events recorded to JSONL files
2. **Event Filtering**: Filter relevant events for specific agent
3. **LLM Summarization**: Generate intelligent summary
4. **File Summarization**: Extract file metadata and previews
5. **Context Assembly**: Combine summaries with file info
6. **Token Limiting**: Ensure context fits within limits
7. **Delivery**: Provide context to agent

### Token Management

**Agent Context Limits**:
- Default: 3,000 tokens
- Planner: 5,000 tokens
- Presenter: 50,000 tokens
- Execution agents: 1,000-3,000 tokens

**Token Estimation**:
- Uses character count approximation
- 1 token ≈ 4 characters
- Includes safety margin (90% of limit)

---

## 3. Integration Points

### Pathway Resolver Integration

The `PathwayResolver` class integrates memory loading into the pathway execution flow:

```javascript
// Memory loading (pathwayResolver.js)
const loadMemory = async () => {
  // Load savedContext (legacy)
  this.savedContext = await getvWithDoubleDecryption(...);
  
  // Load memory sections if enabled
  if (memoryEnabled) {
    const [memorySelf, memoryDirectives, memoryTopics, memoryUser, memoryContext] = 
      await Promise.all([
        callPathway('sys_read_memory', { section: 'memorySelf', ... }),
        callPathway('sys_read_memory', { section: 'memoryDirectives', ... }),
        callPathway('sys_read_memory', { section: 'memoryTopics', ... }),
        callPathway('sys_read_memory', { section: 'memoryUser', ... }),
        callPathway('sys_read_memory', { section: 'memoryContext', ... })
      ]);
  }
};
```

### Entity Agent Integration

Entity agents automatically:
1. Load memory at conversation start
2. Search memory for relevant context
3. Use memory in prompts
4. Update memory after conversation turns
5. Process memory during rest periods

### AutoGen2 Integration

AutoGen2 agents:
1. Initialize `ContextMemory` at task start
2. Record all actions and events
3. Receive focused context summaries
4. Generate comprehensive presenter context
5. Learn from successes and failures

---

## 4. Best Practices

### Entity Memory

1. **Memory Sections**:
   - Use appropriate sections for different information types
   - Keep `memorySelf` focused on identity and capabilities
   - Store user-specific info in `memoryUser`
   - Use `memoryTopics` for conversation context

2. **Priority Management**:
   - Priority 1: Critical, always-relevant information
   - Priority 2: Important but context-dependent
   - Priority 3: Nice-to-have, lower priority

3. **Memory Processing**:
   - Run `sys_memory_process` periodically to consolidate
   - Monitor token usage (25k limit per section)
   - Remove outdated or irrelevant memories

4. **Security**:
   - Always use `contextKey` for sensitive data
   - Validate `contextId` before operations
   - Never expose `contextKey` in logs

### Context Memory

1. **Event Recording**:
   - Record all significant actions
   - Include relevant metadata
   - Use structured event types

2. **Context Generation**:
   - Use focused context for execution agents
   - Provide comprehensive context for presenter
   - Monitor token usage

3. **File Tracking**:
   - Record file creation immediately
   - Include content previews
   - Track file metadata

4. **Learning**:
   - Record success patterns
   - Learn from failures
   - Update agent profiles

---

## 5. Troubleshooting

### Entity Memory Issues

**Problem**: Memory not loading
- Check `contextId` is provided
- Verify `contextKey` if using double encryption
- Check Redis connectivity
- Verify memory version compatibility

**Problem**: Memory format errors
- Run memory normalization
- Check timestamp format (ISO 8601)
- Validate priority values (1-3)
- Run version migration if needed

**Problem**: Memory bloat
- Run `sys_memory_process` to consolidate
- Check token limits (25k per section)
- Remove low-priority, outdated memories
- Use recency filtering in reads

### Context Memory Issues

**Problem**: Context summary generation fails
- Check LLM API connectivity
- Verify model client configuration
- Review fallback summaries in logs
- Check token limits

**Problem**: Missing events
- Verify event recording calls
- Check JSONL file permissions
- Review event recorder initialization
- Check for duplicate prevention logic

**Problem**: Token limit exceeded
- Reduce context scope
- Use focused summaries
- Filter events more aggressively
- Increase token limits if appropriate

---

## 6. Future Enhancements

### Planned Features

1. **Memory Compression**:
   - Automatic compression for large memories
   - Semantic deduplication
   - Temporal compression

2. **Cross-Entity Memory**:
   - Shared memory pools
   - Memory inheritance
   - Collaborative memory

3. **Advanced Learning**:
   - Predictive memory retrieval
   - Memory importance scoring
   - Adaptive memory pruning

4. **Performance Optimization**:
   - Memory caching layers
   - Batch operations
   - Async memory updates

---

## 7. API Reference

### Entity Memory Pathways

- `sys_read_memory`: Read memory with filtering
- `sys_save_memory`: Save memory to storage
- `sys_memory_manager`: Orchestrate memory lifecycle
- `sys_memory_required`: Determine if update needed
- `sys_memory_update`: Apply memory modifications
- `sys_memory_process`: Consolidate and optimize
- `sys_search_memory`: Intelligent memory search
- `sys_memory_topic`: Extract conversation topics
- `sys_tool_store_memory`: Tool for explicit memory storage

### Context Memory Classes

- `ContextMemory`: Main orchestrator
- `EventRecorder`: Event logging
- `ContextGenerator`: Context summarization
- `FileSummarizer`: File content analysis
- `LearningMemory`: Strategy learning

### Storage Functions

- `setv(key, value)`: Basic storage
- `getv(key)`: Basic retrieval
- `setvWithDoubleEncryption(key, value, contextKey)`: Encrypted storage
- `getvWithDoubleDecryption(key, contextKey)`: Encrypted retrieval

---

## 8. Examples

### Storing Entity Memory

```javascript
// Store user preference
await callPathway('sys_save_memory', {
  contextId: 'user123',
  section: 'memoryUser',
  aiMemory: '1|2025-01-26T12:00:00Z|User prefers concise explanations',
  contextKey: 'user123_key'
});

// Store multiple sections
await callPathway('sys_save_memory', {
  contextId: 'user123',
  section: 'memoryAll',
  aiMemory: JSON.stringify({
    memoryUser: '1|2025-01-26T12:00:00Z|User prefers concise explanations',
    memorySelf: '1|2025-01-26T12:00:00Z|You are a professional colleague'
  }),
  contextKey: 'user123_key'
});
```

### Reading Entity Memory

```javascript
// Read all sections
const memory = await callPathway('sys_read_memory', {
  contextId: 'user123',
  section: 'memoryAll',
  contextKey: 'user123_key'
});

// Read with filtering
const recentTopics = await callPathway('sys_read_memory', {
  contextId: 'user123',
  section: 'memoryTopics',
  recentHours: 24,
  numResults: 10,
  priority: 1,
  contextKey: 'user123_key'
});
```

### Recording Context Memory Events

```python
# Record agent action
context_memory.record_agent_action(
    agent_name="planner_agent",
    action_type="plan_created",
    details={"plan": "..."},
    result={"steps": 5}
)

# Record file creation
context_memory.record_file_creation(
    file_path="/tmp/data.csv",
    file_type="csv",
    content_summary="User data with 100 rows",
    metadata={"columns": ["name", "email"]},
    agent_name="coder_agent"
)

# Generate context summary
summary = await context_memory.generate_context_summary(task="...")
```

### Using Learning Memory

```python
# Record success
learning_memory.record_success_pattern(
    task_type="data_analysis",
    agent_name="coder_agent",
    strategy="pandas_dataframe",
    context={"data_size": "large"},
    outcome_metrics={"duration_seconds": 45, "completed": True}
)

# Get recommendations
recommendations = learning_memory.get_recommended_strategies(
    task_type="data_analysis",
    agent_name="coder_agent",
    context={"data_size": "large"}
)
```

---

## 3. Continuity Memory Architecture (Luna v4.0)

### Overview

The Continuity Architecture is a parallel memory system designed to shift from a "Storage" model to a "Synthesis" model. Instead of just storing facts, it captures **meaning**, **emotional bonds**, and **identity evolution**. This enables true "Narrative Ipseity" - the AI's sense of self and relationship continuity.

### Design Philosophy

The Continuity Architecture is built on these principles:

1. **Narrative over Storage**: Memories capture meaning, not just information
2. **Relational Anchors**: Deep understanding of user relationships, not flat preferences
3. **Identity Evolution**: Self-awareness of growth and change over time
4. **Associative Recall**: Graph-based memory expansion mimics human memory
5. **Shorthand Detection**: Captures shared vocabulary and inside references (Luna's feature)

### Architecture Layers

#### Foundational Layer (The "What")
- **`memoryCore`**: Fundamental identity and directives
- **`capabilityMap`**: Dynamic index of capabilities, tools, constraints

#### Narrative Layer (The "Who")
- **`relationalAnchors`** (ANCHOR type): Emotional bonds, user values, struggles, shared experiences
- **`resonanceArchive`** (ARTIFACT type): Synthesized insights and conclusions from conversations
- **`identityEvo`** (IDENTITY type): Self-growth observations and changes

#### Synthesized Persona (The "How")
- **`expressionStyle`**: Dynamic tone based on relational context
- **`activeValues`**: Current philosophical framework

#### Episodic Stream (The "Now")
- **`contextStream`**: Rolling window of recent interactions in Redis

### Storage Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTINUITY ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                  REDIS (Hot Memory)                      │  │
│   │  ┌──────────────┬──────────────┬──────────────────────┐ │  │
│   │  │ Episodic     │ Active       │ Expression           │ │  │
│   │  │ Stream       │ Context      │ State                │ │  │
│   │  │ (last 50     │ Cache        │ (emotional           │ │  │
│   │  │ turns)       │ (5min TTL)   │ resonance)           │ │  │
│   │  └──────────────┴──────────────┴──────────────────────┘ │  │
│   └─────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │             AZURE AI SEARCH (Cold Memory)                │  │
│   │  ┌──────────────┬──────────────┬──────────────────────┐ │  │
│   │  │ Relational   │ Resonance    │ Identity             │ │  │
│   │  │ Anchors      │ Artifacts    │ Evolution            │ │  │
│   │  │ (ANCHOR)     │ (ARTIFACT)   │ (IDENTITY)           │ │  │
│   │  ├──────────────┴──────────────┴──────────────────────┤ │  │
│   │  │         Vector Search + Graph Relationships         │ │  │
│   │  └────────────────────────────────────────────────────┘ │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Memory Decay (Luna's Formula)

Instead of deleting old memories, we use recall probability weighting:

```javascript
recallScore = (vectorScore * 0.7) + (importance * 0.2) + (recency * 0.1)
```

Low-importance memories naturally fade off the bottom of results while high-importance memories persist.

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ContinuityMemoryService` | `lib/continuity/ContinuityMemoryService.js` | Main orchestrator |
| `RedisHotMemory` | `lib/continuity/storage/RedisHotMemory.js` | Episodic stream, expression state |
| `AzureMemoryIndex` | `lib/continuity/storage/AzureMemoryIndex.js` | Long-term semantic memory |
| `ContextBuilder` | `lib/continuity/synthesis/ContextBuilder.js` | Pre-response context assembly |
| `NarrativeSynthesizer` | `lib/continuity/synthesis/NarrativeSynthesizer.js` | Post-response meaning extraction |
| `types.js` | `lib/continuity/types.js` | Type definitions and constants |

### Integration Points

#### Pre-Response (Middleware Hook)

Before the LLM generates a response, the system:
1. Loads episodic stream from Redis
2. Checks for cached active context
3. Performs semantic search if topic has drifted
4. Expands memory graph for associative recall
5. Builds context window for prompt injection

```javascript
// In pathwayResolver.js
if (useContinuityMemory) {
    const continuityContext = await continuityService.getContextWindow({
        entityId, userId, query
    });
    // Injected as {{{continuityContext}}} in prompts
}
```

#### Post-Response (Fire-and-Forget)

After the response is sent, asynchronously:
1. Records user and assistant turns to episodic stream
2. Triggers narrative synthesis
3. Extracts relational insights, artifacts, identity notes
4. Detects new shared vocabulary (shorthand)
5. Stores to Azure AI Search

```javascript
// In pathwayResolver.js
continuityService.triggerSynthesis(entityId, userId, {
    aiName: args.aiName
});
```

### Usage

#### Enabling Continuity Memory

```javascript
// In pathway call
await callPathway('sys_entity_agent', {
    aiName: 'Luna',
    useContinuityMemory: true,
    // ... other args
});

// Or in entity config
{
    "entityId": "luna",
    "useContinuityMemory": true
}
```

#### Searching Memory (Tool Access)

The `search_continuity_memory` tool allows explicit memory queries:

```javascript
// Tool call from the agent
{
    "query": "our conversations about grief",
    "memoryTypes": ["ANCHOR", "ARTIFACT"],
    "expandGraph": true
}
```

### Privacy ("Forget Me")

Uses cascading delete:
- **Relational Anchors**: Deleted completely
- **Synthesized Artifacts**: Anonymized (keep insight, strip source)
- **Other Memories**: Deleted

```javascript
await continuityService.forgetUser(entityId, userId);
```

### Template Reference

The `AI_CONTINUITY_CONTEXT` template in `entityConstants.js`:

```handlebars
{{#if continuityContext}}# Narrative Context

The following is your deeper understanding of this relationship and yourself...

{{{continuityContext}}}
{{/if}}
```

---

## Conclusion

The Agentic Memory Architecture provides a comprehensive, scalable solution for memory management in AI systems. It now supports three complementary systems:

1. **Entity Memory System**: Structured, section-based memory for conversational AI
2. **Context Memory System**: Event tracking for multi-agent task execution  
3. **Continuity Memory Architecture**: Narrative-based memory with relational anchors and identity evolution

Together, these enable sophisticated agent behaviors, continuous learning, and genuine relationship continuity.

For questions or issues, refer to the troubleshooting section or review the source code in:
- Entity Memory: `pathways/system/entity/memory/`
- Context Memory: `helper-apps/cortex-autogen2/context/`
- Continuity Memory: `lib/continuity/`
- Storage: `lib/keyValueStorageClient.js`

