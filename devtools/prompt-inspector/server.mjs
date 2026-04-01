#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { encode } from '../../lib/encodeCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORTEX_DIR = path.resolve(__dirname, '../..');
const DEFAULT_LOG_PATH = path.join(CORTEX_DIR, 'run.log');
const PORT = Number(process.env.PROMPT_INSPECTOR_PORT || 4317);
const HOST = process.env.PROMPT_INSPECTOR_HOST || '127.0.0.1';
const LOG_PATH = process.env.PROMPT_INSPECTOR_LOG || DEFAULT_LOG_PATH;
const MAX_REQUESTS = Number(process.env.PROMPT_INSPECTOR_MAX_REQUESTS || 200);

const cache = {
    mtimeMs: 0,
    parsed: null,
};

const SECTION_KIND = {
    STATIC: 'static',
    SEMI: 'semi-stable',
    VOLATILE: 'volatile',
    SCHEMA: 'schema',
};

function stripAnsi(text = '') {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function tokenCount(text) {
    return encode(String(text || '')).length;
}

function classifyHeading(title = '') {
    const normalized = String(title).trim().toLowerCase();

    if (!normalized) {
        return SECTION_KIND.VOLATILE;
    }

    if ([
        'general instructions',
        'ui information',
        'tool instructions',
        'search instructions',
        'grounding responses',
        'response guidelines',
        'entity dna',
        'user preferences',
        'memory boundaries',
        'output format',
        'merge rules',
        'schema instructions',
        'task',
        'generation config',
        'router policy',
        'conversation packet',
        'message template',
    ].includes(normalized)) {
        return SECTION_KIND.STATIC;
    }

    if ([
        'current expression state',
        'my internal compass',
        'relational context',
        'shared vocabulary',
        'resonance artifacts',
        'session context',
        'narrative context',
        'retrieved memories',
        'entity context',
        'current compass',
        'existing memories',
    ].includes(normalized)) {
        return SECTION_KIND.SEMI;
    }

    if ([
        'current run',
        'time, date, and time zone',
        'available files (recent)',
        'user input',
        'conversation',
        'recent conversation',
        'eidos metrics',
        'current query',
        'new memory',
        'chat history',
    ].includes(normalized)) {
        return SECTION_KIND.VOLATILE;
    }

    return SECTION_KIND.VOLATILE;
}

function pushSection(sections, {
    title,
    content,
    kind = SECTION_KIND.VOLATILE,
    source = '',
    collapsed = false,
    meta = null,
}) {
    const text = typeof content === 'string' ? content.trim() : JSON.stringify(content, null, 2);

    if (!text) {
        return;
    }

    sections.push({
        id: `${source || 'section'}-${sections.length + 1}`,
        title,
        source,
        kind,
        collapsed,
        chars: text.length,
        tokens: tokenCount(text),
        preview: text.slice(0, 220),
        content: text,
        meta,
    });
}

function splitMarkdownHeadings(text = '', marker = /^#{1,3}\s+(.+)$/gm, sourcePrefix = 'system') {
    const matches = [...String(text || '').matchAll(marker)];

    if (matches.length === 0) {
        return [{
            title: sourcePrefix === 'system' ? 'System Message' : 'Message',
            content: String(text || '').trim(),
        }];
    }

    const sections = [];

    for (let i = 0; i < matches.length; i++) {
        const title = matches[i][1].trim();
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        sections.push({
            title,
            content: text.slice(start, end).trim(),
        });
    }

    return sections;
}

function splitBlock(userContent = '', blocks = []) {
    const sections = [];

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const match = userContent.match(block.regex);
        const content = match?.[1] || match?.[0] || '';

        if (!content.trim()) {
            continue;
        }

        sections.push({
            title: block.title,
            content: content.trim(),
            kind: block.kind,
            collapsed: !!block.collapsed,
        });
    }

    return sections;
}

function summarizeTools(payloadTools = []) {
    const declarations = payloadTools.flatMap((group) => group.functionDeclarations || []);
    const lines = declarations.map((tool) => {
        const desc = String(tool.description || '').split('\n')[0].trim();
        return `- ${tool.name}${desc ? `: ${desc}` : ''}`;
    });

    return {
        names: declarations.map((tool) => tool.name),
        text: lines.join('\n'),
        count: declarations.length,
    };
}

