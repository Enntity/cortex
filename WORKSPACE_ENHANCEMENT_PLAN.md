# Workspace Enhancement Plan

## Completed

### Phase 1: Port Workspace Stability Enhancements (committed: e02fbc6)
- Backend abstraction layer (ContainerBackend, DockerBackend, factory)
- workspace_client.js hardening (image versioning, stale state recovery, stopped container wake, persistent shareName, safe secrets, enhanced error detection, 401 auth recovery, idle reaper)
- Container enhancements (/reconfigure, /shell/jobs, mutable secrets, .env sourcing, path traversal protection)
- SSH tool improvements (filtered errors, bg/poll hints, timeoutSeconds, jobs command)

### Phase 2: Hetzner Multi-Tenant Docker Host Pool (committed: 8553537)
- HetznerClient (Hetzner Cloud API wrapper)
- HostRegistry (Redis-backed host tracking)
- HetznerBackend (multi-tenant Docker hosts, auto-scale up/down, health monitoring)
- Admin REST API (pool status, add/remove hosts, health check)
- 36 unit tests

### Phase 3: Security Fixes (committed: 2384f1e)
- Path traversal protection on all workspace file endpoints
- Container/volume name sanitization

### Phase 4: Tests, Admin API, Deployment (committed: f2a586b)
- HetznerClient, HostRegistry, HetznerBackend, workspace server tests
- Admin REST endpoints mounted in graphql.js
- Deploy workflow workspace image SHA tagging

---

## In Progress

### Phase 5: GCS-Only File Handler
- Replace cortex-file-handler with aj-cortex version
- Strip Azure Blob Storage, local storage, dual-write
- Strip Redis hash/dedup/permanent flags — GCS is source of truth
- Per-user file isolation via GCS path prefixes (`/{userId}/`)
- Folder structure: `{userId}/global/`, `{userId}/chats/{chatId}/`, etc.
- Signed URLs for time-limited file access (replaces SAS tokens)
- Pare down tests to GCS-only

---

## Remaining Work

### Phase 6: Hetzner Volumes for Workspace Persistence (~200 lines)
- HetznerBackend creates/attaches Hetzner Volume (block storage) per workspace
- Volume follows workspace across host migrations (detach from old host, attach to new)
- Cloud-init mounts volume at `/mnt/workspace`, Docker binds container `/workspace` to it
- Entity config stores `hetznerVolumeId` alongside `shareName`
- On workspace destroy with --destroy-volume: detach + delete Hetzner Volume
- On normal destroy/reprovision: volume preserved, reattached to new container

### Phase 7: gcsfuse in Workspace Containers (~150 lines)
- Add gcsfuse to workspace Dockerfile (Google apt repo)
- Update entrypoint.sh to mount GCS on startup if credentials provided
- Wire `buildGcsMountPayload()` into workspace provisioning (workspace_client.js)
- `/reconfigure` endpoint: accept gcsBucket + serviceAccountKey + onlyDir params
- Mount with `--only-dir {userId}/` for per-user isolation
- Service account key written to /tmp (outside /workspace, excluded from backups)
- gcsfuse cache config for latency mitigation from Hetzner

### Phase 8: Update lib/fileUtils.js for GCS-Only (~significant refactor)
- Add `listFilesForContext(contextId, { chatId, fileScope })` — calls file handler `listFolder`
- Add `buildFileLocation(contextId, { chatId, workspaceId, fileScope })` — constructs routing params
- Update `uploadFileToCloud()` to pass routing fields (userId, chatId, fileScope)
- Remove Azure-specific URL generation
- Signed URL generation via file handler (replaces SAS tokens)
- Cloud listing as source of truth (Redis collection becomes optional metadata layer)

### Phase 9: Simplify Workspace SSH Tool (~remove ~150 lines)
- Remove `files push` / `files pull` handlers (FUSE mount handles file persistence)
- Keep `files backup` / `files restore` (workspace snapshots, not user files)
- Add auto-detect of files written to `/workspace/files/` (port from aj-cortex)
- Return display markdown with signed URLs for detected files
- Update tool description to explain /workspace/files/ auto-sync

### Phase 10: Integration & Production Config
- Update docker-compose.prod.yml for GCS-only file handler config
- Update deploy workflow for new file handler image
- GCS service account provisioning (create bucket, service account, grant roles)
- Environment variable documentation (.env.sample updates)
- Integration tests: workspace provision → FUSE mount → file write → signed URL → file read
- End-to-end test: entity chat → workspace command creates file → file visible in UI
