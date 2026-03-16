// HetznerBackend.js
// Multi-tenant Docker host pool on Hetzner Cloud.
//
// Architecture:
//   Cortex ──private network──> docker-host-1 (CX42) ──> N workspace containers
//                             > docker-host-2 (CX42) ──> N workspace containers
//                             > docker-host-N ...
//
// Each Docker host is a Hetzner VM running Docker, exposed on a private network.
// Workspace containers are created on hosts via Docker TCP API.
// When all hosts are >80% full, a new host is auto-provisioned via Hetzner API.
// When a host has 0 containers and others have capacity, it's auto-removed.

import http from 'node:http';
import net from 'node:net';
import { config } from '../../../../../../config.js';
import logger from '../../../../../../lib/logger.js';
import ContainerBackend from './ContainerBackend.js';
import HetznerClient from '../../../../../../lib/hetzner/HetznerClient.js';
import HostRegistry from '../../../../../../lib/hetzner/HostRegistry.js';

// Label used to identify workspace host VMs in Hetzner
const HOST_LABEL = 'role=workspace-host';

/**
 * Cloud-init template for new Docker hosts.
 * Installs Docker, configures it to listen on TCP for the private network,
 * and pulls the workspace image.
 */
function buildCloudInit({ workspaceImage, dockerPort = 2376 }) {
    return `#cloud-config
package_update: true
packages:
  - docker.io
  - curl

runcmd:
  - systemctl enable docker
  - systemctl start docker
  # Expose Docker daemon on all interfaces (secured by Hetzner firewall + private network)
  - mkdir -p /etc/systemd/system/docker.service.d
  - |
    cat > /etc/systemd/system/docker.service.d/override.conf <<DEOF
    [Service]
    ExecStart=
    ExecStart=/usr/bin/dockerd -H unix:///var/run/docker.sock -H tcp://0.0.0.0:${dockerPort}
    DEOF
  - systemctl daemon-reload
  - systemctl restart docker
  # Auto-mount any attached Hetzner Volumes
  - |
    for dev in /dev/disk/by-id/scsi-0HC_Volume_*; do
      if [ -b "$dev" ]; then
        vol_name=$(basename "$dev" | sed 's/scsi-0HC_Volume_//')
        mkdir -p "/mnt/volumes/\${vol_name}"
        # Format only if no filesystem exists
        blkid "$dev" >/dev/null 2>&1 || mkfs.ext4 -q "$dev"
        mount "$dev" "/mnt/volumes/\${vol_name}" 2>/dev/null || true
      fi
    done
  # Pull workspace image so first container starts fast
  - docker pull ${workspaceImage} || true
  # Signal readiness
  - touch /tmp/docker-host-ready
`;
}

export default class HetznerBackend extends ContainerBackend {
    constructor() {
        super();
        const apiToken = config.get('hetznerApiToken');
        if (!apiToken) {
            throw new Error('HETZNER_API_TOKEN is required for hetzner backend');
        }
        this._hetzner = new HetznerClient(apiToken);
        this._registry = new HostRegistry();
        this._dockerPort = 2376;
        this._maxContainersPerHost = parseInt(config.get('hetznerMaxContainersPerHost')) || 50;
        this._scaleUpThreshold = parseFloat(config.get('hetznerScaleUpThreshold')) || 0.8;
        this._initialized = false;
    }

    get backendName() {
        return 'hetzner';
    }

    get healthTimeoutMs() {
        return 60000; // 60s — remote hosts may be slower than local Docker
    }

    get wakeHealthTimeoutMs() {
        return 30000;
    }

    /**
     * One-time initialization: discover existing Hetzner workspace hosts
     * and sync them into the registry.
     */
    async _ensureInitialized() {
        if (this._initialized) return;
        this._initialized = true;

        try {
            const servers = await this._hetzner.listServers(HOST_LABEL);
            for (const server of servers) {
                const ip = server.privateIp || server.publicIp;
                if (!ip) continue;

                const existing = await this._registry.getHost(server.name);
                if (!existing) {
                    await this._registry.upsertHost({
                        id: server.name,
                        ip,
                        dockerPort: this._dockerPort,
                        maxContainers: this._maxContainersPerHost,
                        currentContainers: 0, // will be reconciled on next health check
                        status: server.status === 'running' ? 'active' : 'offline',
                        hetznerServerId: server.id,
                        serverType: server.serverType,
                        createdAt: Date.now(),
                    });
                    logger.info(`[HetznerBackend] Discovered existing host: ${server.name} (${ip})`);
                }
            }
        } catch (e) {
            logger.warn(`[HetznerBackend] Failed to discover existing hosts: ${e.message}`);
        }
    }