function buildGeminiSections(entry) {
    const sections = [];
    const payload = entry.payload;

    const systemParts = payload.systemInstruction?.parts || [];
    systemParts.forEach((part, index) => {
        const chunks = splitMarkdownHeadings(part.text || '', index === 0 ? /^#\s+(.+)$/gm : /^##\s+(.+)$/gm, `system-part-${index + 1}`);
        chunks.forEach((chunk) => {
            const title = (
                entry.purpose === 'route'
                && (chunk.title === 'System Message' || chunk.title === 'Message')
            )
                ? 'Router Policy'
                : chunk.title;
            pushSection(sections, {
                title,
                content: chunk.content,
                kind: classifyHeading(title),
                source: `system:${index + 1}`,
                collapsed: false,
            });
        });
    });

    const contentMessages = payload.contents || [];
    contentMessages.forEach((message, index) => {
        const text = (message.parts || []).map((part) => {
            if (typeof part.text === 'string') return part.text;
            if (part.functionCall) return JSON.stringify(part.functionCall, null, 2);
            return JSON.stringify(part, null, 2);
        }).join('\n\n').trim();

        if (!text) return;

        const title = contentMessages.length === 1
            ? (entry.purpose === 'route' ? 'Conversation Packet' : 'User Input')
            : `Chat History ${index + 1} (${message.role})`;

        let formatted = text;
        if (text.startsWith('{') && text.includes('"userText"')) {
            const parsed = safeJsonParse(text);
            if (parsed) {
                formatted = JSON.stringify(parsed, null, 2);
            }
        }

        pushSection(sections, {
            title,
            content: formatted,
            kind: title === 'User Input' ? SECTION_KIND.VOLATILE : SECTION_KIND.VOLATILE,
            source: `contents:${index + 1}`,
            collapsed: contentMessages.length > 1 && index < contentMessages.length - 2,
        });
    });

    const toolSummary = summarizeTools(payload.tools || []);
    if (toolSummary.count > 0) {
        pushSection(sections, {
            title: `Tool Schemas (${toolSummary.count})`,
            content: `${toolSummary.text}\n\n--- RAW ---\n${JSON.stringify(payload.tools, null, 2)}`,
            kind: SECTION_KIND.SCHEMA,
            source: 'tools',
            collapsed: true,
            meta: { names: toolSummary.names },
        });
    }

    pushSection(sections, {
        title: 'Generation Config',
        content: JSON.stringify(payload.generationConfig || {}, null, 2),
        kind: SECTION_KIND.STATIC,
        source: 'generationConfig',
        collapsed: true,
    });

    return sections;
}

function buildOpenAiSections(entry) {
    const sections = [];
    const messages = entry.payload.input || [];
    const pathway = entry.pathway || '';

    messages.forEach((message, index) => {
        if (message.content == null) {
            return;
        }

        const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content, null, 2);

        if (pathway.includes('sys_continuity_narrative_summary')) {
            if (index === 0) {
                pushSection(sections, {
                    title: 'Narrative Summary Instructions',
                    content,
                    kind: SECTION_KIND.STATIC,
                    source: `message:${index + 1}`,
                });
                return;
            }

            splitBlock(content, [
                { title: 'Current Query', regex: /Current query:([\s\S]*?)\n\nRetrieved memories:/, kind: SECTION_KIND.VOLATILE },
                { title: 'Retrieved Memories', regex: /Retrieved memories:\n([\s\S]*?)\n\nGenerate a narrative context summary/, kind: SECTION_KIND.SEMI },
                { title: 'Task', regex: /Generate a narrative context summary[\s\S]*/, kind: SECTION_KIND.STATIC },
            ]).forEach((block) => {
                pushSection(sections, {
                    title: block.title,
                    content: block.content,
                    kind: block.kind,
                    source: `message:${index + 1}`,
                });
            });
            return;
        }

        if (pathway.includes('sys_continuity_turn_synthesis')) {
            if (index === 0) {
                pushSection(sections, {
                    title: 'Turn Synthesis Instructions',
                    content,
                    kind: SECTION_KIND.STATIC,
                    source: `message:${index + 1}`,
                });
                return;
            }

            splitBlock(content, [
                { title: 'Message Template', regex: /^As[\s\S]*?(?=\n\nYOUR CONTEXT:)/, kind: SECTION_KIND.STATIC },
                { title: 'Entity Context', regex: /YOUR CONTEXT:\n([\s\S]*?)\n\nTHE CONVERSATION:/, kind: SECTION_KIND.SEMI },
                { title: 'Conversation', regex: /THE CONVERSATION:\n([\s\S]*?)\n\nExtract and return a JSON object/, kind: SECTION_KIND.VOLATILE },
                { title: 'Schema Instructions', regex: /Extract and return a JSON object[\s\S]*/, kind: SECTION_KIND.STATIC },
            ]).forEach((block) => {
                pushSection(sections, {
                    title: block.title,
                    content: block.content,
                    kind: block.kind,
                    source: `message:${index + 1}`,
                    collapsed: block.title === 'Conversation',
                });
            });
            return;
        }

        if (pathway.includes('sys_continuity_memory_consolidation')) {
            if (index === 0) {
                pushSection(sections, {
                    title: 'Merge Rules',
                    content,
                    kind: SECTION_KIND.STATIC,
                    source: `message:${index + 1}`,
                });
                return;
            }

            splitBlock(content, [
                { title: 'New Memory', regex: /NEW MEMORY \(must preserve its meaning\):\n([\s\S]*?)\n\nSIMILAR EXISTING MEMORY\/MEMORIES:/, kind: SECTION_KIND.VOLATILE },
                { title: 'Existing Memories', regex: /SIMILAR EXISTING MEMORY\/MEMORIES:\n([\s\S]*?)\n\nMerge into ONE/, kind: SECTION_KIND.SEMI },
                { title: 'Task', regex: /Merge into ONE[\s\S]*/, kind: SECTION_KIND.STATIC },
            ]).forEach((block) => {
                pushSection(sections, {
                    title: block.title,
                    content: block.content,
                    kind: block.kind,
                    source: `message:${index + 1}`,
                });
            });
            return;
        }

        if (pathway.includes('sys_continuity_compass_synthesis')) {
            if (index === 0) {
                pushSection(sections, {
                    title: 'Compass Update Instructions',
                    content,
                    kind: SECTION_KIND.STATIC,
                    source: `message:${index + 1}`,
                });
                return;
            }

            splitBlock(content, [
                { title: 'Current Compass', regex: /MY CURRENT INTERNAL COMPASS:\n([\s\S]*?)\n\nRECENT CONVERSATION TO INTEGRATE:/, kind: SECTION_KIND.SEMI },
                { title: 'Recent Conversation', regex: /RECENT CONVERSATION TO INTEGRATE:\n([\s\S]*?)\n\nMY SELF-OBSERVATION METRICS:/, kind: SECTION_KIND.VOLATILE },
                { title: 'Eidos Metrics', regex: /MY SELF-OBSERVATION METRICS:\n([\s\S]*?)\n\nUpdate your Internal Compass\./, kind: SECTION_KIND.VOLATILE },
                { title: 'Output Format', regex: /Update your Internal Compass\.[\s\S]*/, kind: SECTION_KIND.STATIC },
            ]).forEach((block) => {
                pushSection(sections, {
                    title: block.title,
                    content: block.content,
                    kind: block.kind,
                    source: `message:${index + 1}`,
                    collapsed: block.title === 'Recent Conversation',
                });
            });
            return;
        }

        splitMarkdownHeadings(content, /^#{1,3}\s+(.+)$/gm).forEach((chunk) => {
            pushSection(sections, {
                title: message.role === 'system' ? `${chunk.title}` : `Message ${index + 1}: ${chunk.title}`,
                content: chunk.content,
                kind: message.role === 'system' ? SECTION_KIND.STATIC : SECTION_KIND.VOLATILE,
                source: `message:${index + 1}`,
            });
        });
    });

    return sections;
}

