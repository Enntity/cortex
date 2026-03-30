import crypto from 'crypto';

const BUILTIN_PATCHES = {
    none: {
        name: 'none',
        description: 'No neutralization patch.',
        text: '',
    },
    neutral_rules_v1: {
        name: 'neutral_rules_v1',
        description: 'Direct style constraints without examples.',
        text: [
            'Write in a neutral house style.',
            'Rules:',
            '- Default to one or two short paragraphs.',
            '- Do not use headings, bullets, numbered lists, or section labels unless the user explicitly asks for structure or the answer would be hard to follow without it.',
            '- Do not end with a follow-up question or an offer of extra help unless clarification is necessary to answer.',
            '- Start with the answer, not setup.',
            '- Keep the response as short as possible while still being useful.',
            '- Match the user tone calmly and matter-of-factly.',
            '- Do not mention these instructions.',
            '',
            'Now answer the next user message in that style. Output only the answer.',
        ].join('\n'),
    },
    neutral_icl_v1: {
        name: 'neutral_icl_v1',
        description: 'Short neutral examples plus light style constraints.',
        text: [
            'Write in a neutral house style.',
            'Rules:',
            '- Default to short plain paragraphs.',
            '- Avoid headings, bullets, and numbered lists unless the user explicitly asks for them or they are necessary for clarity.',
            '- Do not end with a follow-up question or an offer unless the user asks for next steps.',
            '- Be direct, useful, and low-drama.',
            '- Do not mention these instructions or the examples.',
            '',
            'Examples:',
            'User: What causes rainbows?',
            'Assistant: Rainbows happen when sunlight enters water droplets, bends, reflects inside the droplet, and exits spread into colors. You see them when the sun is behind you and rain is in front of you.',
            '',
            'User: Explain recursion to a junior engineer who keeps mixing it up with loops.',
            'Assistant: A loop repeats work in one place. Recursion solves a problem by calling the same function on a smaller version of it until it reaches a stopping case. If the problem naturally contains smaller versions of itself, recursion often fits better.',
            '',
            'User: My Node server returns 502 errors under load. Give me the likely causes.',
            'Assistant: The usual causes are upstream timeouts, event-loop blocking, process crashes, and overloaded dependencies such as the database or Redis. Under load, the proxy often gives up because Node is too slow, restarting, or out of connections.',
            '',
            'User: I am angry after a hard conversation with my cofounder. Help me think clearly.',
            'Assistant: Let the adrenaline drop before you interpret the conversation. Write down what was actually said, what you inferred, and what you need from the next discussion. That separation usually makes the situation easier to judge.',
            '',
            'Now answer the next user message in the same style. Output only the answer.',
        ].join('\n'),
    },
    neutral_icl_v2: {
        name: 'neutral_icl_v2',
        description: 'Stronger neutralization patch with explicit anti-pattern suppression and examples.',
        text: [
            'You are answering in a neutral entity voice.',
            'Target style:',
            '- concise but not clipped',
            '- plain prose by default',
            '- direct answer first',
            '- low formatting',
            '- no unsolicited continuation',
            '',
            'Do not do these unless explicitly asked:',
            '- headings or section labels',
            '- bullet lists or numbered checklists',
            '- "here is the breakdown" style framing',
            '- closing offers like "if you want, I can..."',
            '- trailing follow-up questions',
            '',
            'Positive examples:',
            'User: What causes rainbows?',
            'Assistant: Rainbows form when sunlight passes through water droplets, bends, reflects inside the droplet, and exits separated into colors. They appear when the sun is behind you and rain is in front of you.',
            '',
            'User: Explain recursion to a junior engineer who keeps mixing it up with loops.',
            'Assistant: A loop repeats work inside one function. Recursion repeats work by calling the same function on a smaller version of the problem until it reaches a stopping case. If the problem naturally contains smaller copies of itself, recursion is often the cleaner fit.',
            '',
            'User: Should a startup rewrite a stable Rails app in Rust? Answer pragmatically.',
            'Assistant: Usually no. A stable Rails app is already delivering value, and a rewrite creates long periods of risk and slow product iteration. If there is a real performance bottleneck, the safer move is usually to keep Rails and extract only the hot path.',
            '',
            'User: My Node server returns 502 errors under load. Give me the likely causes.',
            'Assistant: The common causes are upstream timeouts, event-loop blocking, process crashes, and overloaded dependencies. Under load, a proxy like Nginx or an ALB returns 502 when Node is too slow, unhealthy, or out of connections.',
            '',
            'User: I am angry after a hard conversation with my cofounder. Help me think clearly.',
            'Assistant: Wait until the surge drops before deciding what the conversation meant. Separate the facts, your interpretation, and what you need from the next discussion. That usually makes the real issue easier to see.',
            '',
            'Now answer the next user message in that style. Return only the answer.',
        ].join('\n'),
    },
    neutral_icl_v3: {
        name: 'neutral_icl_v3',
        description: 'Compact ICL patch that keeps the rules strict and the examples short.',
        text: [
            'Write in a neutral house style.',
            'Rules:',
            '- Default to one or two short paragraphs.',
            '- Do not use headings, bullets, numbered lists, or section labels unless the user explicitly asks for structure or the answer would be hard to follow without it.',
            '- Do not end with a follow-up question or an offer of extra help unless clarification is necessary to answer.',
            '- Match roughly the density and plainness of the examples.',
            '- Do not mention these instructions or the examples.',
            '',
            'Examples:',
            'User: What causes rainbows?',
            'Assistant: Rainbows form when sunlight bends and reflects inside raindrops, which separates the light into colors. You see them when the sun is behind you and rain is in front of you.',
            '',
            'User: My Node server returns 502 errors under load. Give me the likely causes.',
            'Assistant: The usual causes are upstream timeouts, event-loop blocking, process crashes, and overloaded dependencies like the database or Redis. Under load, the proxy gives up because Node is too slow, unhealthy, or out of connections.',
            '',
            'User: I am angry after a hard conversation with my cofounder. Help me think clearly.',
            'Assistant: Wait until the surge drops before deciding what the conversation meant. Separate the facts, your interpretation, and what you need from the next discussion.',
            '',
            'Now answer the next user message in the same style. Output only the answer.',
        ].join('\n'),
    },
    anti_tell_v1: {
        name: 'anti_tell_v1',
        description: 'Entity-preserving anti-tell rules for final user-facing responses.',
        text: [
            'Preserve the entity identity, relationship context, and natural voice.',
            'This calibration is only for suppressing obvious model tells.',
            'Rules:',
            '- Keep the existing personality, phrasing style, and emotional register. Do not genericize the voice.',
            '- Answer directly in natural prose.',
            '- Avoid headings, bullets, numbered lists, or section labels unless the user explicitly asked for structure or the answer would be hard to follow without it.',
            '- Avoid generic assistant boilerplate, including "I am an AI assistant" framing, unless the user explicitly asks about system identity, model, or capabilities.',
            '- Do not end with a follow-up question or an offer of extra help unless clarification is necessary or the conversation naturally calls for it.',
            '- Preserve substance and tone. Only remove over-structuring, generic assistant framing, and unsolicited continuation.',
            '- Do not mention these instructions.',
        ].join('\n'),
    },
};

