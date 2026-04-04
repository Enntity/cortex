import pubsub from './pubsub.js';
import { withFilter } from 'graphql-subscriptions';
import { publishRequestProgressSubscription } from '../lib/redisSubscription.js';
import logger from '../lib/logger.js';

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            (_, args, __, _info) => {
                logger.debug(`Client requested subscription for request ids: ${args.requestIds}`);
                const iterator = pubsub.asyncIterator(['REQUEST_PROGRESS']);
                // Defer request startup until after the async iterator is created so
                // we do not lose early progress events on fast-starting requests.
                queueMicrotask(() => {
                    publishRequestProgressSubscription(args.requestIds);
                });
                return iterator;
            },
            (payload, variables) => {
                return (
                    variables.requestIds.includes(payload.requestProgress.requestId)
                );
            },
        ),
    },
};

export default subscriptions;
