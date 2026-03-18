// workspaceAdmin.js
// REST admin endpoints for workspace host pool management.
// Mounted at /admin/workspace-hosts when workspace backend is 'hetzner'.

import { Router } from 'express';
import logger from '../lib/logger.js';
import { config } from '../config.js';
import { getBackend } from '../pathways/system/entity/tools/shared/backends/index.js';

const router = Router();

// All admin endpoints require the Cortex API key
router.use((req, res, next) => {
    const cortexApiKeys = config.get('cortexApiKeys');
    if (!cortexApiKeys || !Array.isArray(cortexApiKeys) || cortexApiKeys.length === 0) {
        // No API key configured — admin endpoints disabled
        return res.status(403).json({ error: 'Admin endpoints require CORTEX_API_KEY configuration' });
    }

    let providedApiKey = req.headers['cortex-api-key'] || req.query['cortex-api-key'];
    if (!providedApiKey) {
        providedApiKey = req.headers['authorization'];
        providedApiKey = providedApiKey?.startsWith('Bearer ') ? providedApiKey.slice(7) : providedApiKey;
    }

    if (!cortexApiKeys.includes(providedApiKey)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
});

/**
 * GET /admin/workspace-hosts
 * List all hosts in the pool with capacity and status.
 */
router.get('/', async (req, res) => {
    try {
        const backend = await getBackend();
        if (backend.backendName !== 'hetzner') {
            return res.json({
                backend: backend.backendName,
                message: 'Host pool management is only available with the hetzner backend',
            });
        }

        const status = await backend.getPoolStatus();
        res.json(status);
    } catch (e) {
        logger.error(`Admin workspace-hosts GET: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /admin/workspace-hosts
 * Add a Docker host to the pool.
 *
 * Body: { ip: string, dockerPort?: number, maxContainers?: number, hetznerServerId?: number }
 */
router.post('/', async (req, res) => {
    try {
        const backend = await getBackend();
        if (!backend.addHost) {
            return res.status(400).json({ error: 'Host management not supported on this backend' });
        }

        const { ip, dockerPort, maxContainers, hetznerServerId } = req.body;
        if (!ip) {
            return res.status(400).json({ error: 'ip is required' });
        }

        const host = await backend.addHost({ ip, dockerPort, maxContainers, hetznerServerId });
        res.status(201).json(host);
    } catch (e) {
        logger.error(`Admin workspace-hosts POST: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /admin/workspace-hosts/provision
 * Provision a new Hetzner VM as a Docker host.
 */
router.post('/provision', async (req, res) => {
    try {
        const backend = await getBackend();
        if (!backend._provisionHost) {
            return res.status(400).json({ error: 'Auto-provisioning not supported on this backend' });
        }

        const host = await backend._provisionHost();
        res.status(201).json(host);
    } catch (e) {
        logger.error(`Admin workspace-hosts provision: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

/**
 * DELETE /admin/workspace-hosts/:hostId
 * Remove a host from the pool.
 *
 * Query params: deleteServer=true — also delete the Hetzner VM
 */
router.delete('/:hostId', async (req, res) => {
    try {
        const backend = await getBackend();
        if (!backend.removeHostFromPool) {
            return res.status(400).json({ error: 'Host management not supported on this backend' });
        }

        const { hostId } = req.params;
        const deleteServer = req.query.deleteServer === 'true';

        await backend.removeHostFromPool(hostId, deleteServer);
        res.json({ success: true, message: `Host ${hostId} removed${deleteServer ? ' (VM deleted)' : ''}` });
    } catch (e) {
        logger.error(`Admin workspace-hosts DELETE: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /admin/workspace-hosts/health-check
 * Trigger an immediate health check of all hosts.
 */
router.post('/health-check', async (req, res) => {
    try {
        const backend = await getBackend();
        if (!backend.checkHostHealth) {
            return res.status(400).json({ error: 'Health checks not supported on this backend' });
        }

        await backend.checkHostHealth();
        await backend.reconcileContainerCounts();

        const status = await backend.getPoolStatus();
        res.json({ success: true, ...status });
    } catch (e) {
        logger.error(`Admin workspace-hosts health-check: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

export default router;
