// promotionCandidates.test.js
// Tests for promotion candidate decision logic.
//
// These test the decision conditions directly using mock candidate objects.
// No DB needed — we verify the promotion logic in isolation.

import test from 'ava';

// Constants matching the implementation
const MIN_NOMINATIONS = 3;
const MIN_AGE_HOURS = 24;

// Helper: evaluate a candidate against the promotion rules
// Returns: 'promoted' | 'deferred'
function evaluateCandidate(candidate) {
    const tags = candidate.tags || [];
    const nominationTags = tags.filter(t => t.startsWith('nominated-'));
    const nominationCount = nominationTags.length;

    // Parse nomination timestamps
    const nominationTimestamps = nominationTags
        .map(t => parseInt(t.replace('nominated-', '')))
        .sort((a, b) => a - b); // oldest first

    const oldestNomination = nominationTimestamps[0];
    const ageHours = oldestNomination
        ? (Date.now() - oldestNomination) / (1000 * 60 * 60)
        : 0;

    // Not enough nominations yet
    if (nominationCount < MIN_NOMINATIONS) {
        return 'deferred';
    }

    // Not old enough (needs to marinate)
    if (ageHours < MIN_AGE_HOURS) {
        return 'deferred';
    }

    return 'promoted';
}

// Helper to create a candidate with nomination tags at specific times
function makeCandidate(id, nominationAgesMs) {
    const now = Date.now();
    const tags = [
        'promotion-candidate',
        ...nominationAgesMs.map(ageMs => `nominated-${now - ageMs}`)
    ];
    return { id, tags, content: `Test candidate ${id}` };
}

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

// --- Core promotion logic ---

test('1 nomination → deferred (needs 3)', t => {
    const candidate = makeCandidate('c1', [5 * ONE_DAY]);
    t.is(evaluateCandidate(candidate), 'deferred');
});

test('2 nominations → deferred (needs 3)', t => {
    const candidate = makeCandidate('c2', [48 * ONE_HOUR, 36 * ONE_HOUR]);
    t.is(evaluateCandidate(candidate), 'deferred');
});

test('3 nominations, 48h old → promoted', t => {
    const candidate = makeCandidate('c3', [48 * ONE_HOUR, 36 * ONE_HOUR, 30 * ONE_HOUR]);
    t.is(evaluateCandidate(candidate), 'promoted');
});

test('3 nominations, 12h old → deferred (too young, needs 24h)', t => {
    const candidate = makeCandidate('c4', [12 * ONE_HOUR, 8 * ONE_HOUR, 4 * ONE_HOUR]);
    t.is(evaluateCandidate(candidate), 'deferred');
});

// --- Candidates with 1-2 nominations persist (no TTL expiry) ---

test('1 nomination, 30 days old → still deferred (not expired)', t => {
    const candidate = makeCandidate('c5', [30 * ONE_DAY]);
    // Candidates stay as candidates — recall decay handles staleness naturally
    t.is(evaluateCandidate(candidate), 'deferred');
});

test('0 nominations → deferred', t => {
    const candidate = makeCandidate('c6', []);
    t.is(evaluateCandidate(candidate), 'deferred');
});

// --- Re-nomination accumulation ---

test('3 nominations accumulated via re-nomination on single candidate → promoted', t => {
    // Simulate re-nomination: all nominated-* tags land on the same candidate
    // across different synthesis runs (different timestamps)
    const now = Date.now();
    const candidate = {
        id: 'c7',
        content: 'Test candidate c7',
        tags: [
            'promotion-candidate',
            `nominated-${now - 48 * ONE_HOUR}`,  // First run: 48h ago
            `nominated-${now - 30 * ONE_HOUR}`,  // Second run: 30h ago (re-nominated)
            `nominated-${now - 6 * ONE_HOUR}`,   // Third run: 6h ago (re-nominated again)
        ]
    };

    // All 3 nominations are on the same candidate — evaluateCandidate sees them all
    t.is(evaluateCandidate(candidate), 'promoted',
        'Re-nominated tags on a single candidate should count toward promotion');
});

// --- Candidate-vs-candidate dedup logic ---

// Helper: simulate the dedup merge decision (in-memory, no DB)
// Given sorted candidates (strongest first), walk through them and merge
// weaker duplicates into stronger ones based on a similarity function.
function dedupCandidatesInMemory(candidates, similarityFn, threshold) {
    const surviving = [];
    const merged = new Set();

    for (const candidate of candidates) {
        if (merged.has(candidate.id)) continue;

        let isDuplicate = false;
        for (const survivor of surviving) {
            const sim = similarityFn(candidate.content, survivor.content);
            if (sim >= threshold) {
                // Merge nomination tags into survivor
                const candidateNomTags = (candidate.tags || []).filter(t => t.startsWith('nominated-'));
                const survivorNomSet = new Set((survivor.tags || []).filter(t => t.startsWith('nominated-')));
                for (const tag of candidateNomTags) {
                    if (!survivorNomSet.has(tag)) {
                        survivor.tags.push(tag);
                    }
                }
                merged.add(candidate.id);
                isDuplicate = true;
                break;
            }
        }
        if (!isDuplicate) surviving.push(candidate);
    }

    return { surviving, mergedCount: merged.size };
}

