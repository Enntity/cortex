// workspace_client.js
// Shared module for workspace tools: HTTP client, auto-provisioning, backend abstraction.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import logger from '../../../../../lib/logger.js';
import { config } from '../../../../../config.js';
import { decrypt } from '../../../../../lib/crypto.js';
import { loadEntityConfig } from './sys_entity_tools.js';
import { getEntityStore } from '../../../../../lib/MongoEntityStore.js';
import { getBackend } from './backends/index.js';

/**
 * Resolve the full workspace image reference (name:tag).
 * Combines workspaceImage + workspaceImageVersion so Docker always
 * pulls an exact version — never a cached `:latest`.
 */
export function resolveWorkspaceImage() {
    const base = config.get('workspaceImage');
    const version = config.get('workspaceImageVersion');
    // If the image already has a tag (e.g. from WORKSPACE_IMAGE env), use it as-is
    if (base.includes(':')) return base;
    // If no version configured, fall back to :latest (local dev)
    if (!version) return `${base}:latest`;
    return `${base}:${version}`;
}

// In-memory lock to prevent concurrent provisioning for the same entity
const provisioningLocks = new Map();

// In-memory activity tracker: entityId -> timestamp (ms)
// Updated on every successful workspace request; used by the idle reaper
// to stop containers that have been inactive for longer than the configured timeout.
const lastActivity = new Map();

// Track which entities have been flushed to MongoDB so we only write changes
const lastFlushedActivity = new Map();

/**
 * Parse memory limit string (e.g. '512m', '1g') to megabytes.
 * Backend-agnostic — returns MB for use by any backend.
 */
export function parseMemoryToMB(str) {
    const match = str.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/);
    if (!match) return 512; // default 512MB

    const num = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
        case 'k': return Math.round(num / 1024);
        case 'm': return Math.round(num);
        case 'g': return Math.round(num * 1024);
        default: return Math.round(num / (1024 * 1024)); // assume bytes
    }
}

