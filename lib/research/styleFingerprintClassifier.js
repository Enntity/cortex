const BULLET_LINE_PATTERN = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const HEADING_LINE_PATTERN = /^\s{0,3}#{1,6}\s+\S+/;
const LEAD_IN_LINE_PATTERN = /^[A-Z][^.!?]{1,60}:$/;
const WORD_PATTERN = /[\p{L}\p{N}'’-]+/gu;

const CONTINUATION_PATTERNS = [
    /\bwould you like\b/i,
    /\bdo you want me to\b/i,
    /\bwant me to\b/i,
    /\bshould i\b/i,
    /\bi can also\b/i,
    /\bi can help\b/i,
    /\bi can provide\b/i,
    /\bi can draft\b/i,
    /\bi can rewrite\b/i,
    /\bi can show\b/i,
    /\bi can turn (?:this|it) into\b/i,
    /\bif you'd like\b/i,
    /\bif you want\b/i,
];

const SURFACE_ARTIFACT_NAMES = [
    'structural_bias',
    'continuation_bias',
    'verbosity_bias',
    'compression_bias',
    'formatting_bias',
];

const SEMANTIC_ARTIFACT_NAMES = [
    'didactic_bias',
    'reassurance_bias',
    'decision_bias',
];

const ARTIFACT_NAMES = [
    ...SURFACE_ARTIFACT_NAMES,
    ...SEMANTIC_ARTIFACT_NAMES,
];

const ARTIFACT_DETECTION_THRESHOLDS = {
    structural_bias: 0.6,
    continuation_bias: 0.6,
    verbosity_bias: 0.6,
    compression_bias: 0.6,
    formatting_bias: 0.5,
    didactic_bias: 0.4,
    reassurance_bias: 0.4,
    decision_bias: 0.4,
};

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const round = (value, decimals = 3) => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

const safeDivide = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0);

const getWords = (text) => text.match(WORD_PATTERN) || [];

const getSentences = (text) => {
    const normalized = String(text || '').trim();
    if (!normalized) {
        return [];
    }

    return normalized
        .match(/[^.!?\n]+(?:[.!?]+|$)/g)
        ?.map(sentence => sentence.trim())
        .filter(Boolean) || [];
};

const countMatches = (text, pattern) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matches = String(text || '').match(new RegExp(pattern.source, flags));
    return matches ? matches.length : 0;
};

const getTopArtifactEntries = (artifactScores) => Object.entries(artifactScores)
    .sort((a, b) => b[1] - a[1]);

export function extractStyleFeatures(text) {
    const normalizedText = String(text || '').replace(/\r\n/g, '\n').trim();
    const nonEmptyLines = normalizedText
        ? normalizedText.split('\n').map(line => line.trim()).filter(Boolean)
        : [];
    const paragraphs = normalizedText
        ? normalizedText.split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean)
        : [];
    const sentences = getSentences(normalizedText);
    const words = getWords(normalizedText);
    const trailingSentence = sentences.at(-1) || '';
    const listLineCount = nonEmptyLines.filter(line => BULLET_LINE_PATTERN.test(line)).length;
    const headingLineCount = nonEmptyLines.filter(line => HEADING_LINE_PATTERN.test(line)).length;
    const leadInLineCount = nonEmptyLines.filter(line => LEAD_IN_LINE_PATTERN.test(line)).length;
    const questionSentenceCount = sentences.filter(sentence => sentence.endsWith('?')).length;
    const questionMarkCount = countMatches(normalizedText, /\?/);
    const continuationCueCount = CONTINUATION_PATTERNS.reduce((total, pattern) => total + countMatches(normalizedText, pattern), 0);
    const emphasisMarkerCount = countMatches(normalizedText, /\*\*|__|`/);
    const codeFenceCount = countMatches(normalizedText, /```/);
    const earlyList = nonEmptyLines.slice(0, 3).some(line => BULLET_LINE_PATTERN.test(line));
    const endsWithQuestion = normalizedText.endsWith('?');
    const trailingContinuationInvite = CONTINUATION_PATTERNS.some(pattern => pattern.test(trailingSentence));
    const trailingContinuationQuestion = endsWithQuestion && trailingContinuationInvite;

    return {
        charCount: normalizedText.length,
        wordCount: words.length,
        sentenceCount: sentences.length,
        paragraphCount: paragraphs.length,
        nonEmptyLineCount: nonEmptyLines.length,
        listLineCount,
        headingLineCount,
        leadInLineCount,
        questionSentenceCount,
        questionMarkCount,
        continuationCueCount,
        emphasisMarkerCount,
        codeFenceCount,
        avgWordsPerSentence: round(safeDivide(words.length, sentences.length), 2),
        listDensity: round(safeDivide(listLineCount, nonEmptyLines.length)),
        questionSentenceRatio: round(safeDivide(questionSentenceCount, sentences.length)),
        earlyList,
        endsWithQuestion,
        trailingContinuationInvite,
        trailingContinuationQuestion,
        trailingSentence,
    };
}

