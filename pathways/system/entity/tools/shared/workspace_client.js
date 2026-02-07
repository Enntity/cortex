// workspace_client.js
// Shared module for workspace tools: HTTP client, auto-provisioning, Docker API
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import logger from '../../../../../lib/logger.js';
import { config } from '../../../../../config.js';
import { decrypt } from '../../../../../lib/crypto.js';
import { loadEntityConfig } from './sys_entity_tools.js';
import { getEntityStore } from '../../../../../lib/MongoEntityStore.js';

// Detect if Cortex is running inside Docker (production) or on the host (local dev)
const isInDocker = fs.existsSync('/.dockerenv');

// Find Docker socket — different location on macOS Docker Desktop vs Linux
const DOCKER_SOCKET = [
    '/var/run/docker.sock',
    `${process.env.HOME}/.docker/run/docker.sock`,
].find(p => fs.existsSync(p)) || '/var/run/docker.sock';

// In-memory lock to prevent concurrent provisioning for the same entity
const provisioningLocks = new Map();

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

        if (response.status === 401) {
            return { success: false, error: 'Authentication failed. Workspace may need reprovisioning.' };
        }

        const data = await response.json();

        if (data.error) {
            return { success: false, error: data.error };
        }

        return { success: true, ...data };
    } catch (e) {
        // On connection failure, mark workspace as error for auto-recovery on next call
        if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.cause?.code === 'ECONNREFUSED') {
            try {
                const entityStore = getEntityStore();
                await entityStore.upsertEntity({
                    ...entityConfig,
                    workspace: { ...entityConfig.workspace, status: 'error' },
                });
            } catch (updateErr) {
                logger.error(`Failed to mark workspace as error: ${updateErr.message}`);
            }
            return { success: false, error: 'Workspace not reachable. May be stopped or restarting.' };
        }

        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
            return { success: false, error: `Request timed out after ${Math.round(timeoutMs / 1000)}s` };
        }

        logger.error(`Workspace request failed for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Workspace request failed: ${e.message}` };
    }
}

/**
 * Provision a workspace container for an entity via Docker Engine API.
 * Uses /var/run/docker.sock for Docker daemon communication.
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

async function _doProvision(entityId, entityConfig) {
    const shortId = entityId.slice(0, 8);
    const containerName = `workspace-${shortId}`;
    const secret = crypto.randomBytes(32).toString('hex');
    const image = config.get('workspaceImage');
    const network = config.get('workspaceNetwork');
    const cpus = config.get('workspaceCpus');
    const memory = config.get('workspaceMemory');
    const diskSize = config.get('workspaceDiskSize');
    const volumeName = `workspace-${shortId}-data`;

    logger.info(`Provisioning workspace for entity ${entityId} (${containerName})${isInDocker ? '' : ' [local dev mode]'}`);

    try {
        // Update entity status to provisioning
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: {
                ...(entityConfig.workspace || {}),
                status: 'provisioning',
            },
        });

        // Remove existing container if it exists (for re-provisioning)
        try {
            await dockerApi('DELETE', `/containers/${containerName}?force=true`);
        } catch {
            // Container doesn't exist, that's fine
        }

        // Parse memory limit to bytes for Docker API
        const memoryBytes = parseMemoryLimit(memory);
        const nanoCpus = Math.round(parseFloat(cpus) * 1e9);

        // In local dev (Cortex on host), map a random port so the host can reach the container.
        // In production (Cortex in Docker), use Docker internal DNS on the shared network.
        let hostPort = null;
        if (!isInDocker) {
            hostPort = await findFreePort();
        }

        // Build environment variables
        const Env = [
            `WORKSPACE_SECRET=${secret}`,
            `PORT=3100`,
        ];

        // Inject entity secrets as env vars
        const plainSecrets = {};
        if (entityConfig.secrets) {
            const systemKey = config.get('redisEncryptionKey');
            for (const [key, encVal] of Object.entries(entityConfig.secrets)) {
                const val = decrypt(encVal, systemKey);
                if (val) {
                    Env.push(`${key}=${val}`);
                    plainSecrets[key] = val;
                }
            }
        }

        // Create container
        const createBody = {
            Image: image,
            Hostname: containerName,
            Env,
            ExposedPorts: { '3100/tcp': {} },
            HostConfig: {
                NanoCpus: nanoCpus,
                Memory: memoryBytes,
                StorageOpt: { size: diskSize },
                RestartPolicy: { Name: 'unless-stopped' },
                Binds: [`${volumeName}:/workspace`],
                ...(hostPort ? { PortBindings: { '3100/tcp': [{ HostPort: String(hostPort) }] } } : {}),
            },
            ...(isInDocker ? {
                NetworkingConfig: {
                    EndpointsConfig: {
                        [network]: {},
                    },
                },
            } : {}),
        };

        const createRes = await dockerApi('POST', `/containers/create?name=${containerName}`, createBody);
        const containerId = createRes.Id;

        // Start container
        await dockerApi('POST', `/containers/${containerId}/start`);

        // In Docker: reach container by hostname on shared network
        // On host: reach container via localhost:{mapped port}
        const containerUrl = isInDocker
            ? `http://${containerName}:3100`
            : `http://localhost:${hostPort}`;

        const healthOk = await waitForHealth(containerUrl, 30000);

        if (!healthOk) {
            throw new Error('Workspace container failed to become healthy');
        }

        // Update entity with workspace info
        const workspaceConfig = {
            url: containerUrl,
            secret,
            status: 'running',
            containerId,
            provisionedAt: new Date(),
        };

        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: workspaceConfig,
        });

        // Sync secrets to .env file in workspace (best-effort)
        if (Object.keys(plainSecrets).length > 0) {
            syncSecretsToWorkspace(entityId, plainSecrets).catch(err =>
                logger.warn(`Failed to sync secrets .env for ${entityId}: ${err.message}`)
            );
        }

        logger.info(`Workspace provisioned for entity ${entityId}: ${containerUrl}`);
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
 * Stop and remove a workspace container.
 */