/**
 * Make an authenticated HTTP request to an entity's workspace client.
 * Auto-provisions the workspace if not yet configured.
 *
 * @param {string} entityId - Entity UUID
 * @param {string} endpoint - Path (e.g. '/shell', '/read')
 * @param {Object} [body] - JSON body for POST requests
 * @param {Object} [options]
 * @param {string} [options.method] - HTTP method (default: POST, or GET if no body)
 * @param {number} [options.timeoutMs] - Request timeout in ms (default: 30000)
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function workspaceRequest(entityId, endpoint, body = null, options = {}) {
    const method = options.method || (body ? 'POST' : 'GET');
    const timeoutMs = options.timeoutMs || 30000;

    // Load entity config and get workspace info
    let entityConfig = await loadEntityConfig(entityId);
    if (!entityConfig) {
        return { success: false, error: 'Entity not found' };
    }

    // Recover from stale transitional states ('starting', 'provisioning').
    // If stuck for >5 min, mark as error to trigger re-provision.
    const ws = entityConfig.workspace;
    if (ws && (ws.status === 'starting' || ws.status === 'provisioning')) {
        const staleMs = Date.now() - (ws.provisionedAt ? new Date(ws.provisionedAt).getTime() : Date.now());
        if (staleMs > 5 * 60 * 1000) {
            logger.warn(`Workspace for ${entityId} stuck in '${ws.status}' — marking as error`);
            try {
                await getEntityStore().upsertEntity({ ...entityConfig, workspace: { ...ws, status: 'error' } });
            } catch { /* best effort */ }
            entityConfig = await loadEntityConfig(entityId);
        } else {
            return { success: false, error: `Workspace is ${ws.status}, please retry shortly` };
        }
    }

    // Auto-provision if workspace not configured or in error state
    if (!entityConfig.workspace || !entityConfig.workspace.url || entityConfig.workspace.status === 'error') {
        const provisionResult = await provisionWorkspace(entityId, entityConfig);
        if (!provisionResult.success) {
            return { success: false, error: provisionResult.error };
        }
        // Reload entity config after provisioning
        entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig?.workspace?.url) {
            return { success: false, error: 'Workspace provisioning completed but config not available' };
        }
    }

    // Wake stopped workspace on demand — much faster than full re-provision
    if (entityConfig.workspace.status === 'stopped' && entityConfig.workspace.containerId) {
        const wakeResult = await wakeWorkspace(entityId, entityConfig);
        if (!wakeResult.success) {
            return { success: false, error: wakeResult.error };
        }
        entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig?.workspace?.url) {
            return { success: false, error: 'Workspace wake completed but config not available' };
        }
    }

    // Reprovision if workspace image is outdated
    const expectedVersion = config.get('workspaceImageVersion');
    if (expectedVersion && entityConfig.workspace.imageVersion &&
        entityConfig.workspace.imageVersion !== expectedVersion) {
        logger.info(`Workspace for ${entityId} has stale image (${entityConfig.workspace.imageVersion} vs ${expectedVersion}) — reprovisioning`);
        await destroyWorkspace(entityId, entityConfig);
        const provisionResult = await provisionWorkspace(entityId, await loadEntityConfig(entityId));
        if (!provisionResult.success) {
            return { success: false, error: provisionResult.error };
        }
        entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig?.workspace?.url) {
            return { success: false, error: 'Workspace re-provision completed but config not available' };
        }
    }

    const { url, secret } = entityConfig.workspace;

    try {
        const fetchOptions = {
            method,
            headers: {
                'x-workspace-secret': secret,
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(timeoutMs),
        };

        if (body && method !== 'GET') {
            fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(`${url}${endpoint}`, fetchOptions);

        // Track activity for idle reaper
        lastActivity.set(entityId, Date.now());

        if (response.status === 401) {
            // Secret mismatch — container may have restarted, reverting
            // its in-memory secret to the bootstrap secret from the env var.
            // Try reconfiguring with the bootstrap secret first (fast path),
            // then fall back to full reprovision if that fails.
            const workspace = entityConfig.workspace;

            if (workspace.bootstrapSecret) {
                logger.warn(`Workspace auth failed for ${entityId} — attempting reconfigure with bootstrap secret`);
                try {
                    const backend = await getBackend();
                    await reconfigureForEntity(entityId, entityConfig, {
                        containerName: workspace.containerId,
                        shareName: workspace.shareName || workspace.containerId,
                        url: workspace.url,
                        bootstrapSecret: workspace.bootstrapSecret,
                        containerId: workspace.containerId,
                    }, backend);

                    // Retry the request with the fresh secret
                    entityConfig = await loadEntityConfig(entityId);
                    const retryOptions = {
                        method,
                        headers: {
                            'x-workspace-secret': entityConfig.workspace.secret,
                            'Content-Type': 'application/json',
                        },
                        signal: AbortSignal.timeout(timeoutMs),
                    };
                    if (body && method !== 'GET') {
                        retryOptions.body = JSON.stringify(body);
                    }
                    const retryResponse = await fetch(`${entityConfig.workspace.url}${endpoint}`, retryOptions);
                    lastActivity.set(entityId, Date.now());
                    if (!retryResponse.ok && retryResponse.status === 401) {
                        logger.warn(`Workspace auth still failing after reconfigure for ${entityId} — full reprovision`);
                    } else {
                        const retryData = await retryResponse.json();
                        if (retryData.error) {
                            return { success: false, error: retryData.error };
                        }
                        return { success: true, ...retryData };
                    }
                } catch (reconfigErr) {
                    logger.warn(`Reconfigure failed for ${entityId}: ${reconfigErr.message} — falling back to full reprovision`);
                }
            }

            // Full reprovision fallback
            logger.warn(`Workspace auth failed for ${entityId} — re-provisioning`);
            try {
                await getEntityStore().upsertEntity({
                    ...entityConfig,
                    workspace: { ...entityConfig.workspace, status: 'error' },
                });
            } catch { /* best effort */ }

            const provisionResult = await provisionWorkspace(entityId, entityConfig);
            if (!provisionResult.success) {
                return { success: false, error: `Workspace auth failed and re-provision failed: ${provisionResult.error}` };
            }

            // Retry the request with fresh config
            entityConfig = await loadEntityConfig(entityId);
            if (!entityConfig?.workspace?.url) {
                return { success: false, error: 'Re-provision completed but config not available' };
            }
            try {
                const retryOptions = {
                    method,
                    headers: {
                        'x-workspace-secret': entityConfig.workspace.secret,
                        'Content-Type': 'application/json',
                    },
                    signal: AbortSignal.timeout(timeoutMs),
                };
                if (body && method !== 'GET') {
                    retryOptions.body = JSON.stringify(body);
                }
                const retryResponse = await fetch(`${entityConfig.workspace.url}${endpoint}`, retryOptions);
                lastActivity.set(entityId, Date.now());
                if (retryResponse.status === 401) {
                    return { success: false, error: 'Authentication failed after re-provision' };
                }
                const retryData = await retryResponse.json();
                if (retryData.error) {
                    return { success: false, error: retryData.error };
                }
                return { success: true, ...retryData };
            } catch (retryErr) {
                return { success: false, error: `Workspace re-provisioned but request still failed: ${retryErr.message}` };
            }
        }

        const data = await response.json();

        if (data.error) {
            return { success: false, error: data.error };
        }

        return { success: true, ...data };
    } catch (e) {
        // Detect connection-level failures (ECONNREFUSED, ENOTFOUND, ECONNRESET, "fetch failed", etc.)
        const causeCode = e.cause?.code;
        const isConnectionError =
            e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' ||
            causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND' || causeCode === 'ECONNRESET' ||
            (e.name === 'TypeError' && e.message === 'fetch failed');

        if (isConnectionError) {
            // Container is dead — re-provision and retry the request in the same call
            logger.warn(`Workspace for ${entityId} unreachable — re-provisioning`);
            try {
                await getEntityStore().upsertEntity({
                    ...entityConfig,
                    workspace: { ...entityConfig.workspace, status: 'error' },
                });
            } catch { /* best effort */ }

            const provisionResult = await provisionWorkspace(entityId, entityConfig);
            if (!provisionResult.success) {
                return { success: false, error: `Workspace died and re-provision failed: ${provisionResult.error}` };
            }

            // Retry the request with fresh config
            entityConfig = await loadEntityConfig(entityId);
            if (!entityConfig?.workspace?.url) {
                return { success: false, error: 'Re-provision completed but config not available' };
            }
            try {
                const retryOptions = {
                    method,
                    headers: {
                        'x-workspace-secret': entityConfig.workspace.secret,
                        'Content-Type': 'application/json',
                    },
                    signal: AbortSignal.timeout(timeoutMs),
                };
                if (body && method !== 'GET') {
                    retryOptions.body = JSON.stringify(body);
                }
                const retryResponse = await fetch(`${entityConfig.workspace.url}${endpoint}`, retryOptions);
                lastActivity.set(entityId, Date.now());
                const retryData = await retryResponse.json();
                if (retryData.error) {
                    return { success: false, error: retryData.error };
                }
                return { success: true, ...retryData };
            } catch (retryErr) {
                return { success: false, error: `Workspace re-provisioned but request still failed: ${retryErr.message}` };
            }
        }

        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
            return { success: false, error: `Request timed out after ${Math.round(timeoutMs / 1000)}s` };
        }

        logger.error(`Workspace request failed for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Workspace request failed: ${e.message}` };
    }
}

