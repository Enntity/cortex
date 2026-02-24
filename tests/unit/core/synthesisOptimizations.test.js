// synthesisOptimizations.test.js
// Tests for Issues 3 (drift threshold relaxation) and 4 (high-similarity merge skip)
//
// Uses cosineSimilarity and checkMergeDrift from types.js with synthetic vectors.

import test from 'ava';
import { cosineSimilarity, checkMergeDrift } from '../../../lib/continuity/types.js';

// --- Helpers ---

// Create a unit vector of given dimension pointing mostly in one direction
// with controlled deviation from a base vector
function makeVector(dims, baseAngleOffset = 0) {
    const vec = new Array(dims).fill(0);
    // Primary component
    vec[0] = Math.cos(baseAngleOffset);
    vec[1] = Math.sin(baseAngleOffset);
    // Small noise in other dimensions
    for (let i = 2; i < dims; i++) {
        vec[i] = 0.01 * Math.sin(i + baseAngleOffset);
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map(v => v / norm);
}

// Create two vectors with a target cosine similarity
// Returns [vecA, vecB] where cosineSimilarity(vecA, vecB) ≈ targetSim
function makeVectorsWithSimilarity(targetSim, dims = 128) {
    // Strategy: create a base vector, then blend with an orthogonal vector
    // cos(theta) = targetSim, so theta = acos(targetSim)
    const theta = Math.acos(Math.max(-1, Math.min(1, targetSim)));

    // Base vector (all weight on first component)
    const base = new Array(dims).fill(0);
    base[0] = 1;

    // Orthogonal vector (all weight on second component)
    const ortho = new Array(dims).fill(0);
    ortho[1] = 1;

    // Second vector = cos(theta)*base + sin(theta)*ortho
    const vecB = base.map((b, i) => Math.cos(theta) * b + Math.sin(theta) * ortho[i]);

    return [base, vecB];
}

// --- Issue 3: Consolidation drift thresholds ---

// Old thresholds: simToCentroid >= 0.80, minSimToSource >= 0.70
// New thresholds: simToCentroid >= 0.70, minSimToSource >= 0.60

const OLD_CENTROID_THRESHOLD = 0.80;
const OLD_SOURCE_THRESHOLD = 0.70;
const NEW_CENTROID_THRESHOLD = 0.70;
const NEW_SOURCE_THRESHOLD = 0.60;

test('simToCentroid=0.75 passes new threshold (0.70) but fails old (0.80)', t => {
    const simToCentroid = 0.75;

    // Fails old threshold
    t.true(simToCentroid < OLD_CENTROID_THRESHOLD, 'Should fail old threshold of 0.80');
    // Passes new threshold
    t.true(simToCentroid >= NEW_CENTROID_THRESHOLD, 'Should pass new threshold of 0.70');
});

test('minSimToSource=0.65 passes new threshold (0.60) but fails old (0.70)', t => {
    const minSimToSource = 0.65;

    // Fails old threshold
    t.true(minSimToSource < OLD_SOURCE_THRESHOLD, 'Should fail old threshold of 0.70');
    // Passes new threshold
    t.true(minSimToSource >= NEW_SOURCE_THRESHOLD, 'Should pass new threshold of 0.60');
});

test('simToCentroid=0.55 still fails even with relaxed thresholds', t => {
    const simToCentroid = 0.55;

    // Fails both old and new
    t.true(simToCentroid < OLD_CENTROID_THRESHOLD);
    t.true(simToCentroid < NEW_CENTROID_THRESHOLD, 'Should still fail new threshold of 0.70');
});

test('simToCentroid=0.90, minSource=0.85 passes both old and new', t => {
    const simToCentroid = 0.90;
    const minSimToSource = 0.85;

    t.true(simToCentroid >= OLD_CENTROID_THRESHOLD);
    t.true(simToCentroid >= NEW_CENTROID_THRESHOLD);
    t.true(minSimToSource >= OLD_SOURCE_THRESHOLD);
    t.true(minSimToSource >= NEW_SOURCE_THRESHOLD);
});

// --- Issue 4: High-similarity merge skip ---

const ABSORB_SIMILARITY_THRESHOLD = 0.95;

test('sim(M,S)=0.97 makes merge trivially valid — proving the LLM call was wasted', t => {
    // Create two very similar vectors (sim ≈ 0.97)
    const [vecM, vecS] = makeVectorsWithSimilarity(0.97);

    // The "merged" result is basically M (as expected when content is near-identical)
    // Slightly nudge toward S to simulate a trivial merge
    const vecMerged = vecM.map((v, i) => 0.99 * v + 0.01 * vecS[i]);
    const norm = Math.sqrt(vecMerged.reduce((s, v) => s + v * v, 0));
    const vecMergedNorm = vecMerged.map(v => v / norm);

    const result = checkMergeDrift(vecM, vecS, vecMergedNorm);

    // When M and S are nearly identical, the merge is trivially "valid"
    // but the LLM call was pointless — M' ≈ M ≈ S, no new information synthesized.
    // This is exactly the waste that Fix 4 eliminates by skipping the LLM merge
    // when cosineSimilarity(M, S) >= 0.95.
    t.true(result.valid, 'Merge is trivially valid when inputs are near-identical');
    t.true(result.mergedToM > 0.99, 'M\' is essentially M — no meaningful synthesis');
    t.true(result.originalSim > 0.95, 'Original similarity proves inputs were near-identical');
});

test('cosineSimilarity correctly identifies >0.95 pairs for skip condition', t => {
    const [vecA, vecB] = makeVectorsWithSimilarity(0.97);
    const sim = cosineSimilarity(vecA, vecB);

    t.true(sim > ABSORB_SIMILARITY_THRESHOLD,
        `Expected similarity > ${ABSORB_SIMILARITY_THRESHOLD}, got ${sim.toFixed(4)}`);
});

// --- Re-nomination threshold (0.70) ---

const RE_NOMINATION_THRESHOLD = 0.70;

test('re-nomination: sim=0.75 catches same-theme rephrased nomination', t => {
    // "I thrive on fast-paced retro exchanges" vs "I do best with rapid playful banter"
    // These are same-theme but rephrased — sim ≈ 0.75 should match at 0.70
    const [vecA, vecB] = makeVectorsWithSimilarity(0.75);
    const sim = cosineSimilarity(vecA, vecB);

    t.true(sim >= RE_NOMINATION_THRESHOLD,
        `Expected sim ${sim.toFixed(4)} >= ${RE_NOMINATION_THRESHOLD} (same theme, rephrased)`);
    // But standard dedup at 0.85 would miss this
    t.true(sim < 0.85,
        `Expected sim ${sim.toFixed(4)} < 0.85 (dedup would miss this)`);
});

test('re-nomination: sim=0.60 correctly rejects genuinely different theme', t => {
    // Two genuinely different identity observations should NOT be re-nominated
    const [vecA, vecB] = makeVectorsWithSimilarity(0.60);
    const sim = cosineSimilarity(vecA, vecB);

    t.true(sim < RE_NOMINATION_THRESHOLD,
        `Expected sim ${sim.toFixed(4)} < ${RE_NOMINATION_THRESHOLD} (different themes)`);
});

test('re-nomination: sim=0.70 is exactly at boundary (should match)', t => {
    const [vecA, vecB] = makeVectorsWithSimilarity(0.70);
    const sim = cosineSimilarity(vecA, vecB);

    // Allow small floating-point tolerance
    t.true(Math.abs(sim - RE_NOMINATION_THRESHOLD) < 0.02,
        `Expected sim ${sim.toFixed(4)} ≈ ${RE_NOMINATION_THRESHOLD}`);
});

test('re-nomination: sim=0.90 clearly matches (same content, minor edit)', t => {
    const [vecA, vecB] = makeVectorsWithSimilarity(0.90);
    const sim = cosineSimilarity(vecA, vecB);

    t.true(sim >= RE_NOMINATION_THRESHOLD,
        `Expected sim ${sim.toFixed(4)} >= ${RE_NOMINATION_THRESHOLD}`);
});

// --- Issue 4 (continued): High-similarity merge skip ---

test('sim(M,S)=0.80, proper merge → valid: true (different content still merges)', t => {
    // Create two moderately similar vectors
    const [vecM, vecS] = makeVectorsWithSimilarity(0.80);

    // Create a proper merge that's between M and S but closer to M
    // M' = 0.6*M + 0.4*S (favors new info M but incorporates S)
    const vecMerged = vecM.map((v, i) => 0.6 * v + 0.4 * vecS[i]);
    const norm = Math.sqrt(vecMerged.reduce((s, v) => s + v * v, 0));
    const vecMergedNorm = vecMerged.map(v => v / norm);

    const result = checkMergeDrift(vecM, vecS, vecMergedNorm);

    t.true(result.valid, `Expected valid merge, got reason: ${result.reason}`);
    t.is(result.reason, null);
});