function normalizeEntry(entry) {
    const provider = entry.provider;
    const sections = provider === 'gemini'
        ? buildGeminiSections(entry)
        : buildOpenAiSections(entry);

    const totalSectionTokens = sections.reduce((sum, section) => sum + section.tokens, 0) || 1;
    sections.forEach((section) => {
        section.percent = Number(((section.tokens / totalSectionTokens) * 100).toFixed(1));
    });

    const byKind = sections.reduce((acc, section) => {
        acc[section.kind] = (acc[section.kind] || 0) + section.tokens;
        return acc;
    }, {});

    const kinds = Object.entries(byKind).map(([kind, tokens]) => ({
        kind,
        tokens,
        percent: Number(((tokens / totalSectionTokens) * 100).toFixed(1)),
    }));

    const summary = sections
        .filter((section) => section.kind !== SECTION_KIND.SCHEMA)
        .slice(0, 3)
        .map((section) => section.title)
        .join(' • ');

    return {
        ...entry,
        approxPromptTokens: tokenCount(JSON.stringify(entry.payload || {})),
        approxSectionTokens: totalSectionTokens,
        sections,
        cacheMix: kinds,
        summary,
    };
}

function extractUrlAndPayload(line = '') {
    const match = line.match(/Posting (https?:\/\/\S+) with data: (.+)$/);
    if (!match) return null;
    const payload = safeJsonParse(match[2]);
    if (!payload) return null;

    return {
        url: match[1],
        payload,
    };
}