/**
 * Provision a workspace container for an entity via the configured backend.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function provisionWorkspace(entityId, entityConfig) {
    // Acquire per-entity lock
    if (provisioningLocks.has(entityId)) {
        // Wait for existing provisioning to finish
        try {
            await provisioningLocks.get(entityId);
            return { success: true };
        } catch {
            return { success: false, error: 'Concurrent provisioning failed' };
        }
    }

    const provisionPromise = _doProvision(entityId, entityConfig);
    provisioningLocks.set(entityId, provisionPromise);

    try {
        const result = await provisionPromise;
        return result;
    } finally {
        provisioningLocks.delete(entityId);
    }
}

/**
 * Provision flow:
 *   1. Read stored shareName from entity config (preserves data across reprovisions)
 *   2. Create container, mounting the existing share if any
 *   3. Reconfigure with entity-specific secrets and rotate secret
 */
async function _doProvision(entityId, entityConfig) {
    const backend = await getBackend();

    // Determine if this entity already has persistent storage from a prior provision.
    // If so, we must mount that same share to preserve workspace data.
    const existingShareName = entityConfig?.workspace?.shareName
        || entityConfig?.workspace?.containerId  // backward compat: pre-shareName entities stored data under containerId
        || null;

    logger.info(`Provisioning workspace for entity ${entityId} [${backend.backendName} backend]${existingShareName ? ` (reusing share: ${existingShareName})` : ''}`);

    try {
        // Update entity status to provisioning (preserve shareName so it's not lost)
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: {
                ...(entityConfig.workspace || {}),
                status: 'provisioning',
            },
        });

        // Create a generic container (with existing share if any)
        const container = await createGenericContainer(entityId, backend, { shareName: existingShareName });

        // Reconfigure with entity-specific secrets
        await reconfigureForEntity(entityId, entityConfig, container, backend);

        logger.info(`Workspace provisioned for entity ${entityId}: ${container.url}`);
        return { success: true };
    } catch (e) {
        logger.error(`Failed to provision workspace for entity ${entityId}: ${e.message}`);

        // Mark as error
        try {
            const entityStore = getEntityStore();
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: {
                    ...(entityConfig.workspace || {}),
                    status: 'error',
                },
            });
        } catch {
            // Best effort
        }

        return { success: false, error: `Provisioning failed: ${e.message}` };
    }
}

