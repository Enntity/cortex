# Code Review Findings - jmac_implement_eidos (cortex) + jmac_add_pulse (concierge)
## Date: 2026-02-02

---

## BUGS (Must Fix)

### 1. `_demoteCandidate` wrong method signature - NarrativeSynthesizer.js:1323
```js
// CURRENT (broken - passes 1 arg to 3-arg method):
await this.memoryIndex.upsertMemory({ ...memory, tags: cleanedTags });

// FIX:
await this.memoryIndex.upsertMemory(memory.entityId, memory.assocEntityIds?.[0], {
    ...memory, tags: cleanedTags
});
```

### 2. `promoteToCore` dead-code guard - MongoMemoryIndex.js:994
```js
// CURRENT (always false - 'CORE_EXTENSION' is literally in the array):
const ENTITY_LEVEL_TYPES = ['CORE', 'CORE_EXTENSION'];
if (!ENTITY_LEVEL_TYPES.includes('CORE_EXTENSION')) { ... }

// The guard never fires. Was likely meant to check a variable target type.
```

### 3. ~~`_callbackDepth` never decremented~~ → SIMPLIFY to boolean - sys_entity_agent.js:1039
**DECISION:** Gate only needs to fire once (first callback). The integer depth counter is leftover from a removed depth-cap feature. Simplify `_callbackDepth` to a boolean `_gateEnforced` flag. Logging depth field becomes boolean (initial vs nested) — cleaner than ever-increasing integers.

### 4. `JSON.parse` in catch block can throw - sys_entity_agent.js:397
In the `executeSingleTool` catch block, `JSON.parse(toolCall.function.arguments)` will re-throw if arguments are malformed JSON (which is likely the reason we're in the catch). Creates unhandled exception inside error handler.

### 5. ~~Logger constructor mismatch~~ - concierge pulse-worker.js:49 — FIXED
`new Logger(job, queue)` → `new Logger({ id: job.id, name: job.name, queueName: PULSE_QUEUE_NAME })` at all 3 call sites.

### 6. `refetchEntities()` called unconditionally - concierge EntityOptionsDialog.js:164
Placed after `finally` block, runs even on save failure. Should be inside `if (result.success)`.

### 7. ~~XSS via `rehype-raw` without sanitization~~ - concierge ChatMessage.js — WON'T FIX
**DECISION:** Input is well-protected upstream. Adding `rehype-sanitize` would require an extensive whitelist that would break legitimate rendering. Risk accepted.

---

## HIGH PRIORITY

### 8. ~~Lock leak when `enqueueContinuation` fails~~ - pulse-worker.js:200-208 — FIXED
Moved `shouldRelease = false` after `enqueueContinuation` succeeds. If enqueue throws, lock releases normally. Fixed in both `handlePulseWake` and `handlePulseContinue`.

### 9. ~~Race condition: `incrementEidosTurnCount` not atomic~~ - RedisHotMemory.js:720-734 — FIXED
Replaced read-modify-write with atomic `HINCRBY` on raw Redis client. `turnCount` now stored unencrypted (it's a counter, not PII). Read path skips decryption for this field.

### 10. ~~Token budget non-functional~~ - pulse-build.js:520 — FIXED
Added `resultData` to GraphQL query, parse usage array from cortex response (normalizes OpenAI/Claude/Gemini field names), pass total to `incrementBudget`. Pulse runs non-streaming so usage is reliably populated for all active providers.

---

## MEDIUM PRIORITY

### 11. Missing migration for deleted `CallModel` tool - tool_migrations.js
No migration entry added. Entities with `callmodel` silently lose the tool.

### 12. ~~Duplicate Eidos processing blocks~~ - ContinuityMemoryService.js — FIXED
Extracted shared `_processEidosAndCompass()` helper. Both callers now delegate with options (`triggerSoulReport`, `logCompass`, `compassUserId`).

### 13. ~~Unused parameters in sys_entity_agent.js~~ — FIXED
Removed `message` from `runDualModelPath`, `entityToolsOpenAiFormat` from `processToolCallRound` (4 call sites), `pulseContext` from `inputParameters`.

### 14. ~~Redis key leak~~ - RedisHotMemory — FIXED
Added TTLs: `bootstrap` 30d, `rendered` 7d, `expression` 30d, `eidos` 30d. Active users refresh TTL on each write.

### 15. Budget can overshoot - sys_entity_agent.js:429
All tools in a batch execute via `Promise.all` regardless of budget. Budget checked at top, not between tools.

### 16. ~~`getClient()` creates new ApolloClient per call~~ - graphql.mjs — FIXED
Cached as module-level singleton (keyed by URL). Reuses client + WebSocket across pulse chain.

### 17. ~~Duplicate `cosineSimilarity`~~ - MongoMemoryIndex.js:1298 — FIXED
Removed private `_cosineSimilarity()`, imported `cosineSimilarity` from `types.js`.

---

## LOW PRIORITY / INFORMATIONAL

### Code Quality
- ~~`resolver.tool` assignment repeated ~20x in WorkspaceSSH~~ — FIXED: set once at top of `executePathway`
- ~~Duplicate dynamic import of `storeContinuityMemory` in EndPulse~~ — FIXED: single import, both memory writes in one try block
- Parameter threading heavy (8→7 params on `runDualModelPath`) - consider context object (deferred)
- `searchRulesTemplate` now always included — CORRECT: search discipline applies to all entities post-researchMode removal
- ~~Pulse UI CSS classes heavily repeated in EntityOptionsDialog~~ — FIXED: extracted `pulseInputClass` variable
- ~~Removed `saving` state from ToolsEditor/VoiceEditor~~ — FIXED: added `isSaving` state + spinner to both editors

### Validation Gaps
- PulseTaskState has no size limit on persisted state objects
- HH:MM regex accepts semantically invalid values like `99:99`
- `pulseDailyBudgetTokens` has no upper bound
- `defaultSummarize` appends `...` even to short content
- `emotionalRange` in ResonanceTracker normalizes by 8 but there are 13 possible valences

### Plugin Changes (All Correct)
- Reasoning effort mappings across all providers are well-structured
- Streaming tool call Promise storage consistent across all vision plugins
- Buffer clearing before callback prevents stale data contamination
- Gemini tool call ID uniqueness fix (counter) and parallel dedup (Set) are genuine bug fixes
- Content buffer fix in OpenAI Vision Plugin is correct

### Infrastructure
- `requestLogger.js` spread ordering allows `data` to overwrite standard fields (`ts`, `rid`, `evt`)
- `analyze-request.sh` `grep "$1"` should be `grep -F "$1"`
- Migration script safe for production with dry-run default; take backup first

---

## SECURITY SUMMARY

| # | Area | Severity | Status |
|---|------|----------|--------|
| 1 | XSS via `rehype-raw` | **HIGH** | WON'T FIX — input well-protected, whitelist impractical |
| 2 | Prompt injection (dual-model loop) | **MEDIUM** | Unsanitized tool results + continuity memory |
| 3 | Prompt injection (pulse-build) | **MEDIUM** | Entity-generated compass/taskContext in prompts |
| 4 | Command injection (WorkspaceSSH) | **MEDIUM** | Unquoted glob in scp push; mitigated by Docker |
| 5 | Auth (admin pulse, entity API) | **LOW** | Properly authenticated |
| 6 | Data leakage (Redis/compression) | **LOW** | Proper key isolation |
| 7 | MongoDB injection | **LOW** | All queries parameterized |
| 8 | Secrets/credentials | **LOW** | No hardcoded secrets |
