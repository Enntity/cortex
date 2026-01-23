/**
 * Cortex Bridge
 *
 * Handles communication with the Cortex GraphQL API for sys_entity_agent integration.
 * Supports continuity memory, context stuffing, and all 33+ entity tools.
 */

import {
    ICortexBridge,
    CortexAgentResponse,
    ConversationMessage,
    ToolStatusEvent,
    MediaEvent,
} from '../types.js';

const SYS_ENTITY_AGENT_QUERY = `
query SysEntityAgent($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
    sys_entity_agent(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, voiceResponse: true) {
        result
        tool
        errors
        warnings
    }
}
`;

const VOICE_SAMPLE_QUERY = `
query VoiceSample($entityId: String!) {
    sys_generator_voice_sample(entityId: $entityId) {
        url
        voiceId
    }
}
`;

interface MultiMessage {
    role: 'user' | 'assistant';
    content: string;
}

export class CortexBridge implements ICortexBridge {
    private apiUrl: string;
    private toolStatusCallbacks: ((event: ToolStatusEvent) => void)[] = [];
    private mediaCallbacks: ((event: MediaEvent) => void)[] = [];

    constructor(apiUrl: string) {
        this.apiUrl = apiUrl;
    }

    async query(
        text: string,
        entityId: string,
        chatHistory?: ConversationMessage[]
    ): Promise<CortexAgentResponse> {
        // Convert conversation history to MultiMessage format
        const formattedHistory: MultiMessage[] = (chatHistory || []).map(msg => ({
            role: msg.role,
            content: msg.content,
        }));

        const variables = {
            text,
            contextId: entityId,
            chatHistory: formattedHistory,
            aiName: entityId, // Use entityId as AI name for context
        };

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: SYS_ENTITY_AGENT_QUERY,
                    variables,
                }),
            });

            if (!response.ok) {
                throw new Error(`Cortex API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (data.errors && data.errors.length > 0) {
                console.error('[CortexBridge] GraphQL errors:', data.errors);
                throw new Error(data.errors[0].message);
            }

            const agentResponse = data.data?.sys_entity_agent;

            if (!agentResponse) {
                throw new Error('No response from sys_entity_agent');
            }

            // Parse response for media events
            this.detectMediaEvents(agentResponse.result, agentResponse.tool);

            return {
                result: agentResponse.result || '',
                tool: agentResponse.tool,
                errors: agentResponse.errors,
                warnings: agentResponse.warnings,
            };
        } catch (error) {
            console.error('[CortexBridge] Query error:', error);
            throw error;
        }
    }

    async getVoiceSample(entityId: string): Promise<string | null> {
        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: VOICE_SAMPLE_QUERY,
                    variables: { entityId },
                }),
            });

            if (!response.ok) {
                return null;
            }

            const data = await response.json();
            return data.data?.sys_generator_voice_sample?.url || null;
        } catch (error) {
            console.warn('[CortexBridge] Failed to get voice sample:', error);
            return null;
        }
    }

    onToolStatus(callback: (event: ToolStatusEvent) => void): void {
        this.toolStatusCallbacks.push(callback);
    }

    onMedia(callback: (event: MediaEvent) => void): void {
        this.mediaCallbacks.push(callback);
    }

    /**
     * Detect and emit media events from response
     */
    private detectMediaEvents(result: string, tool?: string): void {
        // Check for image generation tools
        const imageTools = ['image_generation', 'dall_e', 'midjourney', 'stable_diffusion'];
        const isImageTool = tool && imageTools.some(t => tool.toLowerCase().includes(t));

        if (isImageTool) {
            const urls = this.extractImageUrls(result);
            if (urls.length > 0) {
                const event: MediaEvent = {
                    type: urls.length > 1 ? 'slideshow' : 'image',
                    urls,
                };

                for (const callback of this.mediaCallbacks) {
                    try {
                        callback(event);
                    } catch (error) {
                        console.error('[CortexBridge] Media callback error:', error);
                    }
                }
            }
        }
    }

    /**
     * Extract image URLs from text
     */
    private extractImageUrls(text: string): string[] {
        const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|webp)/gi;
        const matches = text.match(urlRegex);
        return matches || [];
    }

    /**
     * Emit tool status event
     */
    emitToolStatus(event: ToolStatusEvent): void {
        for (const callback of this.toolStatusCallbacks) {
            try {
                callback(event);
            } catch (error) {
                console.error('[CortexBridge] Tool status callback error:', error);
            }
        }
    }
}
