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

const MAX_DEHYDRATED_PAIRS = 10;
const SET_GOALS_NAME = 'setgoals';

export function dehydrateToolHistory(chatHistory, entityTools, startIndex) {
    const result = [];

    for (let i = startIndex; i < chatHistory.length; i++) {
        const msg = chatHistory[i];
        if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;

        // Filter out SetGoals tool_calls
        const realCalls = msg.tool_calls.filter(
            tc => tc.function?.name?.toLowerCase() !== SET_GOALS_NAME
        );
        if (realCalls.length === 0) continue;

        // Build dehydrated assistant message with only real tool_calls
        result.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: realCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
        });

        // Find matching tool responses
        const callIds = new Set(realCalls.map(tc => tc.id));
        for (let j = i + 1; j < chatHistory.length; j++) {
            const resp = chatHistory[j];
            if (resp.role !== 'tool' || !callIds.has(resp.tool_call_id)) continue;

            const summarize = entityTools[resp.name?.toLowerCase()]?.summarize || defaultSummarize;
            const content = (typeof resp.content === 'string' && resp.content.length > COMPRESSION_THRESHOLD)
                ? summarize(resp.content, resp.name)
                : resp.content;

            result.push({
                role: 'tool',
                tool_call_id: resp.tool_call_id,
                name: resp.name,
                content,
            });
            callIds.delete(resp.tool_call_id);
            if (callIds.size === 0) break;
        }
    }

    // Keep only the last N pairs (each pair = 1 assistant + its tool responses)
    // Walk backwards counting assistant messages
    if (result.length > 0) {
        let assistantCount = 0;
        let cutIndex = result.length;
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i].role === 'assistant') {
                assistantCount++;
                if (assistantCount > MAX_DEHYDRATED_PAIRS) {
                    cutIndex = i;
                    // Find the start of the next kept group
                    for (let k = i + 1; k < result.length; k++) {
                        if (result[k].role === 'assistant') { cutIndex = k; break; }
                    }
                    break;
                }
            }
        }
        if (cutIndex > 0 && cutIndex < result.length) {
            return result.slice(cutIndex);
        }
    }

    return result;
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
