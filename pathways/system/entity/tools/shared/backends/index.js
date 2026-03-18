// backends/index.js
// Factory for workspace container backends.
// Singleton — lazily creates the backend on first call.

import { config } from '../../../../../../config.js';

let _backend = null;

/**
 * Get the configured container backend (singleton).
 * Uses dynamic import so additional backends only load when selected.
 * @returns {Promise<import('./ContainerBackend.js').default>}
 */
export async function getBackend() {
    if (_backend) return _backend;

    const backendType = config.get('workspaceBackend');

    if (backendType === 'hetzner') {
        const { default: HetznerBackend } = await import('./HetznerBackend.js');
        _backend = new HetznerBackend();
    } else {
        const { default: DockerBackend } = await import('./DockerBackend.js');
        _backend = new DockerBackend();
    }

    return _backend;
}