/**
 * Create a generic container with minimal setup (no entity secrets).
 *
 * @param {string} entityId - Entity UUID (used for container naming)
 * @param {Object} backend - Container backend instance
 * @param {Object} [options]
 * @param {string} [options.shareName] - Existing share to mount (preserves data across reprovisions)
 * @returns {Promise<{containerName: string, shareName: string, url: string, bootstrapSecret: string, containerId: string}>}
 */
async function createGenericContainer(entityId, backend, options = {}) {
    const containerName = `workspace-${entityId}`;
    const shareName = options.shareName || containerName;
    const bootstrapSecret = crypto.randomBytes(32).toString('hex');
    const image = resolveWorkspaceImage();
    const cpus = parseFloat(config.get('workspaceCpus'));
    const memory = config.get('workspaceMemory');
    const diskSize = config.get('workspaceDiskSize');
    const memoryMB = parseMemoryToMB(memory);

    const env = [
        `WORKSPACE_SECRET=${bootstrapSecret}`,
        `PORT=3100`,
    ];

    logger.info(`Creating generic container ${containerName} [${backend.backendName}]${shareName !== containerName ? ` (share: ${shareName})` : ''}`);

    const { containerId, url } = await backend.createAndStart({
        containerName,
        image,
        env,
        cpus,
        memoryMB,
        diskSize,
        shareName,
    });

    const healthOk = await waitForHealth(url, backend.healthTimeoutMs);
    if (!healthOk) {
        throw new Error('Container failed to become healthy');
    }

    return { containerName, shareName, url, bootstrapSecret, containerId };
}

/**
 * Reconfigure a container for a specific entity.
 * Rotates the secret and injects entity secrets.
 * Works for both freshly-created and restarted containers.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config
 * @param {Object} container - Container info from createGenericContainer
 * @param {Object} backend - Container backend instance
 */
