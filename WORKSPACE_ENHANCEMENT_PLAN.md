# Workspace Enhancement Plan — COMPLETED

## All Phases Complete

### Phase 1: Port Workspace Stability Enhancements (e02fbc6)
Backend abstraction layer, workspace_client.js hardening, container enhancements, SSH tool improvements.

### Phase 2: Hetzner Multi-Tenant Docker Host Pool (8553537)
HetznerClient, HostRegistry, HetznerBackend, admin REST API, 36 tests.

### Phase 3: Security Fixes (2384f1e)
Path traversal protection, container/volume name sanitization.

### Phase 4: Tests, Admin API, Deployment (f2a586b)
Full test suite, admin endpoints, deploy workflow updates.

### Phase 5: GCS-Only File Handler (89bf1ba)
Complete rewrite — 5000 → 1200 lines. Azure/Redis/local removed.

### Phase 6: fileUtils.js + Tool Updates (daa5632)
2700 → 890 lines. Redis collections removed, GCS source of truth.

### Phase 7: Remove checkHash, Add signUrl (f3eb222)
Files found via listFolder, signed URLs via signUrl endpoint. 18 integration tests.

### Phase 8: Remove Hash Dedup (11e24c2)
Files stored at natural paths ({userId}/scope/{filename}), no content hashing.

### Phase 9: Hetzner Volumes + gcsfuse + SSH Simplification (c91d293)
Persistent block storage, GCS FUSE mount at /workspace/files/, push/pull removed.

### Phase 10: Production Config (current)
docker-compose.prod.yml, .env.sample, deployment docs.

---

## Architecture Summary

**File Storage**: GCS only. Per-user path prefixes. Signed URLs for all access.
**Workspace Storage**: Hetzner Volumes (persistent block storage) + gcsfuse for user files.
**Workspace Backend**: Docker (single host) or Hetzner (multi-host pool, auto-scaling).
**No Redis** for file metadata. GCS is sole source of truth.
**No hashing**. Files stored at natural paths. No dedup.

## Environment Variables

### Required
- `GCS_BUCKET_NAME` — GCS bucket for user files
- `GCP_SERVICE_ACCOUNT_KEY` — Service account JSON for GCS access + gcsfuse

### Workspace (Docker backend, default)
- `WORKSPACE_BACKEND=docker`
- `WORKSPACE_IMAGE=cortex-workspace:latest`

### Workspace (Hetzner backend)
- `WORKSPACE_BACKEND=hetzner`
- `HETZNER_API_TOKEN` — Hetzner Cloud API token
- `HETZNER_LOCATION=fsn1`
- `HETZNER_SERVER_TYPE=cx42`
- `HETZNER_FIREWALL_ID` — Firewall allowing private network access
- `HETZNER_PRIVATE_NETWORK_ID` — Private network for Docker host communication
