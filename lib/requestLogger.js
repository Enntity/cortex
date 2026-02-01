// requestLogger.js
// Structured NDJSON request logging, keyed by requestId.
// Thin wrapper over winston — all existing level filtering, suppression
// (AsyncLocalStorage), and continuity mode work unchanged.

import logger from './logger.js';

export function logEvent(requestId, event, data = {}) {
    const entry = { ts: new Date().toISOString(), rid: requestId, evt: event, ...data };
    logger.info(JSON.stringify(entry));
}

export function logEventError(requestId, event, data = {}) {
    const entry = { ts: new Date().toISOString(), rid: requestId, evt: event, ...data };
    logger.error(JSON.stringify(entry));
}

export function logEventDebug(requestId, event, data = {}) {
    const entry = { ts: new Date().toISOString(), rid: requestId, evt: event, ...data };
    logger.debug(JSON.stringify(entry));
}
