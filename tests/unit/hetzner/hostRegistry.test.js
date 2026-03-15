import test from 'ava';

// HostRegistry uses getClient() from encryptedRedisClient which returns
// the actual Redis client. Since we have .env loaded (ava config), the
// Redis client will be available. We test against real Redis.
// Each test uses a unique prefix to avoid collisions.

let HostRegistry;

test.before(async () => {
    const mod = await import('../../../lib/hetzner/HostRegistry.js');
    HostRegistry = mod.default;
});

function makeRegistry() {
    const r = new HostRegistry();
    // Override prefix to isolate test data
    r._prefix = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return r;
}

test.serial('upsertHost and getHost round-trip', async t => {
    const registry = makeRegistry();
    const host = {
        id: 'host-1',
        ip: '10.0.1.10',
        dockerPort: 2376,
        maxContainers: 50,
        currentContainers: 5,
        status: 'active',
        createdAt: Date.now(),
    };

    await registry.upsertHost(host);
    const retrieved = await registry.getHost('host-1');

    t.is(retrieved.id, 'host-1');
    t.is(retrieved.ip, '10.0.1.10');
    t.is(retrieved.currentContainers, 5);
});

test.serial('getHost returns null for missing host', async t => {
    const registry = makeRegistry();
    const result = await registry.getHost('nonexistent');
    t.is(result, null);
});

test.serial('getAllHosts returns all registered hosts', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 0, dockerPort: 2376, createdAt: 1 });
    await registry.upsertHost({ id: 'h2', ip: '10.0.1.2', status: 'offline', maxContainers: 50, currentContainers: 0, dockerPort: 2376, createdAt: 2 });
    await registry.upsertHost({ id: 'h3', ip: '10.0.1.3', status: 'active', maxContainers: 50, currentContainers: 10, dockerPort: 2376, createdAt: 3 });

    const all = await registry.getAllHosts();
    t.is(all.length, 3);
});

test.serial('getActiveHosts filters and sorts by utilization', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'full', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 45, dockerPort: 2376, createdAt: 1 });
    await registry.upsertHost({ id: 'offline', ip: '10.0.1.2', status: 'offline', maxContainers: 50, currentContainers: 0, dockerPort: 2376, createdAt: 2 });
    await registry.upsertHost({ id: 'empty', ip: '10.0.1.3', status: 'active', maxContainers: 50, currentContainers: 0, dockerPort: 2376, createdAt: 3 });
    await registry.upsertHost({ id: 'half', ip: '10.0.1.4', status: 'active', maxContainers: 50, currentContainers: 25, dockerPort: 2376, createdAt: 4 });

    const active = await registry.getActiveHosts();
    t.is(active.length, 3);
    t.is(active[0].id, 'empty');
    t.is(active[1].id, 'half');
    t.is(active[2].id, 'full');
});

test.serial('pickHost returns host with most free capacity', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 40, dockerPort: 2376, createdAt: 1 });
    await registry.upsertHost({ id: 'h2', ip: '10.0.1.2', status: 'active', maxContainers: 50, currentContainers: 10, dockerPort: 2376, createdAt: 2 });

    const picked = await registry.pickHost();
    t.is(picked.id, 'h2');
});

test.serial('pickHost returns null when all hosts are full', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 50, dockerPort: 2376, createdAt: 1 });

    const picked = await registry.pickHost();
    t.is(picked, null);
});

test.serial('isPoolFull with threshold', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 100, currentContainers: 85, dockerPort: 2376, createdAt: 1 });

    t.true(await registry.isPoolFull(0.8));
    t.false(await registry.isPoolFull(0.9));
});

test.serial('isPoolFull returns true when no hosts exist', async t => {
    const registry = makeRegistry();
    t.true(await registry.isPoolFull(0.8));
});

test.serial('container-host mapping', async t => {
    const registry = makeRegistry();

    await registry.setContainerHost('workspace-abc', 'host-1');
    await registry.setContainerHost('workspace-def', 'host-2');

    t.is(await registry.getContainerHost('workspace-abc'), 'host-1');
    t.is(await registry.getContainerHost('workspace-def'), 'host-2');
    t.is(await registry.getContainerHost('workspace-xyz'), null);

    await registry.removeContainer('workspace-abc');
    t.is(await registry.getContainerHost('workspace-abc'), null);
});

test.serial('adjustContainerCount increments and decrements', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 10, dockerPort: 2376, createdAt: 1 });

    await registry.adjustContainerCount('h1', 1);
    let h = await registry.getHost('h1');
    t.is(h.currentContainers, 11);

    await registry.adjustContainerCount('h1', -3);
    h = await registry.getHost('h1');
    t.is(h.currentContainers, 8);

    await registry.adjustContainerCount('h1', -100);
    h = await registry.getHost('h1');
    t.is(h.currentContainers, 0);
});

test.serial('removeHost deletes from registry', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 0, dockerPort: 2376, createdAt: 1 });

    await registry.removeHost('h1');
    t.is(await registry.getHost('h1'), null);
});

test.serial('getContainersOnHost returns matching containers', async t => {
    const registry = makeRegistry();
    await registry.setContainerHost('ws-1', 'host-a');
    await registry.setContainerHost('ws-2', 'host-a');
    await registry.setContainerHost('ws-3', 'host-b');

    const onA = await registry.getContainersOnHost('host-a');
    t.is(onA.length, 2);
    t.true(onA.includes('ws-1'));
    t.true(onA.includes('ws-2'));
});

test.serial('getPoolStatus returns correct overview', async t => {
    const registry = makeRegistry();
    await registry.upsertHost({ id: 'h1', ip: '10.0.1.1', status: 'active', maxContainers: 50, currentContainers: 20, dockerPort: 2376, createdAt: 1 });
    await registry.upsertHost({ id: 'h2', ip: '10.0.1.2', status: 'active', maxContainers: 50, currentContainers: 30, dockerPort: 2376, createdAt: 2 });
    await registry.upsertHost({ id: 'h3', ip: '10.0.1.3', status: 'offline', maxContainers: 50, currentContainers: 0, dockerPort: 2376, createdAt: 3 });

    const status = await registry.getPoolStatus();
    t.is(status.totalHosts, 3);
    t.is(status.activeHosts, 2);
    t.is(status.totalCapacity, 100);
    t.is(status.usedCapacity, 50);
    t.is(status.utilizationPct, 50);
});