    /**
     * Make a Docker API request to a specific host via TCP.
     */
    _dockerApi(host, method, path, body = null) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;

            const req = http.request({
                hostname: host.ip,
                port: host.dockerPort || this._dockerPort,
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
                        reject(new Error(`Docker@${host.id} ${method} ${path}: ${res.statusCode} ${data}`));
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

            req.on('error', (e) => reject(new Error(`Docker@${host.id} ${method} ${path}: ${e.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error(`Docker@${host.id} ${method} ${path}: timeout`)); });

            if (payload) req.write(payload);
            req.end();
        });
    }

    /**
     * Provision a new Hetzner VM as a Docker host.
     * @returns {Promise<import('../../../../../../lib/hetzner/HostRegistry.js').HostEntry>}
     */
    async _provisionHost() {
        const location = config.get('hetznerLocation');
        const serverType = config.get('hetznerServerType');
        const firewallId = config.get('hetznerFirewallId');
        const sshKeyId = config.get('hetznerSshKeyId');
        const networkId = config.get('hetznerPrivateNetworkId');
        const image = config.get('workspaceImage');
        const imageVersion = config.get('workspaceImageVersion');
        const fullImage = imageVersion ? `${image}:${imageVersion}` : `${image}:latest`;

        const hostName = `workspace-host-${Date.now().toString(36)}`;
        logger.info(`[HetznerBackend] Provisioning new host: ${hostName} (${serverType} in ${location})`);

        const hostEntry = {
            id: hostName,
            ip: '',
            dockerPort: this._dockerPort,
            maxContainers: this._maxContainersPerHost,
            currentContainers: 0,
            status: 'provisioning',
            serverType,
            createdAt: Date.now(),
        };
        await this._registry.upsertHost(hostEntry);

        try {
            const server = await this._hetzner.createServer({
                name: hostName,
                serverType,
                location,
                userData: buildCloudInit({ workspaceImage: fullImage, dockerPort: this._dockerPort }),
                firewalls: firewallId ? [parseInt(firewallId)] : [],
                sshKeys: sshKeyId ? [parseInt(sshKeyId)] : [],
                networks: networkId ? [parseInt(networkId)] : [],
                labels: { role: 'workspace-host' },
            });

            // Wait for the server to get an IP
            let ip = server.privateIp || server.publicIp;
            if (!ip) {
                // Poll for IP assignment (private network IPs may take a moment)
                for (let i = 0; i < 30 && !ip; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    const updated = await this._hetzner.getServer(server.id);
                    ip = updated.privateIp || updated.publicIp;
                }
            }

            if (!ip) {
                throw new Error('Server created but no IP assigned');
            }

            // Wait for Docker to be ready (cloud-init takes ~60-90s)
            const dockerReady = await this._waitForDocker(ip, this._dockerPort, 180000);
            if (!dockerReady) {
                throw new Error('Docker daemon not responding after 3 minutes');
            }

            hostEntry.ip = ip;
            hostEntry.status = 'active';
            hostEntry.hetznerServerId = server.id;
            await this._registry.upsertHost(hostEntry);

            logger.info(`[HetznerBackend] Host ${hostName} ready at ${ip}`);
            return hostEntry;
        } catch (e) {
            hostEntry.status = 'offline';
            await this._registry.upsertHost(hostEntry);
            throw e;
        }
    }

    /**
     * Poll a remote Docker daemon until it responds.
     */
    async _waitForDocker(ip, port, maxWaitMs) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            try {
                await new Promise((resolve, reject) => {
                    const req = http.request({
                        hostname: ip,
                        port,
                        path: '/_ping',
                        method: 'GET',
                        timeout: 5000,
                    }, (res) => {
                        let data = '';
                        res.on('data', chunk => { data += chunk; });
                        res.on('end', () => resolve(data));
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                    req.end();
                });
                return true;
            } catch {
                // Not ready yet
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        return false;
    }

    /**
     * Resolve a host for a new container. Auto-scales if needed.
     * @returns {Promise<import('../../../../../../lib/hetzner/HostRegistry.js').HostEntry>}
     */
    async _resolveHost() {
        await this._ensureInitialized();

        // Try to find an existing host with capacity
        const host = await this._registry.pickHost();
        if (host) return host;

        // No capacity — provision a new host
        logger.info('[HetznerBackend] No hosts with capacity — auto-scaling up');
        return await this._provisionHost();
    }

    async createAndStart({ containerName, image, env, cpus, memoryMB, diskSize, shareName, hetznerVolumeId }) {
        const host = await this._resolveHost();
        const volumeSize = parseInt(config.get('workspaceDiskSize')) || 10;

        logger.info(`[HetznerBackend] Creating ${containerName} on host ${host.id} (${host.ip})`);

        // Remove existing container if it exists (for re-provisioning)
        try {
            await this._dockerApi(host, 'DELETE', `/containers/${containerName}?force=true`);
        } catch {
            // Doesn't exist, fine
        }

        // --- Hetzner Volume: create or reuse persistent block storage ---
        let volumeId = hetznerVolumeId || null;
        let volumeMountPath = null;

        try {
            if (!volumeId) {
                // Create a new Hetzner Volume
                const vol = await this._hetzner.createVolume({
                    name: `ws-${shareName || containerName}`,
                    size: volumeSize,
                    location: config.get('hetznerLocation'),
                    serverId: host.hetznerServerId,
                });
                volumeId = vol.id;
                logger.info(`[HetznerBackend] Created Hetzner Volume ${volumeId} for ${containerName}`);
                // Wait for attachment
                await new Promise(r => setTimeout(r, 5000));
            } else {
                // Reuse existing volume — may need to detach from old host and reattach
                try {
                    await this._hetzner.detachVolume(volumeId);
                    await new Promise(r => setTimeout(r, 3000));
                } catch {
                    // May not be attached, that's fine
                }
                await this._hetzner.attachVolume(volumeId, host.hetznerServerId);
                await new Promise(r => setTimeout(r, 5000));
                logger.info(`[HetznerBackend] Reattached Hetzner Volume ${volumeId} to host ${host.id}`);
            }

            // Mount the volume on the host via a privileged helper container.
            // Hetzner Volumes appear as /dev/disk/by-id/scsi-0HC_Volume_{id}
            volumeMountPath = `/mnt/volumes/${volumeId}`;
            const mountScript = [
                `mkdir -p ${volumeMountPath}`,
                `DEV=/dev/disk/by-id/scsi-0HC_Volume_${volumeId}`,
                // Format only if no filesystem exists
                `blkid $DEV >/dev/null 2>&1 || mkfs.ext4 -q $DEV`,
                `mount $DEV ${volumeMountPath} 2>/dev/null || true`,
            ].join(' && ');

            await this._dockerApi(host, 'POST', '/containers/create?name=vol-mount-helper', {
                Image: 'alpine:latest',
                Cmd: ['sh', '-c', mountScript],
                HostConfig: {
                    Privileged: true,
                    Binds: ['/dev:/dev', '/mnt:/mnt'],
                    AutoRemove: true,
                },
            });
            await this._dockerApi(host, 'POST', '/containers/vol-mount-helper/start');
            // Wait for mount to complete
            await new Promise(r => setTimeout(r, 3000));
            try {
                await this._dockerApi(host, 'DELETE', '/containers/vol-mount-helper?force=true');
            } catch { /* auto-removed */ }
        } catch (e) {
            logger.warn(`[HetznerBackend] Volume setup failed for ${containerName}, falling back to Docker named volume: ${e.message}`);
            volumeId = null;
            volumeMountPath = null;
        }

        // Determine the bind mount: Hetzner Volume path if available, else Docker named volume
        const bindSource = volumeMountPath || `${shareName || containerName}-data`;

        const memoryBytes = memoryMB * 1024 * 1024;
        const nanoCpus = Math.round(cpus * 1e9);

        const createBody = {
            Image: image,
            Hostname: containerName,
            Env: env,
            ExposedPorts: { '3100/tcp': {} },
            HostConfig: {
                NanoCpus: nanoCpus,
                Memory: memoryBytes,
                RestartPolicy: { Name: 'unless-stopped' },
                Binds: [`${bindSource}:/workspace`],
                PortBindings: { '3100/tcp': [{ HostPort: '0' }] },
            },
        };

        const createRes = await this._dockerApi(host, 'POST', `/containers/create?name=${containerName}`, createBody);
        const containerId = createRes.Id;

        await this._dockerApi(host, 'POST', `/containers/${containerId}/start`);

        // Get the assigned host port
        const info = await this._dockerApi(host, 'GET', `/containers/${containerId}/json`);
        const bindings = info.NetworkSettings?.Ports?.['3100/tcp'];
        const assignedPort = bindings?.[0]?.HostPort;
        if (!assignedPort) {
            throw new Error('Docker did not assign a host port for workspace container');
        }

        const url = `http://${host.ip}:${assignedPort}`;

        // Track container -> host mapping
        await this._registry.setContainerHost(containerName, host.id);
        await this._registry.adjustContainerCount(host.id, 1);

        // Check if we should pre-scale (background, don't block)
        this._checkScaleUp().catch(e => logger.warn(`[HetznerBackend] Scale-up check failed: ${e.message}`));

        return { containerId, url, hetznerVolumeId: volumeId };
    }

    async start(containerId, containerName) {
        const host = await this._findHostForContainer(containerName);
        await this._dockerApi(host, 'POST', `/containers/${containerId}/start`);
    }

    async stop(containerId, containerName) {
        const host = await this._findHostForContainer(containerName);
        await this._dockerApi(host, 'POST', `/containers/${containerId}/stop?t=10`);
    }

    async remove(containerId, containerName) {
        const host = await this._findHostForContainer(containerName);

        try {
            await this._dockerApi(host, 'POST', `/containers/${containerName}/stop?t=10`);
        } catch {
            // May already be stopped
        }
        try {
            await this._dockerApi(host, 'DELETE', `/containers/${containerName}?force=true`);
        } catch {
            // May already be removed
        }

        await this._registry.removeContainer(containerName);
        await this._registry.adjustContainerCount(host.id, -1);

        // Check if host is now empty and can be removed (background)
        this._checkScaleDown(host.id).catch(e => logger.warn(`[HetznerBackend] Scale-down check failed: ${e.message}`));
    }

    async destroyVolume(shareName, hetznerVolumeId) {
        // If we have a Hetzner Volume ID, detach and delete it
        if (hetznerVolumeId) {
            try {
                await this._hetzner.detachVolume(hetznerVolumeId);
                await new Promise(r => setTimeout(r, 3000));
            } catch {
                // May not be attached
            }
            try {
                await this._hetzner.deleteVolume(hetznerVolumeId);
                logger.info(`[HetznerBackend] Deleted Hetzner Volume ${hetznerVolumeId}`);
            } catch (e) {
                logger.warn(`[HetznerBackend] Failed to delete Hetzner Volume ${hetznerVolumeId}: ${e.message}`);
            }
            return;
        }

        // Fallback: try to delete Docker named volumes across hosts
        const hosts = await this._registry.getAllHosts();
        const volumeName = `${shareName}-data`;

        for (const host of hosts) {
            if (host.status === 'offline') continue;
            try {
                await this._dockerApi(host, 'DELETE', `/volumes/${volumeName}`);
                return;
            } catch {
                // Volume not on this host, try next
            }
        }
    }

    /**
     * Find which host a container is running on.
     * @param {string} containerName
     * @returns {Promise<import('../../../../../../lib/hetzner/HostRegistry.js').HostEntry>}
     */
    async _findHostForContainer(containerName) {
        const hostId = await this._registry.getContainerHost(containerName);
        if (hostId) {
            const host = await this._registry.getHost(hostId);
            if (host) return host;
        }

        // Fallback: search all hosts for this container
        const hosts = await this._registry.getActiveHosts();
        for (const host of hosts) {
            try {
                await this._dockerApi(host, 'GET', `/containers/${containerName}/json`);
                // Found it — update registry
                await this._registry.setContainerHost(containerName, host.id);
                return host;
            } catch {
                // Not on this host
            }
        }

        throw new Error(`Container ${containerName} not found on any host`);
    }

    /**
     * Pre-scale: if pool is above threshold, provision a new host in background.
     */
    async _checkScaleUp() {
        const isFull = await this._registry.isPoolFull(this._scaleUpThreshold);
        if (isFull) {
            logger.info('[HetznerBackend] Pool above threshold — pre-scaling');
            // Don't await — let it provision in background
            this._provisionHost().catch(e =>
                logger.error(`[HetznerBackend] Auto-scale up failed: ${e.message}`)
            );
        }
    }

    /**
     * Check if a host is empty and can be decommissioned.
     * Only removes if other hosts have capacity to absorb workload.
     */
    async _checkScaleDown(hostId) {
        const host = await this._registry.getHost(hostId);
        if (!host || host.currentContainers > 0) return;

        // Don't remove the last host
        const activeHosts = await this._registry.getActiveHosts();
        if (activeHosts.length <= 1) return;

        // Verify no containers remain (registry might be stale)
        const containers = await this._registry.getContainersOnHost(hostId);
        if (containers.length > 0) return;

        logger.info(`[HetznerBackend] Host ${hostId} is empty — decommissioning`);

        // Mark as draining first (no new placements)
        host.status = 'draining';
        await this._registry.upsertHost(host);

        // Delete the Hetzner VM
        if (host.hetznerServerId) {
            try {
                await this._hetzner.deleteServer(host.hetznerServerId);
            } catch (e) {
                logger.error(`[HetznerBackend] Failed to delete Hetzner server ${host.hetznerServerId}: ${e.message}`);
                return;
            }
        }

        // Remove from registry
        await this._registry.removeHost(hostId);
        logger.info(`[HetznerBackend] Host ${hostId} decommissioned`);
    }

    // -----------------------------------------------------------------------
    // Host health monitoring — call from workspace reaper interval
    // -----------------------------------------------------------------------

    /**
     * Check health of all registered hosts.
     * Marks unreachable hosts as offline after 3 consecutive failures.
     */
    async checkHostHealth() {
        const hosts = await this._registry.getAllHosts();

        for (const host of hosts) {
            if (host.status === 'provisioning' || host.status === 'draining') continue;

            try {
                await this._dockerApi(host, 'GET', '/_ping');
                if (host.status === 'offline') {
                    host.status = 'active';
                    await this._registry.upsertHost(host);
                    logger.info(`[HetznerBackend] Host ${host.id} back online`);
                }
                await this._registry.recordHealthCheck(host.id);
            } catch {
                if (host.status === 'active') {
                    host._failCount = (host._failCount || 0) + 1;
                    if (host._failCount >= 3) {
                        host.status = 'offline';
                        logger.warn(`[HetznerBackend] Host ${host.id} marked offline (3 consecutive failures)`);
                    }
                    await this._registry.upsertHost(host);
                }
            }
        }
    }

    /**
     * Reconcile container counts by querying each host's Docker daemon.
     * Corrects drift between registry and reality.
     */
    async reconcileContainerCounts() {
        const hosts = await this._registry.getActiveHosts();

        for (const host of hosts) {
            try {
                const data = await this._dockerApi(host, 'GET',
                    '/containers/json?filters=' + encodeURIComponent(JSON.stringify({
                        name: ['workspace-'],
                    }))
                );
                const count = Array.isArray(data) ? data.length : 0;
                if (count !== host.currentContainers) {
                    logger.info(`[HetznerBackend] Reconciled ${host.id}: ${host.currentContainers} -> ${count} containers`);
                    host.currentContainers = count;
                    await this._registry.upsertHost(host);
                }
            } catch (e) {
                logger.warn(`[HetznerBackend] Failed to reconcile ${host.id}: ${e.message}`);
            }
        }
    }

    /**
     * Get pool status (for admin API).
     */
    async getPoolStatus() {
        return await this._registry.getPoolStatus();
    }

    /**
     * Manually add an existing Docker host to the pool.
     * @param {Object} opts
     * @param {string} opts.ip - IP address
     * @param {number} [opts.dockerPort] - Docker port (default 2376)
     * @param {number} [opts.maxContainers] - Max containers (default from config)
     * @param {number} [opts.hetznerServerId] - Optional Hetzner server ID
     * @returns {Promise<import('../../../../../../lib/hetzner/HostRegistry.js').HostEntry>}
     */
    async addHost(opts) {
        const hostName = `host-${opts.ip.replace(/\./g, '-')}`;
        const host = {
            id: hostName,
            ip: opts.ip,
            dockerPort: opts.dockerPort || this._dockerPort,
            maxContainers: opts.maxContainers || this._maxContainersPerHost,
            currentContainers: 0,
            status: 'active',
            hetznerServerId: opts.hetznerServerId || null,
            createdAt: Date.now(),
        };

        // Verify Docker is reachable
        try {
            await this._dockerApi(host, 'GET', '/_ping');
        } catch (e) {
            throw new Error(`Cannot reach Docker at ${opts.ip}:${host.dockerPort}: ${e.message}`);
        }

        await this._registry.upsertHost(host);
        logger.info(`[HetznerBackend] Added host ${hostName} (${opts.ip})`);
        return host;
    }

    /**
     * Manually drain and remove a host from the pool.
     * @param {string} hostId
     * @param {boolean} [deleteServer=false] - Also delete the Hetzner VM
     */
    async removeHostFromPool(hostId, deleteServer = false) {
        const host = await this._registry.getHost(hostId);
        if (!host) throw new Error(`Host ${hostId} not found`);

        // Mark as draining
        host.status = 'draining';
        await this._registry.upsertHost(host);

        // Optionally delete the Hetzner VM
        if (deleteServer && host.hetznerServerId) {
            await this._hetzner.deleteServer(host.hetznerServerId);
        }

        await this._registry.removeHost(hostId);
        logger.info(`[HetznerBackend] Removed host ${hostId}${deleteServer ? ' (VM deleted)' : ''}`);
    }
}
