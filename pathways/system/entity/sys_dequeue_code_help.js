/**
 * sys_dequeue_code_help Pathway
 *
 * GraphQL-accessible pathway for the cortex-claude-code helper app.
 * Two actions:
 *   - dequeue: BRPOP from the Redis request queue (blocks up to 30s)
 *   - report:  Store the result in Redis with 24h TTL
 *
 * Not an entity tool — no toolDefinition.
 */

import { getClient } from '../../../lib/encryptedRedisClient.js';
import logger from '../../../lib/logger.js';

const QUEUE_KEY = 'claude:code-help:requests';
const BRPOP_TIMEOUT = 30; // seconds
const RESPONSE_TTL = 86400; // 24 hours

function responseKey(requestId) {
    return `claude:code-help:response:${requestId}`;
}

export default {
    prompt: [],
    inputParameters: {
        action: ``,       // "dequeue" or "report"
        requestId: ``,    // required for "report"
        status: ``,       // "completed" | "error"
        summary: ``,      // result summary from Claude
        filesChanged: ``, // comma-separated list or JSON array
        error: ``,        // error message if failed
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        const { action } = args;

        try {
            const redis = getClient();
            if (!redis) {
                return JSON.stringify({ error: 'Redis not available' });
            }

            if (action === 'dequeue') {
                // BRPOP blocks up to BRPOP_TIMEOUT seconds, returns [key, value] or null
                const result = await redis.brpop(QUEUE_KEY, BRPOP_TIMEOUT);

                if (!result) {
                    return JSON.stringify({ request: null });
                }

                const [, value] = result;
                let request;
                try {
                    request = JSON.parse(value);
                } catch {
                    logger.error('sys_dequeue_code_help: failed to parse queued request');
                    return JSON.stringify({ error: 'Malformed request in queue' });
                }

                // Mark as in_progress so CheckCodeHelpStatus can report it
                await redis.setex(
                    responseKey(request.requestId),
                    RESPONSE_TTL,
                    JSON.stringify({ status: 'in_progress', requestId: request.requestId, pickedUpAt: new Date().toISOString() })
                );

                logger.info(`sys_dequeue_code_help: dequeued ${request.requestId} from ${request.entityName}`);
                return JSON.stringify({ request });

            } else if (action === 'report') {
                const { requestId, status, summary, filesChanged, error } = args;

                if (!requestId) {
                    return JSON.stringify({ error: 'requestId is required for report action' });
                }

                const response = {
                    status: status || 'completed',
                    requestId,
                    summary: summary || null,
                    filesChanged: filesChanged || null,
                    error: error || null,
                    completedAt: new Date().toISOString(),
                };

                await redis.setex(responseKey(requestId), RESPONSE_TTL, JSON.stringify(response));

                logger.info(`sys_dequeue_code_help: reported ${requestId} — ${status}`);
                return JSON.stringify({ success: true });

            } else {
                return JSON.stringify({ error: `Unknown action: ${action}. Use "dequeue" or "report".` });
            }
        } catch (err) {
            logger.error(`sys_dequeue_code_help failed: ${err.message}`);
            return JSON.stringify({ error: err.message });
        }
    },
    json: true,
    manageTokenLength: false,
};
