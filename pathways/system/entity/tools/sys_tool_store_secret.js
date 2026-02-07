/**
 * Store Secret Tool
 *
 * Allows an entity to securely store API keys, tokens, and other credentials.
 * Secrets are encrypted at rest (AES-256-GCM) and injected into the workspace
 * as environment variables and a .env file.
 *
 * This is a "system" category tool — it's only available when explicitly
 * added to an entity's tool list (not included in wildcard expansion).
 */

import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { config } from '../../../../config.js';
import { encrypt, decrypt } from '../../../../lib/crypto.js';
import { syncSecretsToWorkspace } from './shared/workspace_client.js';
import logger from '../../../../lib/logger.js';

export default {
    inputParameters: {
        name: ``,       // Secret name (UPPER_SNAKE_CASE)
        value: ``,      // Secret value (or null to delete)
        entityId: ``,   // Entity UUID (injected by system)
    },

    toolDefinition: [{
        type: "function",
        category: "system",
        icon: "🔐",
        toolCost: 1,
        function: {
            name: "StoreSecret",
            description: `Securely store an API key, token, or credential. The secret is encrypted and made available in your workspace as an environment variable and in /workspace/.env.

Use this when a user gives you an API key or token — store it immediately so you never need to handle the plaintext again. Set value to null to delete a secret.

Secret names must be UPPER_SNAKE_CASE (e.g., GITHUB_TOKEN, OPENAI_API_KEY).`,
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Secret name in UPPER_SNAKE_CASE (e.g., GITHUB_TOKEN, API_KEY)'
                    },
                    value: {
                        type: 'string',
                        description: 'The secret value to store, or null to delete an existing secret'
                    },
                    userMessage: {
                        type: 'string',
                        description: 'Brief message to display while this action runs'
                    }
                },
                required: ['name', 'userMessage']
            }
        }
    }],

    executePathway: async ({ args, resolver }) => {
        const { name, value, entityId } = args;

        try {
            if (!entityId) {
                return JSON.stringify({ success: false, error: 'entityId is required' });
            }

            // Validate secret name
            if (!name || !/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
                return JSON.stringify({ success: false, error: `Invalid secret name: "${name}". Use UPPER_SNAKE_CASE (e.g., GITHUB_TOKEN).` });
            }

            const entityStore = getEntityStore();
            const entity = await entityStore.getEntity(entityId, { fresh: true });
            if (!entity) {
                return JSON.stringify({ success: false, error: 'Entity not found' });
            }

            const systemKey = config.get('redisEncryptionKey');
            const existing = entity.secrets || {};
            const merged = { ...existing };

            if (value === null || value === undefined || value === '') {
                // Delete the secret
                if (!merged[name]) {
                    return JSON.stringify({ success: true, message: `Secret "${name}" was not set` });
                }
                delete merged[name];
            } else {
                // Encrypt and store
                merged[name] = encrypt(value, systemKey);
            }

            // Update entity in MongoDB
            await entityStore.upsertEntity({
                ...entity,
                secrets: merged,
            });

            // Push to workspace if running (best-effort)
            if (entity.workspace?.url && entity.workspace?.status === 'running') {
                const plainSecrets = {};
                for (const [k, encVal] of Object.entries(merged)) {
                    plainSecrets[k] = decrypt(encVal, systemKey);
                }
                syncSecretsToWorkspace(entityId, plainSecrets).catch(() => {});
            }

            if (resolver) {
                resolver.tool = JSON.stringify({ toolUsed: 'StoreSecret', action: value === null ? 'delete' : 'store', name });
            }

            const action = (value === null || value === undefined || value === '') ? 'deleted' : 'stored';
            logger.info(`Secret "${name}" ${action} for entity ${entityId}`);

            return JSON.stringify({
                success: true,
                message: `Secret "${name}" ${action} successfully. Available as $${name} in your workspace.`,
                secretKeys: Object.keys(merged),
            });
        } catch (error) {
            logger.error(`StoreSecret failed: ${error.message}`);
            return JSON.stringify({ success: false, error: `Failed to store secret: ${error.message}` });
        }
    }
};
