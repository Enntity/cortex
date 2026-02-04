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
    VoiceConfig,
    EntitySessionContext,
} from '../types.js';

const SYS_ENTITY_AGENT_QUERY = `
query SysEntityAgent($text: String, $entityId: String, $chatId: String, $chatHistory: [MultiMessage], $aiName: String, $agentContext: [AgentContextInput], $model: String) {
    sys_entity_agent(text: $text, entityId: $entityId, chatId: $chatId, chatHistory: $chatHistory, aiName: $aiName, agentContext: $agentContext, model: $model, voiceResponse: true) {
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

const VOICE_SAMPLE_TEXT_QUERY = `
query VoiceSampleText($entityId: String!) {
    sys_generator_voice_sample(entityId: $entityId) {
        result
    }
}
`;

const SESSION_CONTEXT_QUERY = `
query SysEntitySessionContext($entityId: String, $agentContext: [AgentContextInput]) {
    sys_entity_session_context(entityId: $entityId, agentContext: $agentContext) {
        result
    }
}
`;

interface MultiMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface AgentContext {
    contextId: string;
    contextKey?: string;
    default?: boolean;
}

interface SessionContext {
    entityId: string;
    chatId?: string;
    aiName?: string;
    agentContext?: AgentContext[];
    model?: string;
}

// GraphQL response types
interface GraphQLResponse {
    data?: {
        sys_entity_agent?: {
            result: string;
            tool?: string;
            errors?: string[];
            warnings?: string[];
        };
    };
    errors?: Array<{ message: string }>;
}

interface VoiceSampleResponse {
    data?: {
        sys_generator_voice_sample?: {
            url?: string;
            voiceId?: string;
        };
    };
}

interface VoiceSampleTextResponse {
    data?: {
        sys_generator_voice_sample?: {
            result?: string;
        };
    };
}

interface SessionContextResponse {
    data?: {
        sys_entity_session_context?: {
            result?: string;
        };
    };
}

export class CortexBridge implements ICortexBridge {
    private apiUrl: string;
    private sessionContext: SessionContext | null = null;
    private toolStatusCallbacks: ((event: ToolStatusEvent) => void)[] = [];
    private mediaCallbacks: ((event: MediaEvent) => void)[] = [];

    constructor(apiUrl: string) {
        this.apiUrl = apiUrl;
    }

    /**
     * Set session context from VoiceConfig
     */
    setSessionContext(config: VoiceConfig): void {
        // Build agentContext array for continuity memory
        // This passes the user's contextId and contextKey to sys_entity_agent
        const agentContext: AgentContext[] = [];
        if (config.contextId) {
            agentContext.push({
                contextId: config.contextId,
                contextKey: config.contextKey,
                default: true,
            });
        }

        this.sessionContext = {
            entityId: config.entityId,
            chatId: config.chatId,
            aiName: config.aiName || config.entityId,
            agentContext: agentContext.length > 0 ? agentContext : undefined,
            model: config.model,
        };
        console.log('[CortexBridge] Session context set:', this.sessionContext);
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

        // Use session context if available, otherwise fall back to entityId
        const ctx = this.sessionContext || { entityId, aiName: entityId };

        const variables: Record<string, unknown> = {
            text,
            entityId: ctx.entityId,
            chatId: ctx.chatId,
            chatHistory: formattedHistory,
            aiName: ctx.aiName || ctx.entityId,
        };

        // Add agentContext if available (enables continuity memory)
        if (ctx.agentContext && ctx.agentContext.length > 0) {
            variables.agentContext = ctx.agentContext;
        }

        // Add model if specified
        if (ctx.model) {
            variables.model = ctx.model;
        }

        console.log('[CortexBridge] Query with context:', {
            text: text.substring(0, 50),
            entityId: variables.entityId,
            aiName: variables.aiName,
            model: variables.model,
            hasAgentContext: !!variables.agentContext,
        });

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 90000);

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: SYS_ENTITY_AGENT_QUERY,
                    variables,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`Cortex API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as GraphQLResponse;

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
            const vsController = new AbortController();
            const vsTimeout = setTimeout(() => vsController.abort(), 30000);

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: VOICE_SAMPLE_QUERY,
                    variables: { entityId },
                }),
                signal: vsController.signal,
            });

            clearTimeout(vsTimeout);

            if (!response.ok) {
                return null;
            }

            const data = await response.json() as VoiceSampleResponse;
            return data.data?.sys_generator_voice_sample?.url || null;
        } catch (error) {
            console.warn('[CortexBridge] Failed to get voice sample:', error);
            return null;
        }
    }

    async getSessionContext(): Promise<EntitySessionContext | null> {
        if (!this.sessionContext) {
            console.warn('[CortexBridge] No session context set, cannot fetch entity context');
            return null;
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: SESSION_CONTEXT_QUERY,
                    variables: {
                        entityId: this.sessionContext.entityId,
                        agentContext: this.sessionContext.agentContext || [],
                    },
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                console.warn(`[CortexBridge] Session context fetch failed: ${response.status}`);
                return null;
            }

            const data = await response.json() as SessionContextResponse;
            const resultStr = data.data?.sys_entity_session_context?.result;
            if (!resultStr) return null;

            return JSON.parse(resultStr) as EntitySessionContext;
        } catch (error) {
            console.warn('[CortexBridge] Failed to get session context:', error);
            return null;
        }
    }

    async getVoiceSampleText(entityId: string): Promise<string | null> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: VOICE_SAMPLE_TEXT_QUERY,
                    variables: { entityId },
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) return null;

            const data = await response.json() as VoiceSampleTextResponse;
            const result = data.data?.sys_generator_voice_sample?.result;
            if (!result) return null;

            // Extract content between EXAMPLE_DIALOGUE tags if present
            const match = result.match(/<EXAMPLE_DIALOGUE>([\s\S]*?)<\/EXAMPLE_DIALOGUE>/);
            return match ? match[1].trim() : result;
        } catch (error) {
            console.warn('[CortexBridge] Failed to get voice sample text:', error);
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
        // Check for ShowOverlay tool (returns items array in result)
        if (tool) {
            try {
                const toolData = JSON.parse(tool);
                if (toolData.toolUsed === 'ShowOverlay') {
                    // Parse result to get items
                    try {
                        const resultData = JSON.parse(result);
                        if (resultData.items && Array.isArray(resultData.items) && resultData.items.length > 0) {
                            console.log('[CortexBridge] ShowOverlay detected, emitting media event:', resultData.items.length, 'items', resultData.narrative ? 'with narrative' : '');
                            const event: MediaEvent = {
                                type: 'overlay',
                                items: resultData.items,
                            };

                            for (const callback of this.mediaCallbacks) {
                                try {
                                    callback(event);
                                } catch (error) {
                                    console.error('[CortexBridge] Media callback error:', error);
                                }
                            }
                            return; // Don't fall through to image URL extraction
                        }
                    } catch (parseError) {
                        console.warn('[CortexBridge] Failed to parse ShowOverlay result:', parseError);
                    }
                }
            } catch {
                // tool is not JSON, continue with legacy detection
            }
        }

        // Legacy: Check for image generation tools by extracting URLs
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