export async function destroyWorkspace(entityId, entityConfig, options = {}) {
    const { destroyVolume = false } = options;
    const shortId = entityId.slice(0, 8);
    const containerName = `workspace-${shortId}`;
    const volumeName = `workspace-${shortId}-data`;

    try {
        // Stop and remove container
        try {
            await dockerApi('POST', `/containers/${containerName}/stop?t=10`);
        } catch {
            // May already be stopped
        }

        try {
            await dockerApi('DELETE', `/containers/${containerName}?force=true`);
        } catch {
            // May already be removed
        }

        if (destroyVolume) {
            try {
                await dockerApi('DELETE', `/volumes/${volumeName}`);
            } catch {
                // Volume may not exist
            }
        }

        // Clear workspace from entity
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: null,
        });

        logger.info(`Workspace destroyed for entity ${entityId}`);
        return { success: true, message: `Workspace destroyed${destroyVolume ? ' (volume removed)' : ' (volume preserved)'}` };
    } catch (e) {
        logger.error(`Failed to destroy workspace for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Destroy failed: ${e.message}` };
    }
}

/**
 * Make a Docker Engine API request via Unix socket.
 * Uses Node's built-in http module with socketPath (no external deps).
 */
function dockerApi(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;

        const req = http.request({
            socketPath: DOCKER_SOCKET,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`Docker API ${method} ${path}: ${res.statusCode} ${data}`));
                    return;
                }
                if (res.statusCode === 204 || !data) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve({});
                }
            });
        });

        req.on('error', (e) => reject(new Error(`Docker API ${method} ${path}: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error(`Docker API ${method} ${path}: timeout`)); });

        if (payload) req.write(payload);
        req.end();
    });
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
 * Parse memory limit string (e.g. '512m', '1g') to bytes.
 */
function parseMemoryLimit(str) {
    const match = str.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/);
    if (!match) return 512 * 1024 * 1024; // default 512MB

    const num = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
        case 'k': return Math.round(num * 1024);
        case 'm': return Math.round(num * 1024 * 1024);
        case 'g': return Math.round(num * 1024 * 1024 * 1024);
        default: return Math.round(num);
    }
}

/**
 * Find a free port on the host for local dev port mapping.
 */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
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
    // Write .env with export prefix so sourcing it exports to the environment
    const envContent = Object.entries(secrets)
        .map(([k, v]) => `export ${k}=${v}`)
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