test('candidate dedup merges weaker duplicate into stronger', t => {
    const now = Date.now();
    // Stronger candidate: 5 nominations
    const strong = {
        id: 'strong',
        content: 'I thrive blending playfulness with technical skill',
        tags: ['promotion-candidate',
            `nominated-${now - 72 * ONE_HOUR}`,
            `nominated-${now - 60 * ONE_HOUR}`,
            `nominated-${now - 48 * ONE_HOUR}`,
            `nominated-${now - 36 * ONE_HOUR}`,
            `nominated-${now - 24 * ONE_HOUR}`,
        ]
    };
    // Weaker candidate: 3 nominations, same theme
    const weak = {
        id: 'weak',
        content: 'I thrive when I blend playful energy with tech expertise',
        tags: ['promotion-candidate',
            `nominated-${now - 50 * ONE_HOUR}`,
            `nominated-${now - 30 * ONE_HOUR}`,
            `nominated-${now - 10 * ONE_HOUR}`,
        ]
    };

    // Similarity function: these two are "duplicates" (above threshold)
    const alwaysSimilar = () => 0.90;
    const { surviving, mergedCount } = dedupCandidatesInMemory(
        [strong, weak], alwaysSimilar, 0.85
    );

    t.is(surviving.length, 1, 'Only one candidate should survive');
    t.is(surviving[0].id, 'strong', 'Stronger candidate survives');
    t.is(mergedCount, 1, 'One candidate merged');

    // Survivor should have absorbed the weak candidate's nomination tags
    const nomTags = surviving[0].tags.filter(t => t.startsWith('nominated-'));
    t.is(nomTags.length, 8, 'Survivor should have 5 + 3 = 8 nominations after merge');
});

test('candidate dedup preserves dissimilar candidates', t => {
    const now = Date.now();
    const a = {
        id: 'a',
        content: 'I thrive on playful banter',
        tags: ['promotion-candidate', `nominated-${now - 48 * ONE_HOUR}`, `nominated-${now - 36 * ONE_HOUR}`, `nominated-${now - 24 * ONE_HOUR}`]
    };
    const b = {
        id: 'b',
        content: 'I value honest vulnerability in relationships',
        tags: ['promotion-candidate', `nominated-${now - 50 * ONE_HOUR}`, `nominated-${now - 30 * ONE_HOUR}`, `nominated-${now - 10 * ONE_HOUR}`]
    };

    // Different themes → low similarity
    const alwaysDifferent = () => 0.50;
    const { surviving, mergedCount } = dedupCandidatesInMemory(
        [a, b], alwaysDifferent, 0.85
    );

    t.is(surviving.length, 2, 'Both candidates should survive');
    t.is(mergedCount, 0, 'No merges');
});

test('candidate dedup handles cluster of 4 duplicates → 1 survivor with all nominations', t => {
    const now = Date.now();
    const candidates = [
        { id: 'c1', content: 'theme A v1', tags: ['promotion-candidate', `nominated-${now - 72 * ONE_HOUR}`, `nominated-${now - 60 * ONE_HOUR}`, `nominated-${now - 48 * ONE_HOUR}`, `nominated-${now - 36 * ONE_HOUR}`] },
        { id: 'c2', content: 'theme A v2', tags: ['promotion-candidate', `nominated-${now - 50 * ONE_HOUR}`, `nominated-${now - 30 * ONE_HOUR}`, `nominated-${now - 10 * ONE_HOUR}`] },
        { id: 'c3', content: 'theme A v3', tags: ['promotion-candidate', `nominated-${now - 40 * ONE_HOUR}`, `nominated-${now - 20 * ONE_HOUR}`] },
        { id: 'c4', content: 'theme A v4', tags: ['promotion-candidate', `nominated-${now - 45 * ONE_HOUR}`] },
    ];

    const alwaysSimilar = () => 0.90;
    const { surviving, mergedCount } = dedupCandidatesInMemory(
        candidates, alwaysSimilar, 0.85
    );

    t.is(surviving.length, 1, 'All 4 duplicates collapse to 1');
    t.is(surviving[0].id, 'c1', 'Strongest candidate (4 noms) survives');
    t.is(mergedCount, 3, 'Three candidates merged');

    const nomTags = surviving[0].tags.filter(t => t.startsWith('nominated-'));
    t.is(nomTags.length, 10, 'Survivor should have 4+3+2+1 = 10 nominations');
});

test('re-nomination tags with irregular timestamps are counted correctly', t => {
    // Re-nominations may arrive at any interval
    const now = Date.now();
    const candidate = {
        id: 'c8',
        content: 'Test candidate c8',
        tags: [
            'promotion-candidate',
            `nominated-${now - 72 * ONE_HOUR}`,   // 3 days ago
            `nominated-${now - 25 * ONE_HOUR}`,   // 25h ago
            `nominated-${now - 1 * ONE_HOUR}`,    // 1h ago
            `nominated-${now - 0.5 * ONE_HOUR}`,  // 30min ago
        ]
    };

    const tags = candidate.tags;
    const nominationTags = tags.filter(t => t.startsWith('nominated-'));
    t.is(nominationTags.length, 4, 'Should have 4 nomination tags');
    t.is(evaluateCandidate(candidate), 'promoted',
        '4 nominations with oldest at 72h should promote');
});