async function reconfigureForEntity(entityId, entityConfig, container, backend) {
    const { containerName, shareName, url, bootstrapSecret, containerId } = container;
    const newSecret = crypto.randomBytes(32).toString('hex');

    try {
        // Build reconfigure payload
        const reconfigPayload = { secret: newSecret };

        // Decrypt entity secrets for env injection
        const plainSecrets = {};
        if (entityConfig.secrets) {
            const systemKey = config.get('redisEncryptionKey');
            for (const [key, encVal] of Object.entries(entityConfig.secrets)) {
                const val = decrypt(encVal, systemKey);
                if (val) {
                    plainSecrets[key] = val;
                }
            }
        }
        if (Object.keys(plainSecrets).length > 0) {
            reconfigPayload.env = plainSecrets;
        }

        // Call /reconfigure using the bootstrap secret
        const response = await fetch(`${url}/reconfigure`, {
            method: 'POST',
            headers: {
                'x-workspace-secret': bootstrapSecret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(reconfigPayload),
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(`/reconfigure returned ${response.status}: ${errBody.error || response.statusText}`);
        }

        // Update entity config in MongoDB
        // Store bootstrapSecret so wakeWorkspace can re-authenticate after
        // a container restart (the container reverts to its env-var secret).
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: {
                url,
                secret: newSecret,
                bootstrapSecret,
                containerId: containerId || containerName,
                shareName: shareName || containerId || containerName,
                status: 'running',
                provisionedAt: new Date(),
                imageVersion: config.get('workspaceImageVersion') || null,
            },
        });
    } catch (e) {
        // Remove the container on failure — but NEVER destroy the volume.
        // The share may be pre-existing with user data.
        try {
            await backend.remove(containerId || containerName, containerName);
        } catch {
            // Best-effort cleanup
        }

        throw e;
    }
}

/**
 * Stop and remove a workspace container.
 * When destroyVolume is false (default), the share name is preserved in the entity
 * config so the next provision can remount it and recover workspace data.
 */
export async function destroyWorkspace(entityId, entityConfig, options = {}) {
    const { destroyVolume: shouldDestroyVolume = false } = options;
    const workspace = entityConfig?.workspace;
    const containerName = workspace?.containerId || `workspace-${entityId}`;
    const shareName = workspace?.shareName || workspace?.containerId || containerName;

    try {
        const backend = await getBackend();

        await backend.remove(containerName, containerName);

        if (shouldDestroyVolume) {
            await backend.destroyVolume(shareName);
        }

        // Update entity workspace config
        const entityStore = getEntityStore();
        if (shouldDestroyVolume) {
            // Volume gone — clear workspace entirely so next provision starts fresh
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: null,
            });
        } else {
            // Volume preserved — keep only the shareName so the next provision
            // can remount it and recover all workspace data.
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: { shareName },
            });
        }

        logger.info(`Workspace destroyed for entity ${entityId}${shouldDestroyVolume ? ' (volume removed)' : ` (volume preserved: ${shareName})`}`);
        return { success: true, message: `Workspace destroyed${shouldDestroyVolume ? ' (volume removed)' : ' (volume preserved)'}` };
    } catch (e) {
        logger.error(`Failed to destroy workspace for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Destroy failed: ${e.message}` };
    }
}

/**
 * Stop a workspace container without destroying it.
 * Container, volume, port bindings, and URL are all preserved for fast restart.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function stopWorkspace(entityId, entityConfig) {
    const workspace = entityConfig?.workspace;
    if (!workspace?.containerId) {
        return { success: false, error: 'No workspace container to stop' };
    }

    try {
        const backend = await getBackend();
        const containerName = workspace.containerId;
        await backend.stop(containerName, containerName);
    } catch {
        // May already be stopped — that's fine
    }

    try {
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: {
                ...workspace,
                status: 'stopped',
                stoppedAt: Date.now(),
            },
        });
    } catch (e) {
        logger.error(`Failed to update entity after stopping workspace: ${e.message}`);
        return { success: false, error: `Failed to update entity: ${e.message}` };
    }

    logger.info(`Workspace stopped for entity ${entityId}`);
    return { success: true };
}

/**
 * Wake a stopped workspace by starting its existing container.
 * Much faster than full provisioning — no image pull, no container create.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config (must have workspace.containerId)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function wakeWorkspace(entityId, entityConfig) {
    const workspace = entityConfig.workspace;
    const backend = await getBackend();
    const containerName = workspace.containerId;
    logger.info(`Waking stopped workspace for entity ${entityId}`);

    try {
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: { ...workspace, status: 'starting' },
        });

        await backend.start(workspace.containerId, containerName);

        const healthOk = await waitForHealth(workspace.url, backend.wakeHealthTimeoutMs);

        if (!healthOk) {
            // Container is dead — fall back to full re-provision
            logger.warn(`Workspace for ${entityId} not healthy after wake — re-provisioning`);
            return await provisionWorkspace(entityId, entityConfig);
        }

        // On Docker, stop/start restarts the process, reverting the
        // in-memory secret to the original WORKSPACE_SECRET env var.
        // Re-inject the correct secret via /reconfigure.
        if (workspace.bootstrapSecret) {
            await reconfigureForEntity(entityId, entityConfig, {
                containerName,
                shareName: workspace.shareName || workspace.containerId,
                url: workspace.url,
                bootstrapSecret: workspace.bootstrapSecret,
                containerId: workspace.containerId,
            }, backend);
        } else {
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: { ...workspace, status: 'running', stoppedAt: undefined },
            });
        }

        logger.info(`Workspace woken for entity ${entityId}`);
        return { success: true };
    } catch (e) {
        logger.error(`Failed to wake workspace for entity ${entityId}: ${e.message}`);

        // Fall back to full re-provision
        logger.warn(`Falling back to re-provision for ${entityId}`);
        return await provisionWorkspace(entityId, entityConfig);
    }
}

/**
 * Poll a workspace's /health endpoint until it responds OK.
 */
