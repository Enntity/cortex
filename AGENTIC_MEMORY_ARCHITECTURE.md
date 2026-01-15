# Agentic Memory Architecture

This project now uses **Continuity Memory** as the only memory system for entities and agents. The legacy “memory sections” system (memorySelf/memoryUser/etc.) and its pathways/tools have been removed.

## What’s In Use

- **Continuity Memory** provides narrative context, relational anchors, and evolving identity.
- It is injected into agent prompts via `AI_CONTINUITY_CONTEXT`.
- It is managed by the Continuity services in `lib/continuity/`.

## Integration Points

- **PathwayResolver** loads Continuity context before each request.
- **sys_entity_agent** includes Continuity context in its system prompt.
- **sys_tool_create_entity** seeds CORE/ANCHOR memories when available.

## Reference

See `CONTINUITY_MEMORY_DESIGN.md` for the full design and operational details.