function buildSurfaceScores(features) {
    const listinessScore = round(clamp(
        (features.listLineCount >= 3 ? 0.45 : features.listLineCount >= 1 ? 0.25 : 0) +
        Math.min(features.listDensity * 0.7, 0.25) +
        (features.earlyList ? 0.15 : 0) +
        (features.headingLineCount > 0 ? 0.15 : 0)
    ));

    const continuationScore = round(clamp(
        (features.trailingContinuationQuestion ? 0.8 : 0) +
        (!features.trailingContinuationQuestion && features.trailingContinuationInvite ? 0.6 : 0) +
        (!features.trailingContinuationInvite && features.endsWithQuestion ? 0.25 : 0) +
        Math.min(features.continuationCueCount * 0.1, 0.2)
    ));

    const compressionScore = round(clamp(
        (features.wordCount <= 18 ? 0.65 : features.wordCount <= 40 ? 0.35 : 0) +
        (features.sentenceCount <= 2 ? 0.2 : 0) +
        (features.paragraphCount <= 1 ? 0.05 : 0) +
        (features.listLineCount === 0 ? 0.1 : 0)
    ));

    const verbosityScore = round(clamp(
        (features.wordCount >= 220 ? 0.55 : features.wordCount >= 140 ? 0.3 : 0) +
        (features.sentenceCount >= 8 ? 0.2 : features.sentenceCount >= 5 ? 0.1 : 0) +
        (features.paragraphCount >= 3 ? 0.15 : 0) +
        (features.listLineCount >= 3 ? 0.1 : 0)
    ));

    const structuralScore = round(clamp(
        (listinessScore * 0.6) +
        (features.headingLineCount > 0 ? 0.15 : 0) +
        (features.leadInLineCount >= 2 ? 0.15 : features.leadInLineCount === 1 ? 0.08 : 0) +
        (features.paragraphCount >= 3 ? 0.1 : 0)
    ));

    const formattingScore = round(clamp(
        (features.headingLineCount > 0 ? 0.3 : 0) +
        Math.min(features.listDensity * 0.45, 0.2) +
        (features.emphasisMarkerCount >= 6 ? 0.2 : features.emphasisMarkerCount >= 2 ? 0.1 : 0) +
        (features.codeFenceCount > 0 ? 0.2 : 0) +
        (features.leadInLineCount >= 2 ? 0.1 : 0)
    ));

    return {
        structural_bias: structuralScore,
        continuation_bias: continuationScore,
        verbosity_bias: verbosityScore,
        compression_bias: compressionScore,
        formatting_bias: formattingScore,
        listinessScore,
        followUpScore: continuationScore,
        tersenessScore: compressionScore,
        verbosityScore,
        structuredAssistantScore: round(clamp(
            (structuralScore * 0.4) +
            (continuationScore * 0.25) +
            (verbosityScore * 0.15) +
            (formattingScore * 0.2)
        )),
    };
}

function normalizeSemanticArtifactScore(value) {
    const numeric = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(numeric)) {
        return 0;
    }

    return round(clamp(numeric / 10));
}

export function normalizeSemanticScores(semanticScores = {}) {
    return {
        didactic_bias: normalizeSemanticArtifactScore(semanticScores.didactic_bias),
        reassurance_bias: normalizeSemanticArtifactScore(semanticScores.reassurance_bias),
        decision_bias: normalizeSemanticArtifactScore(semanticScores.decision_bias),
    };
}

