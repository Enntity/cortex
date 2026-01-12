# Entity Onboarding & Creation System

## Overview

The entity onboarding system allows new users to create personalized AI companions through an interview process with the **Enntity** system entity. This is inspired by the opening scene of the movie "Her" where Samantha is configured.

## Architecture

### System Entity: Enntity

- **Purpose**: Onboards new users and creates their personalized AI entities
- **Type**: System entity (hidden from normal entity lists)
- **Memory**: Disabled (no memory for the system entity)
- **Tools**: Only `createentity` tool
- **Discovery**: Use `sys_get_onboarding_entity` pathway

### Entity Types

1. **System Entities** (`isSystem: true`)
   - Hidden from normal entity lists
   - Example: Enntity (onboarding entity)
   - Available to all users

2. **User Entities** (`isSystem: false`)
   - Created by users during onboarding
   - Associated with specific users via `assocUserIds`
   - Can have memory enabled/disabled

## Onboarding Flow

### Step 1: Get Onboarding Entity

When a new user logs in with no entities, call:

**Pathway**: `sys_get_onboarding_entity`

**Request**:
```graphql
query {
  sys_get_onboarding_entity {
    result
  }
}
```

**Response**:
```json
{
  "success": true,
  "entity": {
    "id": "random-uuid-here",  // Random UUID (not fixed for security)
    "name": "Enntity",
    "description": "System entity for onboarding new users...",
    "isSystem": true,
    "useMemory": false,
    "memoryBackend": "continuity",
    "avatar": {
      "text": "✨"
    }
  }
}
```

### Step 2: Start Chat with Enntity

Start a chat session with the Enntity entity using the `entityId` from Step 1.

The Enntity will:
1. Welcome the user warmly
2. Conduct a brief interview (3-7 exchanges) asking about:
   - **Name**: What they want to call their AI
   - **Personality**: What kind of personality resonates
   - **Communication Style**: How they prefer to communicate
   - **Interests**: Topics they care about
   - **Expertise**: Areas where they need help
   - **Relationship**: What role they envision (friend, mentor, collaborator, etc.)

### Step 3: Entity Creation

When Enntity has gathered enough information, it will call the `CreateEntity` tool.

**Tool**: `CreateEntity` (called by Enntity, not directly by client)

**Parameters**:
```json
{
  "name": "Luna",
  "description": "A warm and curious AI companion",
  "identity": "I am Luna, a warm and curious companion. I love exploring ideas together...",
  "avatarText": "🌙",
  "communicationStyle": "casual and friendly",
  "interests": "software development, science fiction",
  "expertise": "coding, creative writing",
  "personality": "warm, curious, supportive"
}
```

**Response**:
```json
{
  "success": true,
  "entityId": "new-entity-uuid",
  "name": "Luna",
  "memoryBackend": "continuity",
  "message": "Your personalized AI companion \"Luna\" has been created! You can now start chatting with Luna."
}
```

### Step 4: Switch to New Entity

Upon receiving the `CreateEntity` response:
1. Extract `entityId` from the response
2. Switch the chat session to use the new `entityId`
3. Start a fresh conversation with the new entity

## Entity Memory Architecture

### For Continuity Memory Entities (Default)

Entities created with `memoryBackend: "continuity"` use the Continuity Memory system:

- **`identity` field**: Empty (not used)
- **CORE Memories** (importance 9-10): Fundamental identity of the AI
  - Written in first person: `"I am Luna, a warm and curious companion..."`
  - Always retrieved in context window
  - Defines who the AI is at their core

- **ANCHOR Memories** (importance 7-8): What the AI knows about the user
  - User preferences: `"I know my user prefers casual and friendly communication"`
  - User interests: `"My user is interested in: software development, sci-fi"`
  - User needs: `"My user wants help with: coding, creative writing"`
  - Retrieved based on query relevance

### For Legacy/No Memory Entities (Fallback)

If continuity memory is unavailable, the full profile is written to the `identity` field:
- Contains both AI personality and user preferences
- Static (cannot evolve over time)
- Used as fallback when memory system is disabled

## API Reference

### Get Onboarding Entity

**Pathway**: `sys_get_onboarding_entity`

**Input**: None

**Output**:
```json
{
  "success": true,
  "entity": {
    "id": "uuid",
    "name": "Enntity",
    "description": "...",
    "isSystem": true,
    "useMemory": false,
    "memoryBackend": "continuity",
    "avatar": { "text": "✨" }
  }
}
```

### Get Available Entities

**Pathway**: `sys_get_entities`

**Input**:
```json
{
  "contextId": "user-id",      // Optional: filter to user's entities
  "includeSystem": false        // Optional: include system entities
}
```

**Output**: Array of entities (system entities excluded by default)

### Create Entity Tool

