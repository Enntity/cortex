// entitySecrets.test.js
// Tests for entity secrets: encryption, validation, merge semantics, .env generation

import test from 'ava';
import { encrypt, decrypt } from '../../../lib/crypto.js';

const systemKey = '1234567890123456789012345678901234567890123456789012345678901234';

// ─── Encrypt/decrypt round-trip ───

test('secrets: encrypt/decrypt round-trip preserves value', t => {
    const secret = 'ghp_abc123XYZ';
    const encrypted = encrypt(secret, systemKey);
    t.not(encrypted, secret);
    t.is(decrypt(encrypted, systemKey), secret);
});

test('secrets: each encryption produces unique ciphertext', t => {
    const secret = 'my-api-key-123';
    const enc1 = encrypt(secret, systemKey);
    const enc2 = encrypt(secret, systemKey);
    t.not(enc1, enc2); // Different IVs
    t.is(decrypt(enc1, systemKey), secret);
    t.is(decrypt(enc2, systemKey), secret);
});

test('secrets: handles special characters in values', t => {
    const secret = 'key=with&special/chars+base64==';
    const encrypted = encrypt(secret, systemKey);
    t.is(decrypt(encrypted, systemKey), secret);
});

// ─── Secret name validation ───

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/i;

test('secrets: valid UPPER_SNAKE_CASE names', t => {
    const valid = ['GITHUB_TOKEN', 'API_KEY', 'MY_SECRET_123', '_PRIVATE', 'X'];
    for (const name of valid) {
        t.true(SECRET_NAME_REGEX.test(name), `${name} should be valid`);
    }
});

test('secrets: invalid secret names', t => {
    const invalid = ['123_BAD', 'has space', 'has-dash', 'dot.name', '', 'a@b'];
    for (const name of invalid) {
        t.false(SECRET_NAME_REGEX.test(name), `"${name}" should be invalid`);
    }
});

// ─── Merge semantics ───

test('secrets: merge adds new keys', t => {
    const existing = {};
    const incoming = { GITHUB_TOKEN: 'token123' };
    const merged = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
        if (v === null) {
            delete merged[k];
        } else {
            merged[k] = encrypt(v, systemKey);
        }
    }
    t.deepEqual(Object.keys(merged), ['GITHUB_TOKEN']);
    t.is(decrypt(merged.GITHUB_TOKEN, systemKey), 'token123');
});

test('secrets: merge updates existing keys', t => {
    const existing = { API_KEY: encrypt('old_value', systemKey) };
    const incoming = { API_KEY: 'new_value' };
    const merged = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
        if (v === null) {
            delete merged[k];
        } else {
            merged[k] = encrypt(v, systemKey);
        }
    }
    t.is(decrypt(merged.API_KEY, systemKey), 'new_value');
});

test('secrets: merge deletes keys with null value', t => {
    const existing = {
        KEEP_ME: encrypt('value1', systemKey),
        DELETE_ME: encrypt('value2', systemKey),
    };
    const incoming = { DELETE_ME: null };
    const merged = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
        if (v === null) {
            delete merged[k];
        } else {
            merged[k] = encrypt(v, systemKey);
        }
    }
    t.deepEqual(Object.keys(merged), ['KEEP_ME']);
    t.is(decrypt(merged.KEEP_ME, systemKey), 'value1');
});

test('secrets: merge handles mixed add/update/delete', t => {
    const existing = {
        EXISTING_KEY: encrypt('existing', systemKey),
        TO_DELETE: encrypt('bye', systemKey),
        TO_UPDATE: encrypt('old', systemKey),
    };
    const incoming = {
        NEW_KEY: 'brand_new',
        TO_DELETE: null,
        TO_UPDATE: 'updated',
    };
    const merged = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
        if (v === null) {
            delete merged[k];
        } else {
            merged[k] = encrypt(v, systemKey);
        }
    }
    t.deepEqual(Object.keys(merged).sort(), ['EXISTING_KEY', 'NEW_KEY', 'TO_UPDATE']);
    t.is(decrypt(merged.EXISTING_KEY, systemKey), 'existing');
    t.is(decrypt(merged.NEW_KEY, systemKey), 'brand_new');
    t.is(decrypt(merged.TO_UPDATE, systemKey), 'updated');
});

// ─── .env format generation ───

test('secrets: .env format is correct', t => {
    const secrets = { GITHUB_TOKEN: 'ghp_abc123', API_KEY: 'sk-xyz789' };
    const envContent = Object.entries(secrets)
        .map(([k, v]) => `export ${k}=${v}`)
        .join('\n') + '\n';
    t.is(envContent, 'export GITHUB_TOKEN=ghp_abc123\nexport API_KEY=sk-xyz789\n');
});

test('secrets: .env format handles single secret', t => {
    const secrets = { TOKEN: 'value' };
    const envContent = Object.entries(secrets)
        .map(([k, v]) => `export ${k}=${v}`)
        .join('\n') + '\n';
    t.is(envContent, 'export TOKEN=value\n');
});

test('secrets: empty secrets produces empty check', t => {
    const secrets = {};
    const shouldSync = Object.keys(secrets).length > 0;
    t.false(shouldSync);
});

// ─── Pre-encrypted detection (Concierge encrypts before sending to Cortex) ───

const GCM_PATTERN = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

test('secrets: GCM pattern matches encrypted values', t => {
    const encrypted = encrypt('test-value', systemKey);
    t.true(GCM_PATTERN.test(encrypted));
});

test('secrets: GCM pattern rejects plaintext', t => {
    t.false(GCM_PATTERN.test('ghp_abc123'));
    t.false(GCM_PATTERN.test('some-api-key'));
    t.false(GCM_PATTERN.test(''));
});

test('secrets: pre-encrypted values decrypt correctly when stored as-is', t => {
    const encrypted = encrypt('my-secret', systemKey);
    // Simulate Cortex receiving pre-encrypted value and storing it directly
    const stored = GCM_PATTERN.test(encrypted) ? encrypted : encrypt(encrypted, systemKey);
    t.is(decrypt(stored, systemKey), 'my-secret');
});

// ─── StoreSecret tool definition ───

test('StoreSecret tool has correct definition', async t => {
    const mod = await import('../../../pathways/system/entity/tools/sys_tool_store_secret.js');
    const tool = mod.default;
    const def = tool.toolDefinition[0];

    t.is(def.type, 'function');
    t.is(def.category, 'system');
    t.is(def.function.name, 'StoreSecret');
    t.deepEqual(def.function.parameters.required, ['name', 'userMessage']);
    t.truthy(def.function.parameters.properties.name);
    t.truthy(def.function.parameters.properties.value);
});
