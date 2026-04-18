function extractTextFromContent(content = null) {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return extractTextFromContent(JSON.parse(trimmed));
            } catch {
                return trimmed;
            }
        }
        return trimmed;
    }

    if (Array.isArray(content)) {
        for (const item of content) {
            const text = extractTextFromContent(item);
            if (text) return text;
        }
        return '';
    }

    if (content && typeof content === 'object') {
        if (content.type === 'text' && typeof content.text === 'string') {
            return content.text.trim();
        }
        if (typeof content.userText === 'string' && content.userText.trim()) {
            return content.userText.trim();
        }
        if (typeof content.text === 'string' && content.text.trim()) {
            return content.text.trim();
        }
        if (content.content !== undefined) {
            return extractTextFromContent(content.content);
        }
    }

    return '';
}

export function extractGoalFromArgs(args = {}) {
    if (typeof args.text === 'string' && args.text.trim()) return args.text.trim();
    const lastUser = [...(args.chatHistory || [])].reverse().find(msg => msg.role === 'user');
    return extractTextFromContent(lastUser?.content);
}
