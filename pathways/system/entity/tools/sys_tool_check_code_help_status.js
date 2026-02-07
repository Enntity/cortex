/**
 * CheckCodeHelpStatus Tool
 *
 * Checks the status of a previously submitted code help request.
 * Reads the response from Redis (set by the helper app via the
 * sys_dequeue_code_help pathway).
 *
 * Category "system" — must be explicitly added to an entity's tool list.
 */

import { getClient } from '../../../../lib/encryptedRedisClient.js';
import logger from '../../../../lib/logger.js';

function responseKey(requestId) {
    return `claude:code-help:response:${requestId}`;
}

export default {
    inputParameters: {
        requestId: ``,
    },

    toolDefinition: [{
        type: "function",
        category: "system",
        icon: "📋",
        toolCost: 1,
        function: {
            name: "CheckCodeHelpStatus",
            description: `Check the status of a code help request previously submitted with RequestCodeHelp. Returns the result if processing is complete, or a pending/in_progress status if still being worked on.`,
            parameters: {
                type: 'object',
                properties: {
                    requestId: {
                        type: 'string',
                        description: 'The request ID returned by RequestCodeHelp'
                    },
                    userMessage: {
                        type: 'string',
                        description: 'Brief message to display while this action runs'
                    }
                },
                required: ['requestId', 'userMessage']
            }
        }
    }],

    executePathway: async ({ args, resolver }) => {
        const { requestId } = args;

        try {
            if (!requestId) {
                return JSON.stringify({ success: false, error: 'requestId is required' });
            }

            const redis = getClient();
            if (!redis) {
                return JSON.stringify({ success: false, error: 'Redis not available' });
            }

            const raw = await redis.get(responseKey(requestId));

            if (!raw) {
                return JSON.stringify({ status: 'pending', requestId, message: 'Request is still in the queue — not yet picked up.' });
            }

            let response;
            try {
                response = JSON.parse(raw);
            } catch {
                response = { status: 'unknown', raw };
            }

            if (resolver) {
                resolver.tool = JSON.stringify({ toolUsed: 'CheckCodeHelpStatus', requestId, status: response.status });
            }

            return JSON.stringify(response);
        } catch (err) {
            logger.error(`CheckCodeHelpStatus failed: ${err.message}`);
            return JSON.stringify({ success: false, error: `Failed to check status: ${err.message}` });
        }
    }
};