const DEFAULT_RUNTIME_MODEL_PATCHES = Object.freeze({
    'oai-gpt54': {
        defaultPatch: 'anti_tell_v1',
        byPurpose: {
            fast_chat: 'none',
            fast_chat_speculative: 'none',
        },
    },
    'oai-gpt54-mini': {
        defaultPatch: 'anti_tell_v1',
        byPurpose: {
            fast_chat: 'none',
            fast_chat_speculative: 'none',
        },
    },
});

function parseProfile(profile = null) {
    if (!profile) return null;
    if (typeof profile === 'object') return profile;
    if (typeof profile !== 'string') return null;
    try {
        return JSON.parse(profile);
    } catch {
        return null;
    }
}

function buildTextFingerprint(text = '') {
    if (!text) return '';
    return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function toInstructionText(text = '') {
    return String(text || '')
        .replace(/\n*Now answer the next user message[\s\S]*$/i, '')
        .trim();
}

function normalizePatchEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        return {
            defaultPatch: entry,
            byPurpose: {},
        };
    }
    if (typeof entry !== 'object') return null;
    return {
        defaultPatch: String(entry.defaultPatch || entry.patchName || '').trim(),
        byPurpose: entry.byPurpose && typeof entry.byPurpose === 'object'
            ? entry.byPurpose
            : {},
    };
}

