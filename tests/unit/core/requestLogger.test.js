// requestLogger.test.js
// Tests for structured NDJSON request logging wrapper

import test from 'ava';
import { logEvent, logEventError, logEventDebug } from '../../../lib/requestLogger.js';
import logger from '../../../lib/logger.js';

// Capture logger output by temporarily replacing transport methods
function captureLogs(level, fn) {
    const captured = [];
    const original = logger[level];
    logger[level] = (msg) => captured.push(msg);
    try {
        fn();
    } finally {
        logger[level] = original;
    }
    return captured;
}

// --- logEvent (info level) ---

test('logEvent produces valid JSON with required fields', t => {
    const logs = captureLogs('info', () => {
        logEvent('req-123', 'request.start', { entity: 'test-entity', model: 'gpt-4' });
    });

    t.is(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    t.is(parsed.rid, 'req-123');
    t.is(parsed.evt, 'request.start');
    t.is(parsed.entity, 'test-entity');
    t.is(parsed.model, 'gpt-4');
    t.truthy(parsed.ts); // ISO timestamp present
});

test('logEvent includes ISO 8601 timestamp', t => {
    const logs = captureLogs('info', () => {
        logEvent('req-1', 'test.event');
    });

    const parsed = JSON.parse(logs[0]);
    // Verify it's a valid ISO date
    const date = new Date(parsed.ts);
    t.false(isNaN(date.getTime()));
    t.regex(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('logEvent works with no extra data', t => {
    const logs = captureLogs('info', () => {
        logEvent('req-1', 'request.end');
    });

    const parsed = JSON.parse(logs[0]);
    t.is(parsed.rid, 'req-1');
    t.is(parsed.evt, 'request.end');
    t.is(Object.keys(parsed).length, 3); // ts, rid, evt only
});

test('logEvent spreads additional data fields', t => {
    const logs = captureLogs('info', () => {
        logEvent('req-1', 'tool.exec', {
            tool: 'GoogleSearch',
            round: 2,
            durationMs: 1500,
            success: true,
            resultChars: 5000,
        });
    });

    const parsed = JSON.parse(logs[0]);
    t.is(parsed.tool, 'GoogleSearch');
    t.is(parsed.round, 2);
    t.is(parsed.durationMs, 1500);
    t.true(parsed.success);
    t.is(parsed.resultChars, 5000);
});

// --- logEventError (error level) ---

test('logEventError routes through logger.error', t => {
    const infoLogs = captureLogs('info', () => {
        // Should NOT appear in info
    });

    const errorLogs = captureLogs('error', () => {
        logEventError('req-err', 'request.error', { phase: 'tool_exec', error: 'something broke' });
    });

    t.is(errorLogs.length, 1);
    const parsed = JSON.parse(errorLogs[0]);
    t.is(parsed.rid, 'req-err');
    t.is(parsed.evt, 'request.error');
    t.is(parsed.phase, 'tool_exec');
    t.is(parsed.error, 'something broke');
});

// --- logEventDebug (debug level) ---

test('logEventDebug routes through logger.debug', t => {
    const debugLogs = captureLogs('debug', () => {
        logEventDebug('req-dbg', 'compression.tool', { type: 'tool_result', toolCallId: 'tc-1', chars: 3000 });
    });

    t.is(debugLogs.length, 1);
    const parsed = JSON.parse(debugLogs[0]);
    t.is(parsed.rid, 'req-dbg');
    t.is(parsed.evt, 'compression.tool');
    t.is(parsed.type, 'tool_result');
    t.is(parsed.toolCallId, 'tc-1');
    t.is(parsed.chars, 3000);
});

// --- Edge cases ---

test('logEvent handles boolean and numeric data correctly', t => {
    const logs = captureLogs('info', () => {
        logEvent('req-1', 'tool.exec', {
            success: false,
            durationMs: 0,
            truncated: true,
            resultChars: 0,
        });
    });

    const parsed = JSON.parse(logs[0]);
    t.false(parsed.success);
    t.is(parsed.durationMs, 0);
    t.true(parsed.truncated);
    t.is(parsed.resultChars, 0);
});

test('logEvent handles null requestId gracefully', t => {
    const logs = captureLogs('info', () => {
        logEvent(null, 'request.start', { entity: 'test' });
    });

    const parsed = JSON.parse(logs[0]);
    t.is(parsed.rid, null);
    t.is(parsed.evt, 'request.start');
});

test('all three functions produce identical JSON shape', t => {
    const infoLogs = captureLogs('info', () => {
        logEvent('r1', 'evt1', { key: 'val' });
    });
    const errorLogs = captureLogs('error', () => {
        logEventError('r2', 'evt2', { key: 'val' });
    });
    const debugLogs = captureLogs('debug', () => {
        logEventDebug('r3', 'evt3', { key: 'val' });
    });

    const p1 = JSON.parse(infoLogs[0]);
    const p2 = JSON.parse(errorLogs[0]);
    const p3 = JSON.parse(debugLogs[0]);

    // All have same keys
    const keys1 = Object.keys(p1).sort();
    const keys2 = Object.keys(p2).sort();
    const keys3 = Object.keys(p3).sort();
    t.deepEqual(keys1, keys2);
    t.deepEqual(keys1, keys3);
});
