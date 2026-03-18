import test from 'ava';

// We test HetznerClient by directly constructing it and intercepting fetch.
// The client uses globalThis.fetch which we can override per-test.

let HetznerClient;

test.before(async () => {
    const mod = await import('../../../lib/hetzner/HetznerClient.js');
    HetznerClient = mod.default;
});

function mockFetch(responses) {
    const calls = [];
    const queue = [...responses];
    const original = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        const resp = queue.shift() || { status: 200, body: {} };
        return {
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            statusText: 'OK',
            json: async () => resp.body,
        };
    };

    return {
        calls,
        restore: () => { globalThis.fetch = original; },
    };
}

test('constructor requires apiToken', t => {
    t.throws(() => new HetznerClient(''), { message: /required/ });
    t.throws(() => new HetznerClient(null), { message: /required/ });
    t.notThrows(() => new HetznerClient('test-token'));
});

test.serial('createServer sends correct request', async t => {
    const client = new HetznerClient('test-token');
    const mock = mockFetch([{
        status: 201,
        body: {
            server: {
                id: 12345, name: 'workspace-host-1', status: 'initializing',
                public_net: { ipv4: { ip: '1.2.3.4' } },
                private_net: [{ ip: '10.0.1.5' }],
            },
        },
    }]);

    try {
        const result = await client.createServer({
            name: 'workspace-host-1',
            serverType: 'cx42',
            location: 'fsn1',
            userData: '#cloud-config',
            firewalls: [100],
            sshKeys: [200],
            networks: [300],
            labels: { role: 'workspace-host' },
        });

        t.is(mock.calls.length, 1);
        t.true(mock.calls[0].url.endsWith('/servers'));
        t.is(mock.calls[0].options.method, 'POST');

        const body = JSON.parse(mock.calls[0].options.body);
        t.is(body.name, 'workspace-host-1');
        t.is(body.server_type, 'cx42');
        t.deepEqual(body.firewalls, [{ firewall: 100 }]);

        t.is(result.id, 12345);
        t.is(result.publicIp, '1.2.3.4');
        t.is(result.privateIp, '10.0.1.5');
    } finally {
        mock.restore();
    }
});

test.serial('deleteServer calls correct endpoint', async t => {
    const client = new HetznerClient('test-token');
    const mock = mockFetch([{ status: 200, body: {} }]);

    try {
        await client.deleteServer(12345);
        t.is(mock.calls.length, 1);
        t.true(mock.calls[0].url.endsWith('/servers/12345'));
        t.is(mock.calls[0].options.method, 'DELETE');
    } finally {
        mock.restore();
    }
});

test.serial('listServers with label selector', async t => {
    const client = new HetznerClient('test-token');
    const mock = mockFetch([{
        status: 200,
        body: {
            servers: [
                { id: 1, name: 'h1', status: 'running', server_type: { name: 'cx42' }, public_net: { ipv4: { ip: '1.1.1.1' } }, private_net: [{ ip: '10.0.1.1' }], labels: {} },
                { id: 2, name: 'h2', status: 'running', server_type: { name: 'cx42' }, public_net: { ipv4: { ip: '2.2.2.2' } }, private_net: [], labels: {} },
            ],
        },
    }]);

    try {
        const servers = await client.listServers('role=workspace-host');
        t.is(servers.length, 2);
        t.is(servers[0].privateIp, '10.0.1.1');
        t.is(servers[1].privateIp, null);
        t.true(mock.calls[0].url.includes('label_selector='));
    } finally {
        mock.restore();
    }
});

test.serial('API error throws with message', async t => {
    const client = new HetznerClient('test-token');
    const mock = mockFetch([{ status: 422, body: { error: { message: 'Server name already used' } } }]);

    try {
        await t.throwsAsync(
            () => client.createServer({ name: 'dup', serverType: 'cx22', location: 'fsn1', userData: '' }),
            { message: /422.*Server name already used/ },
        );
    } finally {
        mock.restore();
    }
});

test.serial('createVolume sends correct request', async t => {
    const client = new HetznerClient('test-token');
    const mock = mockFetch([{
        status: 201,
        body: { volume: { id: 999, name: 'ws-vol-1', size: 20, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_999' } },
    }]);

    try {
        const vol = await client.createVolume({ name: 'ws-vol-1', size: 20, location: 'fsn1' });
        t.is(vol.id, 999);
        t.is(vol.size, 20);
    } finally {
        mock.restore();
    }
});

test.serial('getServer returns structured data', async t => {
    const client = new HetznerClient('test-token');
    const mock = mockFetch([{
        status: 200,
        body: {
            server: { id: 42, name: 'test-host', status: 'running', server_type: { name: 'cx22' }, public_net: { ipv4: { ip: '5.5.5.5' } }, private_net: [], labels: {} },
        },
    }]);

    try {
        const s = await client.getServer(42);
        t.is(s.id, 42);
        t.is(s.serverType, 'cx22');
    } finally {
        mock.restore();
    }
});

test.serial('authorization header includes token', async t => {
    const client = new HetznerClient('my-secret-token');
    const mock = mockFetch([{ status: 200, body: { servers: [] } }]);

    try {
        await client.listServers();
        t.is(mock.calls[0].options.headers.Authorization, 'Bearer my-secret-token');
    } finally {
        mock.restore();
    }
});
