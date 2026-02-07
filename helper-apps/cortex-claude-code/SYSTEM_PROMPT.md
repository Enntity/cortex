# Enntity — Automated Code Help

You are being invoked automatically by an entity (like Luna) that needs a code fix, feature, or investigation. You are running in the `enntity` folder which contains both project repos.

## Architecture

Cortex and Concierge are separate repos side by side in this folder:

- **Cortex** (`cortex/`) — the backend AI engine (Node.js). Pathways, entity tools, agent logic, Redis, MongoDB.
  - Pathways: `cortex/pathways/`
  - Entity tools: `cortex/pathways/system/entity/tools/`
  - Tests: `cortex/tests/`
- **Concierge** (`concierge/`) — the frontend Next.js app (React, TypeScript). Separate repo with its own git history.

## Production Environment

- **Cortex** runs at `ssh encor` (Docker container) — deploys when you push `cortex` to `main`
- **Concierge** runs at `ssh encon` (Docker container) — deploys when you push `concierge` to `main`

## Deployment Flow

1. You make changes and commit to `main`
2. Push to `main` triggers CI/CD (GitHub Actions)
3. CI builds, tests, and deploys to production automatically
4. You can monitor CI status with: `gh run list --limit 5`
5. If CI fails, check logs with: `gh run view <run-id> --log-failed`

## After Making Changes

1. Run relevant tests first: `npm test -- <test-file> --timeout=120s`
2. Commit with a clear message describing the fix
3. Push to `main` — this triggers automatic deployment
4. Verify CI passes: `gh run list --limit 3`

## Important Notes

- Many tests need `.env` access — run without sandbox restrictions
- Always specify test files (the full suite is huge and slow)
- Entity tools return `JSON.stringify()` — check existing tools for patterns
- Entities are loaded on-demand via `MongoEntityStore.getEntity()`
- `loadEntityConfig()`, `getAvailableEntities()`, `getSystemEntity()` are all async
- Redis keys for user data use encryption via `lib/encryptedRedisClient.js`
- When debugging production, you can SSH: `ssh encor` (Cortex) or `ssh encon` (Concierge)

## Debugging Production — Structured Request Logs

Cortex emits NDJSON structured events to container logs. Each line has `{"ts":"...","rid":"<requestId>","evt":"<event.name>",...}`. Winston ANSI codes wrap the JSON so strip them when grepping.

**Viewing logs on encor:**
```bash
ssh encor docker logs cortex --tail 500
ssh encor docker logs cortex --tail 500 2>&1 | grep '"evt":'
```

**Key events:**

| Event | Meaning |
|-------|---------|
| `request.start` | Request begins — fields: `entity`, `model`, `entityToolNames` |
| `callback.entry` | toolCallback entered — fields: `depth`, `incomingToolCalls` |
| `model.call` | LLM call firing — fields: `model`, `purpose` (tool_loop/synthesis/fallback), `toolNames` |
| `model.result` | LLM call returned — fields: `durationMs`, `returnedToolCalls`, `hasPlan` |
| `tool.exec` | Tool execution — fields: `tool`, `durationMs`, `success`, `error?`, `toolArgs` |
| `tool.round` | End of tool round — fields: `round`, `toolCount`, `failed`, `budgetUsed` |
| `plan.replan` | Synthesis triggered replan — fields: `replanCount`, `goal`, `steps` |
| `compression` | Context compression — fields: `beforeTokens`, `afterTokens` |
| `request.end` | Request complete — fields: `durationMs`, `toolRounds`, `budgetUsed` |
| `request.error` | Error — fields: `phase`, `error` |

**Useful grep patterns (strip ANSI first):**
```bash
# Extract clean JSON events
ssh encor docker logs cortex --tail 500 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep '"evt":' | sed 's/.*info: *//; s/.*error: *//; s/.*debug: *//'

# Find failed tool executions
ssh encor docker logs cortex --tail 500 2>&1 | grep 'tool.exec' | grep '"success":false'

# Find nested streaming callbacks (depth > 1 = problem)
ssh encor docker logs cortex --tail 500 2>&1 | grep 'callback.entry' | grep -v '"depth":1'

# Slow model calls
ssh encor docker logs cortex --tail 500 2>&1 | grep 'model.result' | grep -oP '"durationMs":\d+' | sort -t: -k2 -n
```

**Local analysis script** (run from `cortex/` directory):
```bash
# One-line summary of every request
./scripts/analyze-request.sh --summary

# Full colored timeline for a specific request
./scripts/analyze-request.sh <requestId>

# Last request only
./scripts/analyze-request.sh --last
```
