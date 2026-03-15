// HostRegistry.js
// Redis-backed registry of Docker host VMs for workspace container placement.
//
// Redis keys:
//   {prefix}:hosts          — hash of hostId -> JSON host metadata
//   {prefix}:containers     — hash of containerName -> hostId
//   {prefix}:health         — hash of hostId -> last health check timestamp

import logger from '../logger.js';
import { getClient } from '../encryptedRedisClient.js';

const KEY_PREFIX = 'workspace-pool';

/**
 * @typedef {Object} HostEntry
 * @property {string} id - Host identifier (e.g. 'host-1')
 * @property {string} ip - IP address to reach Docker daemon
 * @property {number} dockerPort - Docker daemon port (default 2376)
 * @property {number} maxContainers - Max containers this host can run
 * @property {number} currentContainers - Current container count
 * @property {string} status - 'active' | 'draining' | 'offline' | 'provisioning'
 * @property {number} [hetznerServerId] - Hetzner Cloud server ID
 * @property {string} [serverType] - e.g. 'cx42'
 * @property {number} createdAt - Epoch ms
 * @property {number} [lastHealthCheck] - Epoch ms
 */

export default class HostRegistry {
    constructor() {
        this._prefix = KEY_PREFIX;
    }

    _hostsKey() { return `${this._prefix}:hosts`; }
    _containersKey() { return `${this._prefix}:containers`; }
    _healthKey() { return `${this._prefix}:health`; }

    /**
     * Register a new host or update an existing one.
     * @param {HostEntry} host
     */
    async upsertHost(host) {
        const redis = getClient();
        if (!redis) throw new Error('Redis not available');
        await redis.hSet(this._hostsKey(), host.id, JSON.stringify(host));
    }

    /**
     * Get a host by ID.
     * @param {string} hostId
     * @returns {Promise<HostEntry|null>}
     */
    async getHost(hostId) {
        const redis = getClient();
        if (!redis) return null;
        const raw = await redis.hGet(this._hostsKey(), hostId);
        return raw ? JSON.parse(raw) : null;
    }

    /**
     * Get all registered hosts.
     * @returns {Promise<HostEntry[]>}
     */
    async getAllHosts() {
        const redis = getClient();
        if (!redis) return [];
        const all = await redis.hGetAll(this._hostsKey());
        return Object.values(all).map(raw => JSON.parse(raw));
    }

    /**
     * Get all active hosts sorted by available capacity (most free first).
     * @returns {Promise<HostEntry[]>}
     */
    async getActiveHosts() {
        const hosts = await this.getAllHosts();
        return hosts
            .filter(h => h.status === 'active')
            .sort((a, b) => (a.currentContainers / a.maxContainers) - (b.currentContainers / b.maxContainers));
    }

    /**
     * Pick the best host for a new container (most free capacity).
     * Returns null if no host has capacity.
     * @returns {Promise<HostEntry|null>}
     */
    async pickHost() {
        const hosts = await this.getActiveHosts();
        for (const host of hosts) {
            if (host.currentContainers < host.maxContainers) {
                return host;
            }
        }
        return null;
    }

    /**
     * Check if all active hosts are above the given utilization threshold.
     * @param {number} threshold - 0.0 to 1.0 (e.g. 0.8 = 80%)
     * @returns {Promise<boolean>}
     */
    async isPoolFull(threshold = 0.8) {
        const hosts = await this.getActiveHosts();
        if (hosts.length === 0) return true;
        return hosts.every(h => (h.currentContainers / h.maxContainers) >= threshold);
    }

    /**
     * Remove a host from the registry.
     * @param {string} hostId
     */
    async removeHost(hostId) {
        const redis = getClient();
        if (!redis) return;
        await redis.hDel(this._hostsKey(), hostId);
        await redis.hDel(this._healthKey(), hostId);
    }

    /**
     * Record which host a container is running on.
     * @param {string} containerName
     * @param {string} hostId
     */
    async setContainerHost(containerName, hostId) {
        const redis = getClient();
        if (!redis) return;
        await redis.hSet(this._containersKey(), containerName, hostId);
    }

    /**
     * Look up which host a container is running on.
     * @param {string} containerName
     * @returns {Promise<string|null>} hostId or null
     */
    async getContainerHost(containerName) {
        const redis = getClient();
        if (!redis) return null;
        return await redis.hGet(this._containersKey(), containerName);
    }

    /**
     * Remove a container mapping.
     * @param {string} containerName
     */
    async removeContainer(containerName) {
        const redis = getClient();
        if (!redis) return;
        await redis.hDel(this._containersKey(), containerName);
    }

    /**
     * Increment the container count on a host.
     * @param {string} hostId
     * @param {number} [delta=1]
     */
    async adjustContainerCount(hostId, delta = 1) {
        const host = await this.getHost(hostId);
        if (!host) return;
        host.currentContainers = Math.max(0, (host.currentContainers || 0) + delta);
        await this.upsertHost(host);
    }

    /**
     * Update last health check timestamp.
     * @param {string} hostId
     */
    async recordHealthCheck(hostId) {
        const redis = getClient();
        if (!redis) return;
        await redis.hSet(this._healthKey(), hostId, String(Date.now()));
    }

    /**
     * Get pool status overview.
     * @returns {Promise<{totalHosts: number, activeHosts: number, totalCapacity: number, usedCapacity: number, utilizationPct: number, hosts: HostEntry[]}>}
     */
    async getPoolStatus() {
        const hosts = await this.getAllHosts();
        const active = hosts.filter(h => h.status === 'active');
        const totalCapacity = active.reduce((sum, h) => sum + h.maxContainers, 0);
        const usedCapacity = active.reduce((sum, h) => sum + h.currentContainers, 0);

        return {
            totalHosts: hosts.length,
            activeHosts: active.length,
            totalCapacity,
            usedCapacity,
            utilizationPct: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0,
            hosts,
        };
    }

    /**
     * Get all containers on a specific host.
     * @param {string} hostId
     * @returns {Promise<string[]>} container names
     */
    async getContainersOnHost(hostId) {
        const redis = getClient();
        if (!redis) return [];
        const all = await redis.hGetAll(this._containersKey());
        return Object.entries(all)
            .filter(([, hid]) => hid === hostId)
            .map(([name]) => name);
    }
}