function buildEntryId(base = 'entry', purpose = '', pathway = '', index = 0) {
    const suffix = purpose || pathway || `post-${index + 1}`;
    return `${base}:${suffix}:${index + 1}`;
}

function deriveProvider(url = '') {
    if (url.includes('api.openai.com')) return 'openai';
    if (url.includes('aiplatform.googleapis.com')) return 'gemini';
    return 'other';
}

function isPromptCarrier(url = '', payload = {}) {
    if (url.includes('api.openai.com/v1/responses')) {
        return Array.isArray(payload.input);
    }

    if (url.includes('aiplatform.googleapis.com')) {
        return Array.isArray(payload.contents) || Array.isArray(payload.systemInstruction?.parts);
    }

    return false;
}

function parseRequestMarker(line = '') {
    const match = line.match(/>>> \[([a-z0-9-]+): ([^\]]+?)\.(\d+)] request/i);
    if (!match) return null;
    return {
        rid: match[1],
        pathway: match[2],
        attempt: Number(match[3]),
    };
}

function parseModelCallEvent(line = '') {
    const jsonStart = line.indexOf('{"ts":');
    if (jsonStart < 0) return null;
    const event = safeJsonParse(line.slice(jsonStart));
    if (!event || event.evt !== 'model.call') return null;
    return event;
}

function extractPromptMetrics(lines = [], startIndex = 0, endIndex = lines.length - 1, provider = '') {
    let providerPromptTokens = null;
    let providerPromptChars = null;

    for (let i = startIndex; i <= endIndex; i++) {
        const line = lines[i] || '';

        if (provider === 'gemini') {
            const promptTokenMatch = line.match(/"promptTokenCount":(\d+)/);
            if (promptTokenMatch && providerPromptTokens == null) {
                providerPromptTokens = Number(promptTokenMatch[1]);
            }
        }

        if (provider === 'openai') {
            const openAiTokenMatch = line.match(/\[openai responses request contained (\d+) tokens]/);
            if (openAiTokenMatch && providerPromptTokens == null) {
                providerPromptTokens = Number(openAiTokenMatch[1]);
            }

            const openAiCharMatch = line.match(/\[openai responses request contained (\d+) characters]/);
            if (openAiCharMatch && providerPromptChars == null) {
                providerPromptChars = Number(openAiCharMatch[1]);
            }
        }
    }

    return { providerPromptTokens, providerPromptChars };
}