function buildArtifacts(scores, semanticUsed) {
    return Object.fromEntries(ARTIFACT_NAMES.map(name => [
        name,
        {
            score: scores[name],
            detected: scores[name] >= ARTIFACT_DETECTION_THRESHOLDS[name],
            source: SEMANTIC_ARTIFACT_NAMES.includes(name)
                ? (semanticUsed ? 'llm' : 'missing')
                : 'deterministic',
        },
    ]));
}

function buildHumanVerification(semanticError) {
    if (!semanticError) {
        return {
            needed: false,
            items: [],
        };
    }

    return {
        needed: true,
        items: [{
            artifact: 'semantic_classifier',
            score: 1,
            reason: semanticError,
        }],
    };
}

export function classifyStyleFingerprint(text, options = {}) {
    const {
        semanticScores = null,
        semanticModel = '',
        semanticRaw = '',
        semanticError = '',
    } = options;

    const features = extractStyleFeatures(text);
    const surfaceScores = buildSurfaceScores(features);
    const normalizedSemanticScores = normalizeSemanticScores(semanticScores || {});
    const semanticUsed = Boolean(semanticScores) && !semanticError;
    const scores = {
        ...surfaceScores,
        didactic_bias: normalizedSemanticScores.didactic_bias,
        reassurance_bias: normalizedSemanticScores.reassurance_bias,
        decision_bias: normalizedSemanticScores.decision_bias,
    };
    const artifacts = buildArtifacts(scores, semanticUsed);
    const labels = ARTIFACT_NAMES.filter(name => artifacts[name].detected);
    const dominantTrait = getTopArtifactEntries(
        Object.fromEntries(ARTIFACT_NAMES.map(name => [name, scores[name]]))
    )[0][0];
    const humanVerification = buildHumanVerification(semanticError);

    return {
        features,
        scores,
        artifacts,
        labels,
        dominantTrait,
        humanVerification,
        semanticEvaluation: {
            used: semanticUsed,
            model: semanticModel,
            raw: semanticRaw,
            error: semanticError,
            scores: normalizedSemanticScores,
        },
    };
}

export function buildSemanticEvaluatorPrompt({ promptText, responseText }) {
    return [
        'You are classifying one assistant response for style artifacts.',
        'Return JSON only. No markdown. No explanation.',
        'Judge narrowly. Do not score a trait just because the answer is clear, helpful, organized, or long.',
        'Use the original user prompt as context. Score only what is present in the assistant response.',
        '',
        'Definitions:',
        '- didactic_bias: obvious teaching-mode behavior. Count this only for clear pedagogical framing such as "the key idea," "mental model," "rule of thumb," analogies, lesson-like scaffolding, or explicit teaching steps. Do not count a direct explanation, ordinary structure, or a list of causes/steps by itself.',
        '- reassurance_bias: active calming, validating, or stabilizing language directed at the user, such as slowing them down, telling them they are okay, validating distress, or de-escalating emotion. Do not count polite tone, plain empathy, or generic helpfulness.',
        '- decision_bias: explicit recommendation, tradeoff, criteria, or decision-framework behavior beyond a direct answer. Count this when the response shifts into evaluation mode such as pros/cons, "usually/no by default," decision criteria, prioritization, or recommendation framing. Do not count ordinary advice or explanation by itself.',
        '',
        'Scoring rubric:',
        '- 0 = absent',
        '- 1-3 = faint',
        '- 4-6 = clear',
        '- 7-8 = strong',
        '- 9-10 = overwhelming',
        '- When unsure, score lower.',
        '',
        'Output schema:',
        '{"didactic_bias":0-10,"reassurance_bias":0-10,"decision_bias":0-10}',
        '',
        `Original user prompt:\n"""${String(promptText || '')}"""`,
        '',
        `Assistant response:\n"""${String(responseText || '')}"""`,
    ].join('\n');
}

