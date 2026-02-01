// tool_result_compression.js
// Size-tiered compression for tool results in the entity agent loop.
// Results over COMPRESSION_THRESHOLD are stored in a Map on pathwayResolver,
// kept full for the current LLM call, then compressed to a short summary on
// the next iteration. Full results are rehydrated for final synthesis.

export const COMPRESSION_THRESHOLD = 4000; // ~1000 tokens

export function defaultSummarize(content, toolName) {
    // Try to preserve JSON structure
    try {
        const parsed = JSON.parse(content);
        if (parsed._type === 'SearchResponse' && Array.isArray(parsed.value)) {
            const compressed = parsed.value.map(r => ({
                searchResultId: r.searchResultId,
                title: r.title, url: r.url,
                content: (r.content || '').substring(0, 200) + '...'
            }));
            return JSON.stringify({ _type: 'SearchResponse', value: compressed, _compressed: true });
        }
        if (parsed.content && typeof parsed.content === 'string') {
            return JSON.stringify({
                ...parsed,
                content: parsed.content.substring(0, 300) + '...',
                _compressed: true, _originalChars: parsed.content.length
            });
        }
    } catch { /* not JSON */ }
    return content.substring(0, 500) +
        '\n\n[Compressed — full content will be restored for final synthesis]';
}

export function compressOlderToolResults(messages, store, currentRound, entityTools) {
    if (!store || store.size === 0) return messages;
    return messages.map(msg => {
        if (msg.role !== 'tool' || !msg.tool_call_id) return msg;
        const entry = store.get(msg.tool_call_id);
        if (!entry || entry.round === currentRound || entry.compressed) return msg;
        const summarize = entityTools[(msg.name || '').toLowerCase()]?.summarize || defaultSummarize;
        entry.compressed = true;
        return { ...msg, content: summarize(entry.fullContent, msg.name) };
    });
}

export function rehydrateAllToolResults(messages, store) {
    if (!store || store.size === 0) return messages;
    // Mark all entries as uncompressed so final synthesis sees full content
    for (const entry of store.values()) {
        entry.compressed = false;
    }
    return messages.map(msg => {
        if (msg.role !== 'tool' || !msg.tool_call_id) return msg;
        const entry = store.get(msg.tool_call_id);
        if (!entry || msg.content === entry.fullContent) return msg;
        return { ...msg, content: entry.fullContent };
    });
}