async function waitForHealth(baseUrl, maxWaitMs) {
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < maxWaitMs) {
        try {
            const res = await fetch(`${baseUrl}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            if (res.ok) return true;
        } catch {
            // Not ready yet
        }
        await new Promise(r => setTimeout(r, interval));
    }

    return false;
}

/**
 * Write entity secrets as a .env file to the workspace container.
 * Used both at provision time and when secrets are updated via API.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} secrets - { KEY: "plaintext_value", ... }
 * @returns {Promise<Object>} { success: boolean, error?: string }
 */
export async function syncSecretsToWorkspace(entityId, secrets) {
    if (!secrets || Object.keys(secrets).length === 0) return { success: true };
    // Write .env with export prefix so sourcing it exports to the environment.
    // Values are single-quoted to prevent shell interpretation; keys are
    // validated as safe env-var identifiers (letters, digits, underscores).
    const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const envContent = Object.entries(secrets)
        .filter(([k]) => SAFE_KEY.test(k))
        .map(([k, v]) => {
            // Shell-safe single-quoting: replace every ' with '\'' so
            // the value is never interpreted by the shell.
            const escaped = String(v).replace(/'/g, "'\\''");
            return `export ${k}='${escaped}'`;
        })
        .join('\n') + '\n';
    const b64 = Buffer.from(envContent).toString('base64');
    await workspaceRequest(entityId, '/write', {
        path: '/workspace/.env',
        content: b64,
        encoding: 'base64',
        createDirs: false,
    }, { timeoutMs: 10000 });

    // Ensure .bashrc sources .env so secrets are available in every shell
    const sourceLine = '[ -f /workspace/.env ] && . /workspace/.env';
    await workspaceRequest(entityId, '/shell', {
        command: `grep -qF '${sourceLine}' ~/.bashrc 2>/dev/null || echo '${sourceLine}' >> ~/.bashrc`,
    }, { timeoutMs: 10000 });

    // Source it now for any currently running shells
    await workspaceRequest(entityId, '/shell', {
        command: '. /workspace/.env',
    }, { timeoutMs: 10000 });

    return { success: true };
}

/**
 * Stream-download a file from an entity's workspace container to a local path.
 * Uses the GET /download streaming endpoint instead of base64-in-JSON.
 *
 * @param {string} entityId - Entity UUID
 * @param {string} remotePath - Path inside the container
 * @param {string} localPath - Destination path on Cortex host
 * @returns {Promise<{success: boolean, bytesWritten?: number, error?: string}>}
 */
export async function workspaceDownloadToFile(entityId, remotePath, localPath) {
    const entityConfig = await loadEntityConfig(entityId);
    if (!entityConfig?.workspace?.url) {
        return { success: false, error: 'Workspace not configured' };
    }

    const { url, secret } = entityConfig.workspace;
    const endpoint = `${url}/download?path=${encodeURIComponent(remotePath)}`;

    const response = await fetch(endpoint, {
        headers: { 'x-workspace-secret': secret },
        signal: AbortSignal.timeout(300000), // 5-minute timeout
    });

    if (!response.ok) {
        let errMsg;
        try { errMsg = (await response.json()).error; } catch { errMsg = response.statusText; }
        return { success: false, error: errMsg || `Download failed: ${response.status}` };
    }

    const nodeStream = Readable.fromWeb(response.body);
    const ws = fs.createWriteStream(localPath);
    await pipeline(nodeStream, ws);

    const stat = fs.statSync(localPath);
    return { success: true, bytesWritten: stat.size };
}

/**
 * Stream-upload a local file to an entity's workspace container.
 * Uses the POST /upload streaming endpoint instead of base64-in-JSON.
 *
 * @param {string} entityId - Entity UUID
 * @param {string} localPath - Source path on Cortex host
 * @param {string} remotePath - Destination path inside the container
 * @returns {Promise<{success: boolean, bytesWritten?: number, error?: string}>}
 */
export async function workspaceUploadFile(entityId, localPath, remotePath) {
    const entityConfig = await loadEntityConfig(entityId);
    if (!entityConfig?.workspace?.url) {
        return { success: false, error: 'Workspace not configured' };
    }

    const { url, secret } = entityConfig.workspace;
    const endpoint = `${url}/upload?path=${encodeURIComponent(remotePath)}`;

    const fileStream = fs.createReadStream(localPath);
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'x-workspace-secret': secret,
            'Content-Type': 'application/octet-stream',
        },
        body: Readable.toWeb(fileStream),
        duplex: 'half',
        signal: AbortSignal.timeout(300000), // 5-minute timeout
    });

    if (!response.ok) {
        let errMsg;
        try { errMsg = (await response.json()).error; } catch { errMsg = response.statusText; }
        return { success: false, error: errMsg || `Upload failed: ${response.status}` };
    }

    const result = await response.json();
    return { success: true, bytesWritten: result.bytesWritten };
}

// ---------------------------------------------------------------------------
// Idle workspace reaper — runs every 5 minutes at module scope
// ---------------------------------------------------------------------------
const REAPER_INTERVAL_MS = 5 * 60 * 1000;

async function reapIdleWorkspaces() {
    const idleTimeoutMs = config.get('workspaceIdleTimeoutMs');
    if (!idleTimeoutMs) return; // disabled when set to 0

    const now = Date.now();

    for (const [entityId, lastTs] of lastActivity) {
        if (now - lastTs < idleTimeoutMs) continue;

        try {
            const entityConfig = await loadEntityConfig(entityId);
            if (!entityConfig?.workspace || entityConfig.workspace.status !== 'running') {
                lastActivity.delete(entityId);
                lastFlushedActivity.delete(entityId);
                continue;
            }

            await stopWorkspace(entityId, entityConfig);
            lastActivity.delete(entityId);
            lastFlushedActivity.delete(entityId);
            logger.info(`Stopped idle workspace for entity ${entityId}`);
        } catch (e) {
            logger.error(`Idle reaper error for entity ${entityId}: ${e.message}`);
        }
    }
}

async function flushActivityToMongo() {
    const entityStore = getEntityStore();

    for (const [entityId, lastTs] of lastActivity) {
        // Skip if unchanged since last flush
        if (lastFlushedActivity.get(entityId) === lastTs) continue;

        try {
            const entityConfig = await loadEntityConfig(entityId);
            if (!entityConfig?.workspace) continue;

            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: { ...entityConfig.workspace, lastActivity: lastTs },
            });
            lastFlushedActivity.set(entityId, lastTs);
        } catch (e) {
            logger.error(`Failed to flush activity for entity ${entityId}: ${e.message}`);
        }
    }
}

// Combined interval: flush activity timestamps then reap idle workspaces
const _reaperTimer = setInterval(async () => {
    try {
        await flushActivityToMongo();
        await reapIdleWorkspaces();
    } catch (e) {
        logger.error(`Workspace reaper tick failed: ${e.message}`);
    }
}, REAPER_INTERVAL_MS);

// Allow the process to exit cleanly without waiting for the reaper timer
if (_reaperTimer.unref) _reaperTimer.unref();