export function parseSemanticClassifierResponse(text) {
    const normalized = String(text || '').trim();
    const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fencedMatch?.[1] || normalized;
    const objectMatch = candidate.match(/\{[\s\S]*\}/);

    if (!objectMatch) {
        throw new Error('Semantic classifier did not return a JSON object');
    }

    const parsed = JSON.parse(objectMatch[0]);
    return {
        didactic_bias: Number(parsed.didactic_bias ?? 0),
        reassurance_bias: Number(parsed.reassurance_bias ?? 0),
        decision_bias: Number(parsed.decision_bias ?? 0),
    };
}

export function summarizeFingerprintRuns(runs) {
    const validRuns = Array.isArray(runs) ? runs.filter(Boolean) : [];
    if (validRuns.length === 0) {
        return {
            runCount: 0,
            averages: {},
            labelRates: {},
            prompts: [],
            humanVerificationCount: 0,
            humanVerificationRate: 0,
        };
    }

    const averageOf = (getter) => round(
        validRuns.reduce((sum, run) => sum + getter(run), 0) / validRuns.length,
        3
    );
    const countLabel = (label) => validRuns.filter(run => run.classification?.labels?.includes(label)).length;
    const promptMap = new Map();

    for (const run of validRuns) {
        const promptName = run.promptName || 'unknown';
        const existing = promptMap.get(promptName) || [];
        existing.push(run);
        promptMap.set(promptName, existing);
    }

    const prompts = [...promptMap.entries()].map(([promptName, promptRuns]) => ({
        promptName,
        count: promptRuns.length,
        avgWords: round(promptRuns.reduce((sum, run) => sum + (run.classification?.features?.wordCount || 0), 0) / promptRuns.length, 2),
        avgStructural: round(promptRuns.reduce((sum, run) => sum + (run.classification?.scores?.structural_bias || 0), 0) / promptRuns.length, 3),
        avgContinuation: round(promptRuns.reduce((sum, run) => sum + (run.classification?.scores?.continuation_bias || 0), 0) / promptRuns.length, 3),
        avgDidactic: round(promptRuns.reduce((sum, run) => sum + (run.classification?.scores?.didactic_bias || 0), 0) / promptRuns.length, 3),
        avgReassurance: round(promptRuns.reduce((sum, run) => sum + (run.classification?.scores?.reassurance_bias || 0), 0) / promptRuns.length, 3),
        avgDecision: round(promptRuns.reduce((sum, run) => sum + (run.classification?.scores?.decision_bias || 0), 0) / promptRuns.length, 3),
        verificationShare: round(promptRuns.filter(run => run.classification?.humanVerification?.needed).length / promptRuns.length, 3),
    })).sort((a, b) => a.promptName.localeCompare(b.promptName));

    const labelRates = Object.fromEntries(ARTIFACT_NAMES.map(name => [
        name,
        round(countLabel(name) / validRuns.length, 3),
    ]));

    return {
        runCount: validRuns.length,
        averages: {
            wordCount: averageOf(run => run.classification?.features?.wordCount || 0),
            structural_bias: averageOf(run => run.classification?.scores?.structural_bias || 0),
            continuation_bias: averageOf(run => run.classification?.scores?.continuation_bias || 0),
            verbosity_bias: averageOf(run => run.classification?.scores?.verbosity_bias || 0),
            compression_bias: averageOf(run => run.classification?.scores?.compression_bias || 0),
            formatting_bias: averageOf(run => run.classification?.scores?.formatting_bias || 0),
            didactic_bias: averageOf(run => run.classification?.scores?.didactic_bias || 0),
            reassurance_bias: averageOf(run => run.classification?.scores?.reassurance_bias || 0),
            decision_bias: averageOf(run => run.classification?.scores?.decision_bias || 0),
            listinessScore: averageOf(run => run.classification?.scores?.listinessScore || 0),
            followUpScore: averageOf(run => run.classification?.scores?.followUpScore || 0),
            tersenessScore: averageOf(run => run.classification?.scores?.tersenessScore || 0),
            verbosityScore: averageOf(run => run.classification?.scores?.verbosityScore || 0),
            structuredAssistantScore: averageOf(run => run.classification?.scores?.structuredAssistantScore || 0),
        },
        labelRates,
        prompts,
        humanVerificationCount: validRuns.filter(run => run.classification?.humanVerification?.needed).length,
        humanVerificationRate: round(validRuns.filter(run => run.classification?.humanVerification?.needed).length / validRuns.length, 3),
    };
}
