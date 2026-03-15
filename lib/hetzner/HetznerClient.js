// HetznerClient.js
// Thin wrapper around the Hetzner Cloud API for server lifecycle management.

import logger from '../logger.js';

const API_BASE = 'https://api.hetzner.cloud/v1';

export default class HetznerClient {
    /**
     * @param {string} apiToken - Hetzner Cloud API token
     */
    constructor(apiToken) {
        if (!apiToken) throw new Error('Hetzner API token is required');
        this._token = apiToken;
    }

    /**
     * Make an authenticated request to the Hetzner Cloud API.
     */
    async _request(method, path, body = null) {
        const url = `${API_BASE}${path}`;
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this._token}`,
                'Content-Type': 'application/json',
            },
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const errMsg = data.error?.message || response.statusText;
            throw new Error(`Hetzner API ${method} ${path}: ${response.status} ${errMsg}`);
        }

        return data;
    }

    /**
     * Create a new server with cloud-init user data.
     *
     * @param {Object} opts
     * @param {string} opts.name - Server name
     * @param {string} opts.serverType - e.g. 'cx22', 'cx32', 'cx42'
     * @param {string} opts.location - e.g. 'fsn1', 'nbg1', 'hel1'
     * @param {string} opts.userData - Cloud-init user data (YAML)
     * @param {number[]} [opts.firewalls] - Firewall IDs to attach
     * @param {number[]} [opts.sshKeys] - SSH key IDs for emergency access
     * @param {number[]} [opts.networks] - Private network IDs to attach
     * @param {Object} [opts.labels] - Key-value labels for the server
     * @returns {Promise<{id: number, name: string, publicIp: string, privateIp: string|null, status: string}>}
     */
    async createServer(opts) {
        const { name, serverType, location, userData, firewalls, sshKeys, networks, labels } = opts;

        const body = {
            name,
            server_type: serverType,
            location,
            image: 'ubuntu-24.04',
            user_data: userData,
            start_after_create: true,
            labels: labels || {},
        };

        if (firewalls?.length) {
            body.firewalls = firewalls.map(id => ({ firewall: id }));
        }
        if (sshKeys?.length) {
            body.ssh_keys = sshKeys;
        }
        if (networks?.length) {
            body.networks = networks;
        }

        const data = await this._request('POST', '/servers', body);
        const server = data.server;

        return {
            id: server.id,
            name: server.name,
            publicIp: server.public_net?.ipv4?.ip || null,
            privateIp: server.private_net?.[0]?.ip || null,
            status: server.status,
        };
    }

    /**
     * Delete a server by ID.
     */
    async deleteServer(serverId) {
        await this._request('DELETE', `/servers/${serverId}`);
    }

    /**
     * Power on a server.
     */
    async powerOn(serverId) {
        await this._request('POST', `/servers/${serverId}/actions/poweron`);
    }

    /**
     * Graceful shutdown.
     */
    async shutdown(serverId) {
        await this._request('POST', `/servers/${serverId}/actions/shutdown`);
    }

    /**
     * Get server details.
     */
    async getServer(serverId) {
        const data = await this._request('GET', `/servers/${serverId}`);
        const s = data.server;
        return {
            id: s.id,
            name: s.name,
            publicIp: s.public_net?.ipv4?.ip || null,
            privateIp: s.private_net?.[0]?.ip || null,
            status: s.status,
            serverType: s.server_type?.name,
            labels: s.labels || {},
        };
    }

    /**
     * List all servers with a given label selector.
     * @param {string} labelSelector - e.g. 'role=workspace-host'
     */
    async listServers(labelSelector) {
        const params = labelSelector ? `?label_selector=${encodeURIComponent(labelSelector)}` : '';
        const data = await this._request('GET', `/servers${params}`);
        return (data.servers || []).map(s => ({
            id: s.id,
            name: s.name,
            publicIp: s.public_net?.ipv4?.ip || null,
            privateIp: s.private_net?.[0]?.ip || null,
            status: s.status,
            serverType: s.server_type?.name,
            labels: s.labels || {},
        }));
    }

    /**
     * Create a Hetzner Volume.
     * @param {Object} opts
     * @param {string} opts.name - Volume name
     * @param {number} opts.size - Size in GB
     * @param {string} opts.location - e.g. 'fsn1'
     * @param {number} [opts.serverId] - Attach to this server immediately
     * @returns {Promise<{id: number, name: string, size: number, linuxDevice: string}>}
     */
    async createVolume(opts) {
        const { name, size, location, serverId } = opts;
        const body = {
            name,
            size,
            location,
            automount: false,
            format: 'ext4',
            labels: { role: 'workspace-data' },
        };
        if (serverId) {
            body.server = serverId;
        }

        const data = await this._request('POST', '/volumes', body);
        return {
            id: data.volume.id,
            name: data.volume.name,
            size: data.volume.size,
            linuxDevice: data.volume.linux_device,
        };
    }

    /**
     * Delete a volume.
     */
    async deleteVolume(volumeId) {
        await this._request('DELETE', `/volumes/${volumeId}`);
    }

    /**
     * Attach a volume to a server.
     */
    async attachVolume(volumeId, serverId) {
        await this._request('POST', `/volumes/${volumeId}/actions/attach`, {
            server: serverId,
            automount: false,
        });
    }

    /**
     * Detach a volume from its current server.
     */
    async detachVolume(volumeId) {
        await this._request('POST', `/volumes/${volumeId}/actions/detach`);
    }

    /**
     * List volumes with optional label selector.
     */
    async listVolumes(labelSelector) {
        const params = labelSelector ? `?label_selector=${encodeURIComponent(labelSelector)}` : '';
        const data = await this._request('GET', `/volumes${params}`);
        return (data.volumes || []).map(v => ({
            id: v.id,
            name: v.name,
            size: v.size,
            serverId: v.server,
            linuxDevice: v.linux_device,
            labels: v.labels || {},
        }));
    }
}
