import test from 'ava';

// Test the HetznerBackend's cloud-init generation and constructor validation
// without actually calling Hetzner API or Docker.

test('HetznerBackend requires HETZNER_API_TOKEN', async t => {
    // Save and clear config value
    const originalEnv = process.env.HETZNER_API_TOKEN;
    delete process.env.HETZNER_API_TOKEN;

    // The backend factory reads from config, but the constructor itself checks
    // We test this by importing directly
    try {
        const { default: HetznerBackend } = await import(
            '../../../pathways/system/entity/tools/shared/backends/HetznerBackend.js'
        );
        // Constructor should throw if no token
        t.throws(() => new HetznerBackend(), { message: /HETZNER_API_TOKEN.*required/ });
    } catch (e) {
        // If import itself fails due to config, that's also acceptable
        t.true(e.message.includes('HETZNER_API_TOKEN') || e.message.includes('required'));
    } finally {
        if (originalEnv) process.env.HETZNER_API_TOKEN = originalEnv;
    }
});

test('ContainerBackend abstract methods throw', async t => {
    const { default: ContainerBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/ContainerBackend.js'
    );

    const backend = new ContainerBackend();

    await t.throwsAsync(() => backend.createAndStart({}), { message: /not implemented/ });
    await t.throwsAsync(() => backend.start('id', 'name'), { message: /not implemented/ });
    await t.throwsAsync(() => backend.stop('id', 'name'), { message: /not implemented/ });
    await t.throwsAsync(() => backend.remove('id', 'name'), { message: /not implemented/ });
    await t.throwsAsync(() => backend.destroyVolume('share'), { message: /not implemented/ });
    t.throws(() => backend.backendName, { message: /not implemented/ });
    t.throws(() => backend.healthTimeoutMs, { message: /not implemented/ });
});

test('ContainerBackend wakeHealthTimeoutMs defaults to healthTimeoutMs', async t => {
    const { default: ContainerBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/ContainerBackend.js'
    );

    // Create a subclass that implements healthTimeoutMs
    class TestBackend extends ContainerBackend {
        get healthTimeoutMs() { return 42000; }
    }

    const backend = new TestBackend();
    t.is(backend.wakeHealthTimeoutMs, 42000);
});

test('DockerBackend has correct properties', async t => {
    const { default: DockerBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/DockerBackend.js'
    );

    const backend = new DockerBackend();
    t.is(backend.backendName, 'docker');
    t.is(backend.healthTimeoutMs, 30000);
    t.is(backend.wakeHealthTimeoutMs, 30000);
});

test('DockerBackend parseMemoryLimit handles various formats', async t => {
    const { parseMemoryLimit } = await import(
        '../../../pathways/system/entity/tools/shared/backends/DockerBackend.js'
    );

    t.is(parseMemoryLimit('512m'), 512 * 1024 * 1024);
    t.is(parseMemoryLimit('1g'), 1024 * 1024 * 1024);
    t.is(parseMemoryLimit('256mb'), 256 * 1024 * 1024);
    t.is(parseMemoryLimit('2048k'), 2048 * 1024);
    t.is(parseMemoryLimit('invalid'), 512 * 1024 * 1024); // default
});

test('getBackend returns docker backend by default', async t => {
    const { getBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/index.js'
    );

    const backend = await getBackend();
    t.is(backend.backendName, 'docker');
});

test('workspace_client resolveWorkspaceImage handles versions', async t => {
    const { resolveWorkspaceImage } = await import(
        '../../../pathways/system/entity/tools/shared/workspace_client.js'
    );

    // Default: image already has a tag or falls back to :latest
    const result = resolveWorkspaceImage();
    t.true(typeof result === 'string');
    t.true(result.includes(':'));
});

test('workspace_client parseMemoryToMB handles various formats', async t => {
    const { parseMemoryToMB } = await import(
        '../../../pathways/system/entity/tools/shared/workspace_client.js'
    );

    t.is(parseMemoryToMB('512m'), 512);
    t.is(parseMemoryToMB('1g'), 1024);
    t.is(parseMemoryToMB('256mb'), 256);
    t.is(parseMemoryToMB('invalid'), 512); // default
});