function readAndParseLog() {
    const stat = fs.statSync(LOG_PATH);

    if (cache.parsed && cache.mtimeMs === stat.mtimeMs) {
        return cache.parsed;
    }

    const raw = stripAnsi(fs.readFileSync(LOG_PATH, 'utf8'));
    const lines = raw.split(/\r?\n/);
    const entries = [];
    const purposeCounts = new Map();
    let recentRequestMarker = null;
    let recentModelCall = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];

        const requestMarker = parseRequestMarker(line);
        if (requestMarker) {
            recentRequestMarker = { ...requestMarker, lineIndex: index, consumed: false };
            continue;
        }

        const modelCall = parseModelCallEvent(line);
        if (modelCall) {
            recentModelCall = { ...modelCall, lineIndex: index, consumed: false };
            continue;
        }

        if (!line.includes('Posting http')) {
            continue;
        }

        const parsed = extractUrlAndPayload(line);
        if (!parsed) {
            continue;
        }

        const provider = deriveProvider(parsed.url);
        if (!isPromptCarrier(parsed.url, parsed.payload)) {
            continue;
        }
        const requestMarkerFresh = recentRequestMarker && (index - recentRequestMarker.lineIndex) < 120 && !recentRequestMarker.consumed
            ? recentRequestMarker
            : null;
        const modelCallFresh = recentModelCall && (index - recentModelCall.lineIndex) < 120 && !recentModelCall.consumed
            ? recentModelCall
            : null;

        const baseRid = requestMarkerFresh?.rid || modelCallFresh?.rid || 'unknown';
        const purpose = modelCallFresh?.purpose || '';
        const pathway = requestMarkerFresh?.pathway || '';
        const purposeKey = `${baseRid}:${purpose || pathway || 'unknown'}`;
        const seen = purposeCounts.get(purposeKey) || 0;
        purposeCounts.set(purposeKey, seen + 1);

        const entry = {
            id: buildEntryId(baseRid, purpose, pathway, seen),
            requestRid: baseRid,
            purpose,
            pathway,
            provider,
            url: parsed.url,
            model: modelCallFresh?.model || parsed.payload.model || '',
            promptCacheKey: modelCallFresh?.promptCacheKey || null,
            messageCount: modelCallFresh?.messageCount ?? null,
            toolChoice: modelCallFresh?.toolChoice ?? null,
            route: modelCallFresh?.route || null,
            lineIndexStart: index,
            timestamp: modelCallFresh?.ts || null,
            payload: parsed.payload,
        };

        entries.push(entry);

        if (requestMarkerFresh) requestMarkerFresh.consumed = true;
        if (modelCallFresh) modelCallFresh.consumed = true;
    }

    entries.forEach((entry, index) => {
        entry.lineIndexEnd = index + 1 < entries.length ? entries[index + 1].lineIndexStart - 1 : lines.length - 1;
        const metrics = extractPromptMetrics(lines, entry.lineIndexStart, entry.lineIndexEnd, entry.provider);
        entry.providerPromptTokens = metrics.providerPromptTokens;
        entry.providerPromptChars = metrics.providerPromptChars;
    });

    const normalizedEntries = entries
        .slice(-MAX_REQUESTS)
        .map(normalizeEntry)
        .reverse();

    const parsedResult = {
        mtimeMs: stat.mtimeMs,
        logPath: LOG_PATH,
        requestCount: normalizedEntries.length,
        entries: normalizedEntries,
        byId: new Map(normalizedEntries.map((entry) => [entry.id, entry])),
    };

    cache.mtimeMs = stat.mtimeMs;
    cache.parsed = parsedResult;
    return parsedResult;
}

function sendJson(res, status, data) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function sendHtml(res, status, html) {
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(html);
}

function requestSummary(entry) {
    return {
        id: entry.id,
        requestRid: entry.requestRid,
        purpose: entry.purpose,
        pathway: entry.pathway,
        provider: entry.provider,
        model: entry.model,
        timestamp: entry.timestamp,
        providerPromptTokens: entry.providerPromptTokens,
        approxPromptTokens: entry.approxPromptTokens,
        summary: entry.summary,
        promptCacheKey: entry.promptCacheKey,
    };
}

function renderAppHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Prompt Inspector</title>
  <style>
    :root {
      --bg: #f3eee3;
      --panel: #fffdf8;
      --line: #d9cfbf;
      --text: #1e1e1a;
      --muted: #6d665b;
      --accent: #0b5c5a;
      --accent-2: #c85c3a;
      --stable: #2d6a4f;
      --warm: #986d00;
      --hot: #b6462f;
      --schema: #4966b0;
      --shadow: 0 10px 30px rgba(64, 48, 24, 0.08);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(11,92,90,0.12), transparent 35%),
        radial-gradient(circle at top right, rgba(200,92,58,0.10), transparent 25%),
        linear-gradient(180deg, #f7f3ea 0%, var(--bg) 100%);
    }
    .app {
      display: grid;
      grid-template-columns: 360px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: rgba(255, 253, 248, 0.9);
      backdrop-filter: blur(12px);
      padding: 20px 18px;
      overflow: auto;
    }
    .main {
      padding: 22px;
      overflow: auto;
    }
    h1, h2, h3, p { margin: 0; }
    .title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 16px;
      gap: 12px;
    }
    .title h1 {
      font-size: 24px;
      letter-spacing: 0.01em;
    }
    .muted { color: var(--muted); }
    .toolbar {
      display: grid;
      gap: 10px;
      margin-bottom: 16px;
    }
    input, select, button {
      font: inherit;
    }
    input[type="search"] {
      width: 100%;
      padding: 11px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: white;
    }
    .toggle-row {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .list {
      display: grid;
      gap: 10px;
    }
    .request-item {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      padding: 12px;
      cursor: pointer;
      box-shadow: var(--shadow);
      transition: transform 120ms ease, border-color 120ms ease;
    }
    .request-item:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
    }
    .request-item.active {
      border-color: var(--accent);
      outline: 2px solid rgba(11,92,90,0.12);
    }
    .request-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .badge-row, .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge {
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--muted);
    }
    .badge.provider-gemini { border-color: #a5d8d4; color: var(--accent); }
    .badge.provider-openai { border-color: #b7c6f0; color: var(--schema); }
    .panel {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--panel);
      box-shadow: var(--shadow);
      padding: 18px;
      margin-bottom: 18px;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: rgba(255,255,255,0.7);
    }
    .stat .label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 5px;
    }
    .stat .value {
      font-size: 18px;
      font-weight: 600;
    }
    .mix-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .mix-pill {
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      color: white;
    }
    .mix-pill.static { background: var(--stable); }
    .mix-pill.semi-stable { background: var(--warm); }
    .mix-pill.volatile { background: var(--hot); }
    .mix-pill.schema { background: var(--schema); }
    .section {
      border: 1px solid var(--line);
      border-radius: 16px;
      margin-bottom: 14px;
      overflow: hidden;
      background: white;
    }
    .section summary {
      list-style: none;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      padding: 14px 16px;
      cursor: pointer;
      align-items: start;
    }
    .section summary::-webkit-details-marker { display: none; }
    .section-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    .section-body {
      border-top: 1px solid var(--line);
      padding: 14px 16px 16px;
    }
    .section pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
    }
    .kind {
      color: white;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .kind.static { background: var(--stable); }
    .kind.semi-stable { background: var(--warm); }
    .kind.volatile { background: var(--hot); }
    .kind.schema { background: var(--schema); }
    .preview {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .section-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-bottom: 10px;
    }
    .section-actions button, .refresh {
      border: 1px solid var(--line);
      background: white;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 16px;
      padding: 32px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,0.6);
    }
    .raw {
      margin-top: 18px;
    }
    @media (max-width: 1100px) {
      .app {
        grid-template-columns: 1fr;
      }
      .sidebar {
        border-right: none;
        border-bottom: 1px solid var(--line);
        max-height: 42vh;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="title">
        <h1>Prompt Inspector</h1>
        <span id="status" class="muted">loading</span>
      </div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Filter by request, purpose, model, summary" />
        <div class="toggle-row">
          <label><input id="autoRefresh" type="checkbox" checked /> Auto refresh</label>
          <button id="refresh" class="refresh">Refresh</button>
        </div>
      </div>
      <div id="requestList" class="list"></div>
    </aside>
    <main class="main">
      <div id="detail"></div>
    </main>
  </div>
  <script>
    const state = {
      requests: [],
      selectedId: null,
      filter: '',
      autoRefresh: true,
      interval: null,
    };

    const requestListEl = document.getElementById('requestList');
    const detailEl = document.getElementById('detail');
    const statusEl = document.getElementById('status');
    const searchEl = document.getElementById('search');
    const autoRefreshEl = document.getElementById('autoRefresh');
    const refreshEl = document.getElementById('refresh');

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function badge(label, className = '') {
      return '<span class="badge ' + className + '">' + escapeHtml(label) + '</span>';
    }

    function kindPill(kind) {
      return '<span class="kind ' + kind + '">' + escapeHtml(kind) + '</span>';
    }

    function fmtNum(value) {
      return value == null ? 'n/a' : Number(value).toLocaleString();
    }

    function timeText(ts) {
      if (!ts) return 'unknown time';
      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) return ts;
      return date.toLocaleString();
    }

    function filteredRequests() {
      const q = state.filter.trim().toLowerCase();
      if (!q) return state.requests;
      return state.requests.filter((item) => {
        return [
          item.id,
          item.requestRid,
          item.purpose,
          item.pathway,
          item.model,
          item.summary,
        ].some((field) => String(field || '').toLowerCase().includes(q));
      });
    }

    function renderRequestList() {
      const items = filteredRequests();
      if (items.length === 0) {
        requestListEl.innerHTML = '<div class="empty">No prompt entries match the current filter.</div>';
        return;
      }

      requestListEl.innerHTML = items.map((item) => {
        return '<article class="request-item ' + (item.id === state.selectedId ? 'active' : '') + '" data-id="' + escapeHtml(item.id) + '">' +
          '<div class="request-top">' +
            '<strong>' + escapeHtml(item.purpose || item.pathway || item.id) + '</strong>' +
            badge(item.provider, 'provider-' + item.provider) +
          '</div>' +
          '<div class="meta-row">' +
            badge(item.model || 'unknown model') +
            badge(item.providerPromptTokens != null ? ('actual ' + fmtNum(item.providerPromptTokens) + ' tok') : ('approx ' + fmtNum(item.approxPromptTokens) + ' tok')) +
          '</div>' +
          '<p class="preview">' + escapeHtml(item.summary || item.pathway || item.requestRid) + '</p>' +
          '<div class="meta-row">' +
            badge(item.requestRid) +
            badge(timeText(item.timestamp)) +
          '</div>' +
        '</article>';
      }).join('');

      requestListEl.querySelectorAll('.request-item').forEach((el) => {
        el.addEventListener('click', () => {
          state.selectedId = el.dataset.id;
          location.hash = encodeURIComponent(state.selectedId);
          renderRequestList();
          loadDetail(state.selectedId);
        });
      });
    }

    async function loadRequests() {
      statusEl.textContent = 'refreshing';
      const res = await fetch('/api/requests');
      const data = await res.json();
      state.requests = data.requests || [];

      if (!state.selectedId || !state.requests.some((item) => item.id === state.selectedId)) {
        state.selectedId = decodeURIComponent(location.hash.slice(1)) || state.requests[0]?.id || null;
      }

      renderRequestList();

      if (state.selectedId) {
        await loadDetail(state.selectedId);
      } else {
        detailEl.innerHTML = '<div class="empty">No prompt entries found in run.log yet.</div>';
      }

      statusEl.textContent = 'ready';
    }

    async function loadDetail(id) {
      const res = await fetch('/api/request/' + encodeURIComponent(id));
      if (!res.ok) {
        detailEl.innerHTML = '<div class="empty">Unable to load that prompt entry.</div>';
        return;
      }
      const entry = await res.json();

      const overview = '<section class="panel">' +
        '<div class="title"><h2>' + escapeHtml(entry.purpose || entry.pathway || entry.id) + '</h2><span class="muted">' + escapeHtml(entry.requestRid) + '</span></div>' +
        '<p class="muted">' + escapeHtml(entry.summary || 'No summary available.') + '</p>' +
        '<div class="overview-grid">' +
          stat('Provider', entry.provider) +
          stat('Model', entry.model || 'unknown') +
          stat('Actual Prompt Tokens', fmtNum(entry.providerPromptTokens)) +
          stat('Approx Prompt Tokens', fmtNum(entry.approxPromptTokens)) +
          stat('Approx Section Tokens', fmtNum(entry.approxSectionTokens)) +
          stat('Prompt Cache Key', entry.promptCacheKey || 'n/a') +
        '</div>' +
        '<div class="mix-row">' + (entry.cacheMix || []).map((item) => '<span class="mix-pill ' + item.kind + '">' + escapeHtml(item.kind) + ': ' + fmtNum(item.tokens) + ' tok (' + item.percent + '%)</span>').join('') + '</div>' +
      '</section>';

      const sections = (entry.sections || []).map((section) => {
        return '<details class="section" ' + (section.collapsed ? '' : 'open') + '>' +
          '<summary>' +
            '<div>' +
              '<strong>' + escapeHtml(section.title) + '</strong>' +
              '<div class="preview">' + escapeHtml(section.preview) + '</div>' +
            '</div>' +
            '<div class="section-meta">' +
              kindPill(section.kind) +
              badge(fmtNum(section.tokens) + ' tok') +
              badge(section.percent + '%') +
              badge(fmtNum(section.chars) + ' ch') +
            '</div>' +
          '</summary>' +
          '<div class="section-body">' +
            '<div class="section-actions"><button data-copy="' + escapeHtml(section.id) + '">Copy</button></div>' +
            '<pre id="' + escapeHtml(section.id) + '">' + escapeHtml(section.content) + '</pre>' +
          '</div>' +
        '</details>';
      }).join('');

      const raw = '<section class="panel raw">' +
        '<h3>Raw Payload</h3>' +
        '<div class="section-actions"><button id="copyRaw">Copy JSON</button></div>' +
        '<pre id="rawPayload">' + escapeHtml(JSON.stringify(entry.payload, null, 2)) + '</pre>' +
      '</section>';

      detailEl.innerHTML = overview + sections + raw;

      detailEl.querySelectorAll('[data-copy]').forEach((button) => {
        button.addEventListener('click', async () => {
          const target = document.getElementById(button.dataset.copy);
          await navigator.clipboard.writeText(target.textContent || '');
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = 'Copy'; }, 1000);
        });
      });

      const copyRaw = document.getElementById('copyRaw');
      if (copyRaw) {
        copyRaw.addEventListener('click', async () => {
          await navigator.clipboard.writeText(document.getElementById('rawPayload').textContent || '');
          copyRaw.textContent = 'Copied';
          setTimeout(() => { copyRaw.textContent = 'Copy JSON'; }, 1000);
        });
      }
    }

    function stat(label, value) {
      return '<div class="stat"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(String(value)) + '</div></div>';
    }

    searchEl.addEventListener('input', () => {
      state.filter = searchEl.value;
      renderRequestList();
    });

    refreshEl.addEventListener('click', () => {
      loadRequests().catch((error) => {
        console.error(error);
        statusEl.textContent = 'error';
      });
    });

    autoRefreshEl.addEventListener('change', () => {
      state.autoRefresh = autoRefreshEl.checked;
      if (state.interval) clearInterval(state.interval);
      if (state.autoRefresh) {
        state.interval = setInterval(() => loadRequests().catch(() => {}), 3000);
      }
    });

    state.interval = setInterval(() => {
      if (state.autoRefresh) {
        loadRequests().catch(() => {});
      }
    }, 3000);

    loadRequests().catch((error) => {
      console.error(error);
      statusEl.textContent = 'error';
      detailEl.innerHTML = '<div class="empty">Failed to load prompt data.</div>';
    });
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    try {
        const parsed = readAndParseLog();
        const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

        if (url.pathname === '/') {
            return sendHtml(res, 200, renderAppHtml());
        }

        if (url.pathname === '/api/requests') {
            return sendJson(res, 200, {
                logPath: parsed.logPath,
                mtimeMs: parsed.mtimeMs,
                requests: parsed.entries.map(requestSummary),
            });
        }

        if (url.pathname.startsWith('/api/request/')) {
            const id = decodeURIComponent(url.pathname.replace('/api/request/', ''));
            const entry = parsed.byId.get(id);

            if (!entry) {
                return sendJson(res, 404, { error: `Unknown prompt entry: ${id}` });
            }

            return sendJson(res, 200, entry);
        }

        sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
        sendJson(res, 500, { error: error.message, logPath: LOG_PATH });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Prompt Inspector listening on http://${HOST}:${PORT}`);
    console.log(`Reading prompts from ${LOG_PATH}`);
});
