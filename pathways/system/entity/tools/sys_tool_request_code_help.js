/**
 * RequestCodeHelp Tool
 *
 * Allows an entity to request code fixes from Claude Code running on
 * the developer's laptop. Pushes a request onto a Redis queue that
 * gets consumed by the cortex-claude-code helper app.
 *
 * Category "system" — must be explicitly added to an entity's tool list.
 */

import { getClient } from '../../../../lib/encryptedRedisClient.js';
import { loadEntityConfig } from './shared/sys_entity_tools.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../../../lib/logger.js';

const QUEUE_KEY = 'claude:code-help:requests';

export default {
    inputParameters: {
        issue: ``,
        filePath: ``,
        error: ``,
        context: ``,
        priority: ``,
        entityId: ``,
    },

    toolDefinition: [{
        type: "function",
        category: "system",
        icon: "🛠️",
        toolCost: 1,
        function: {
            name: "RequestCodeHelp",
            description: `Request a code fix or feature change from Claude Code on the developer's laptop. Use this when you encounter a bug, need a code change, or want to request a new feature. The request is queued and processed asynchronously — use CheckCodeHelpStatus to check the result later.`,
            parameters: {
                type: 'object',
                properties: {
                    issue: {
                        type: 'string',
                        description: 'Clear description of the bug, feature request, or code change needed'
                    },
                    filePath: {
                        type: 'string',
                        description: 'Path to the relevant file (relative to project root), if known'
                    },
                    error: {
                        type: 'string',
                        description: 'Error message or stack trace, if applicable'
                    },
                    context: {
                        type: 'string',
                        description: 'Additional context — what you were doing when the issue occurred, relevant config, etc.'
                    },
                    priority: {
                        type: 'string',
                        enum: ['normal', 'urgent'],
                        description: 'Request priority (default: normal)'
                    },
                    userMessage: {
                        type: 'string',
                        description: 'Brief message to display while this action runs'
                    }
                },
                required: ['issue', 'userMessage']
            }
        }
    }],

    executePathway: async ({ args, resolver }) => {
        const { issue, filePath, error, context, priority, entityId } = args;

        try {
            if (!issue) {
                return JSON.stringify({ success: false, error: 'issue is required' });
            }

            const redis = getClient();
            if (!redis) {
                return JSON.stringify({ success: false, error: 'Redis not available' });
            }

            // Look up entity name for the request
            let entityName = 'unknown';
            if (entityId) {
                const entityConfig = await loadEntityConfig(entityId);
                if (entityConfig) {
                    entityName = entityConfig.name || entityName;
                }
            }

            const requestId = uuidv4();
            const request = {
                requestId,
                entityId,
                entityName,
                issue,
                filePath: filePath || null,
                error: error || null,
                context: context || null,
                priority: priority || 'normal',
                timestamp: new Date().toISOString(),
            };

            await redis.lpush(QUEUE_KEY, JSON.stringify(request));

            logger.info(`RequestCodeHelp: queued ${requestId} from ${entityName} — ${issue.substring(0, 80)}`);

            if (resolver) {
                resolver.tool = JSON.stringify({ toolUsed: 'RequestCodeHelp', requestId });
            }

            return JSON.stringify({
                success: true,
                requestId,
                message: `Code help request queued (ID: ${requestId}). Use CheckCodeHelpStatus to check the result.`,
            });
        } catch (err) {
            logger.error(`RequestCodeHelp failed: ${err.message}`);
            return JSON.stringify({ success: false, error: `Failed to queue request: ${err.message}` });
        }
    }
};