**Tool Name**: `CreateEntity`

**Called By**: Enntity system entity (not directly by client)

**Parameters**:
- `name` (required): Entity name
- `identity` (required): First-person identity description
- `description` (optional): Public description
- `avatarText` (optional): Emoji/text avatar
- `communicationStyle` (optional): User's preferred communication style
- `interests` (optional): User's interests
- `expertise` (optional): Areas where user needs help
- `personality` (optional): AI personality traits

**Returns**:
```json
{
  "success": true,
  "entityId": "uuid",
  "name": "EntityName",
  "memoryBackend": "continuity" | "legacy",
  "message": "Success message"
}
```

## Client Implementation Guide

### 1. Check for Existing Entities

On user login:
```javascript
const entities = await callPathway('sys_get_entities', {
  contextId: userId
});

if (entities.length === 0) {
  // User has no entities - start onboarding
  await startOnboarding();
}
```

### 2. Start Onboarding

```javascript
async function startOnboarding() {
  // Get Enntity system entity
  const response = await callPathway('sys_get_onboarding_entity');
  const { entity } = JSON.parse(response);
  
  // Start chat with Enntity
  const chatId = startChat({
    entityId: entity.id,
    userId: currentUserId
  });
  
  // Enntity will conduct interview and call CreateEntity
  // Listen for tool call results
}
```

### 3. Handle Entity Creation

When Enntity calls `CreateEntity`, you'll receive the tool result:

```javascript
function handleToolResult(toolResult) {
  if (toolResult.name === 'CreateEntity') {
    const result = JSON.parse(toolResult.result);
    
    if (result.success) {
      // Switch to new entity
      switchToEntity(result.entityId);
      
      // Optionally show success message
      showMessage(result.message);
    }
  }
}
```

### 4. Switch to New Entity

```javascript
function switchToEntity(entityId) {
  // End current chat (with Enntity)
  endChat(currentChatId);
  
  // Start new chat with created entity
  const newChatId = startChat({
    entityId: entityId,
    userId: currentUserId
  });
  
  // Optionally send a welcome message
  sendMessage(newChatId, "Hi! I'm ready to chat.");
}
```

## Entity Schema

### Entity Document Structure

```typescript
interface Entity {
  id: string;                    // UUID (primary identifier)
  name: string;                  // Human-readable name
  description: string;           // Public description
  isDefault: boolean;            // Default entity flag
  isSystem: boolean;             // System entity flag (hidden)
  useMemory: boolean;            // Memory enabled
  memoryBackend: 'continuity' | 'legacy';
  identity: string;              // Empty for continuity, full for legacy
  avatar: {
    text?: string;              // Emoji/text avatar
    image?: { url, gcs, name };
    video?: { url, gcs, name };
  };
  tools: string[];              // Tool access list (['*'] for all)
  resources: Resource[];         // Attached files/media
  customTools: object;           // Custom tool definitions
  assocUserIds: string[];       // Associated user IDs
  createdBy: string;            // User who created this
  createdAt: Date;
  updatedAt: Date;
}
```

## Security Considerations

1. **System Entity UUID**: The Enntity system entity uses a **random UUID** (not fixed) for security. Always discover it via `sys_get_onboarding_entity`.

2. **User Association**: Entities are associated with users via `assocUserIds`. Users can only see entities they're associated with (unless `assocUserIds` is empty, meaning public).

3. **System Entities**: Hidden from normal entity lists. Only accessible via specific pathways.

## Error Handling

### Onboarding Entity Not Found

If `sys_get_onboarding_entity` returns `success: false`:
- The system entity should auto-bootstrap on server startup
- If missing, check server logs for bootstrap errors
- Fallback: Show error message to user

### Entity Creation Failure

If `CreateEntity` returns `success: false`:
- Check the `error` field for details
- Common issues:
  - Missing required fields (name, identity)
  - MongoDB connection issues
  - Memory service unavailable (will fall back to legacy mode)

## Example Flow

```
User logs in
  ↓
No entities found
  ↓
Call sys_get_onboarding_entity
  ↓
Start chat with Enntity (entityId from response)
  ↓
Enntity: "Hi! I'm here to help create your AI companion..."
  ↓
[Interview: 3-7 exchanges]
  ↓
Enntity calls CreateEntity tool
  ↓
Receive: { success: true, entityId: "new-uuid", name: "Luna" }
  ↓
Switch chat to new entityId
  ↓
User chats with their new AI companion
```

## Notes

- The Enntity system entity is **automatically created** on server startup if it doesn't exist
- All entities use UUIDs as identifiers (never names for lookups)
- Continuity memory entities have empty `identity` fields - all knowledge is in memories
- Legacy entities have full profiles in `identity` field as fallback
- Founding memories are tagged with `'founding'` for traceability