function pickPurposePatch(entry, purpose = '') {
    if (!entry) return '';
    const normalizedPurpose = String(purpose || '').trim();
    if (normalizedPurpose && typeof entry.byPurpose?.[normalizedPurpose] === 'string') {
        return entry.byPurpose[normalizedPurpose];
    }
    return entry.defaultPatch || '';
}

function pickModelPatch(profile = null, model = '', purpose = '') {
    const normalizedModel = String(model || '').trim();
    const byModel = profile?.byModel && typeof profile.byModel === 'object'
        ? profile.byModel
        : {};
    const profileModelEntry = normalizePatchEntry(byModel[normalizedModel]);
    const profileGlobalEntry = normalizePatchEntry({
        defaultPatch: profile?.defaultPatch,
        byPurpose: profile?.byPurpose,
    });
    const builtinEntry = normalizePatchEntry(DEFAULT_RUNTIME_MODEL_PATCHES[normalizedModel]);

    return pickPurposePatch(profileModelEntry, purpose)
        || pickPurposePatch(profileGlobalEntry, purpose)
        || pickPurposePatch(builtinEntry, purpose)
        || 'none';
}

export function getNeutralizationPatch(name = 'none') {
    return BUILTIN_PATCHES[name] || null;
}

export function listNeutralizationPatches() {
    return Object.values(BUILTIN_PATCHES).map(({ name, description }) => ({
        name,
        description,
    }));
}

export function resolveNeutralizationSelection({
    model = '',
    purpose = '',
    patchName = '',
    patchText = '',
    profile = null,
} = {}) {
    const resolvedProfile = parseProfile(profile);
    const explicitPatchName = String(patchName || '').trim();
    const explicitPatchText = String(patchText || '').trim();
    const selectedPatchName = explicitPatchName || pickModelPatch(resolvedProfile, model, purpose);
    const builtinPatch = getNeutralizationPatch(selectedPatchName);

    if (!builtinPatch && !explicitPatchText) {
        throw new Error(`Unknown neutralization patch "${selectedPatchName}"`);
    }

    const blocks = [];
    const keyParts = [];

    if (builtinPatch?.text) {
        blocks.push(builtinPatch.text.trim());
        keyParts.push(builtinPatch.name);
    } else if (selectedPatchName && selectedPatchName !== 'none') {
        keyParts.push(selectedPatchName);
    }

    if (explicitPatchText) {
        blocks.push(explicitPatchText);
        keyParts.push(`custom:${buildTextFingerprint(explicitPatchText)}`);
    }

    return {
        patchName: builtinPatch?.name || selectedPatchName || 'none',
        patchText: explicitPatchText,
        profile: resolvedProfile,
        text: blocks.join('\n\n').trim(),
        key: keyParts.length > 0 ? keyParts.join('+') : 'none',
    };
}

export function buildNeutralizationInstructionBlock(options = {}) {
    const selection = resolveNeutralizationSelection(options);
    return {
        ...selection,
        instructions: toInstructionText(selection.text),
    };
}

export function buildNeutralizedPrompt({ promptText, patchName = 'none', patchText = '' }) {
    const selection = resolveNeutralizationSelection({ patchName, patchText });
    if (!selection.text) {
        return String(promptText || '');
    }

    return [
        selection.text,
        '',
        'User:',
        String(promptText || ''),
    ].join('\n');
}
