// resonance_tracker.test.js
// Tests for the ResonanceTracker - relational health metrics from synthesis results

import test from 'ava';
import { ResonanceTracker } from '../../../lib/continuity/eidos/ResonanceTracker.js';

const tracker = new ResonanceTracker();

// ==================== BASIC COMPUTATION ====================

test('computes metrics from synthesis result with no prior data', t => {
    const result = {
        newAnchors: [{ content: 'anchor1' }],
        newArtifacts: [{ content: 'artifact1' }],
        identityUpdates: [],
        shorthands: [{ term: 'shorthand1', meaning: 'meaning1' }],
    };

    const metrics = tracker.computeMetrics(result);
    t.is(metrics.anchorRate, 1);
    t.is(metrics.shorthandRate, 1);
    t.is(metrics.trend, 'unknown');
    // attunement: relational (1 anchor + 1 shorthand) / total (1+1+0+1) = 2/3
    t.true(Math.abs(metrics.attunementRatio - 2/3) < 0.01);
});

test('returns defaults for null synthesis result', t => {
    const metrics = tracker.computeMetrics(null);
    t.is(metrics.anchorRate, 0);
    t.is(metrics.shorthandRate, 0);
    t.is(metrics.attunementRatio, 0.5);
    t.is(metrics.trend, 'unknown');
});

test('returns existing metrics when synthesis result is null', t => {
    const existing = { anchorRate: 2, shorthandRate: 1, emotionalRange: 0.5, attunementRatio: 0.7, trend: 'warming' };
    const metrics = tracker.computeMetrics(null, existing);
    t.deepEqual(metrics, existing);
});

// ==================== EMA BLENDING ====================

test('blends with existing metrics using EMA', t => {
    const existing = {
        anchorRate: 2,
        shorthandRate: 0,
        emotionalRange: 0.5,
        attunementRatio: 0.6,
        trend: 'stable',
    };

    const result = {
        newAnchors: [],
        newArtifacts: [{ content: 'a1' }],
        identityUpdates: [],
        shorthands: [],
    };

    const metrics = tracker.computeMetrics(result, existing);
    // EMA: alpha * current + (1 - alpha) * existing
    // anchorRate: 0.3 * 0 + 0.7 * 2 = 1.4
    t.true(Math.abs(metrics.anchorRate - 1.4) < 0.01, `Expected ~1.4, got ${metrics.anchorRate}`);
});

test('EMA alpha can be customized', t => {
    const customTracker = new ResonanceTracker({ emaAlpha: 0.5 });
    const existing = { anchorRate: 4, shorthandRate: 0, emotionalRange: 0, attunementRatio: 0.5, trend: 'stable' };
    const result = { newAnchors: [], newArtifacts: [], identityUpdates: [], shorthands: [] };

    const metrics = customTracker.computeMetrics(result, existing);
    // anchorRate: 0.5 * 0 + 0.5 * 4 = 2
    t.true(Math.abs(metrics.anchorRate - 2) < 0.01);
});

// ==================== TREND DETECTION ====================

test('detects warming trend', t => {
    const existing = {
        anchorRate: 0,
        shorthandRate: 0,
        emotionalRange: 0,
        attunementRatio: 0.3,
        trend: 'stable',
    };

    // Create a result with lots of relational activity
    const result = {
        newAnchors: [{ content: 'a1' }, { content: 'a2' }, { content: 'a3' }],
        newArtifacts: [],
        identityUpdates: [],
        shorthands: [{ term: 's1', meaning: 'm1' }],
    };

    const metrics = tracker.computeMetrics(result, existing);
    t.is(metrics.trend, 'warming');
});

test('detects cooling trend', t => {
    const existing = {
        anchorRate: 3,
        shorthandRate: 2,
        emotionalRange: 0.8,
        attunementRatio: 0.9,
        trend: 'warming',
    };

    // Create a result with no relational activity
    const result = {
        newAnchors: [],
        newArtifacts: [{ content: 'a1' }],
        identityUpdates: [{ content: 'i1' }],
        shorthands: [],
    };

    const metrics = tracker.computeMetrics(result, existing);
    t.is(metrics.trend, 'cooling');
});

test('detects stable trend', t => {
    const existing = {
        anchorRate: 1,
        shorthandRate: 0.5,
        emotionalRange: 0.3,
        attunementRatio: 0.5,
        trend: 'stable',
    };

    const result = {
        newAnchors: [{ content: 'a1' }],
        newArtifacts: [{ content: 'a1' }],
        identityUpdates: [],
        shorthands: [],
    };

    const metrics = tracker.computeMetrics(result, existing);
    t.is(metrics.trend, 'stable');
});

// ==================== EMOTIONAL RANGE ====================

test('emotional range counts unique valences', t => {
    const result = {
        newAnchors: [
            { content: 'a1', emotionalState: { valence: 'joy' } },
            { content: 'a2', emotionalState: { valence: 'curiosity' } },
            { content: 'a3', emotionalState: { valence: 'joy' } }, // duplicate
        ],
        newArtifacts: [],
        identityUpdates: [
            { content: 'i1', emotionalState: { valence: 'warmth' } },
        ],
        shorthands: [],
    };

    const metrics = tracker.computeMetrics(result);
    // 3 unique valences: joy, curiosity, warmth => 3/8 = 0.375
    t.true(Math.abs(metrics.emotionalRange - 0.375) < 0.01);
});

test('emotional range is 0 when no valences present', t => {
    const result = {
        newAnchors: [{ content: 'a1' }],
        newArtifacts: [],
        identityUpdates: [],
        shorthands: [],
    };

    const metrics = tracker.computeMetrics(result);
    t.is(metrics.emotionalRange, 0);
});

// ==================== EDGE CASES ====================

test('handles empty arrays in synthesis result', t => {
    const result = {
        newAnchors: [],
        newArtifacts: [],
        identityUpdates: [],
        shorthands: [],
    };

    const metrics = tracker.computeMetrics(result);
    t.is(metrics.anchorRate, 0);
    t.is(metrics.shorthandRate, 0);
    t.is(metrics.attunementRatio, 0.5); // default when total is 0
});

test('handles missing arrays in synthesis result', t => {
    const metrics = tracker.computeMetrics({});
    t.is(metrics.anchorRate, 0);
    t.is(metrics.shorthandRate, 0);
});
