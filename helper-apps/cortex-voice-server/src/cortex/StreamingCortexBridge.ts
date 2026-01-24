/**
 * Streaming Cortex Bridge
 *
 * Handles streaming communication with the Cortex GraphQL API for sys_entity_agent.
 * Uses GraphQL subscriptions to stream responses, enabling sentence-by-sentence TTS.
 * Supports tool status events, media events, and all entity features.
 */

import { createClient, Client } from 'graphql-ws';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
    VoiceConfig,
    ToolStatusEvent,
    MediaEvent,
    ConversationMessage,
} from '../types.js';

// GraphQL queries
const SYS_ENTITY_AGENT_QUERY = `
query SysEntityAgent(
    $text: String,
    $entityId: String,
    $chatId: String,
    $chatHistory: [MultiMessage],
    $aiName: String,
    $agentContext: [AgentContextInput],
    $model: String,
    $stream: Boolean
) {
    sys_entity_agent(
        text: $text,
        entityId: $entityId,
        chatId: $chatId,
        chatHistory: $chatHistory,
        aiName: $aiName,
        agentContext: $agentContext,
        model: $model,
        voiceResponse: true,
        stream: $stream
    ) {
        result
        tool
        errors
        warnings
    }
}
`;

const REQUEST_PROGRESS_SUBSCRIPTION = `
subscription RequestProgress($requestIds: [String!]) {
    requestProgress(requestIds: $requestIds) {
        data
        progress
        info
        error
    }
}
`;

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

interface ToolMessage {
    type: 'start' | 'finish';
    callId: string;
    icon?: string;
    userMessage?: string;
    toolName?: string;
    success?: boolean;
    error?: string;
}

interface StreamEvents {
    'sentence': (sentence: string) => void;
    'tool-status': (event: ToolStatusEvent) => void;
    'media': (event: MediaEvent) => void;
    'thinking': (isThinking: boolean) => void;
    'complete': (fullText: string) => void;
    'error': (error: Error) => void;
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

interface RequestProgressData {
    requestProgress?: {
        data?: string;
        progress?: number;
        info?: string;
        error?: string;
    };
}

export class StreamingCortexBridge extends EventEmitter {
    private httpUrl: string;
    private wsUrl: string;
    private wsClient: Client | null = null;
    private sessionContext: SessionContext | null = null;

    // Sentence buffering
    private textBuffer: string = '';
    private fullResponse: string = '';
    private isProcessing: boolean = false;

    // Sentence boundary detection
    private readonly SENTENCE_ENDINGS = /([.!?])\s+/;
    private readonly MIN_SENTENCE_LENGTH = 10; // Don't emit very short fragments

    constructor(apiUrl: string) {
        super();
        this.httpUrl = apiUrl;
        // Convert HTTP URL to WebSocket URL for subscriptions
        this.wsUrl = apiUrl.replace(/^http/, 'ws');
    }

    /**
     * Set session context from VoiceConfig
     */
    setSessionContext(config: VoiceConfig): void {
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
        console.log('[StreamingCortexBridge] Session context set:', {
            entityId: this.sessionContext.entityId,
            model: this.sessionContext.model,
            hasAgentContext: !!this.sessionContext.agentContext,
        });
    }

    /**
     * Non-streaming query for interface compatibility
     * Collects full response before returning
     */
    async query(
        text: string,
        entityId: string,
        chatHistory?: ConversationMessage[]
    ): Promise<{ result: string; tool?: string; errors?: string[]; warnings?: string[] }> {
        return new Promise((resolve, reject) => {
            let fullText = '';

            const onSentence = (sentence: string) => {
                fullText += sentence + ' ';
            };

            const onComplete = (text: string) => {
                this.off('sentence', onSentence);
                this.off('complete', onComplete);
                this.off('error', onError);
                resolve({ result: text.trim() });
            };

            const onError = (error: Error) => {
                this.off('sentence', onSentence);
                this.off('complete', onComplete);
                this.off('error', onError);
                reject(error);
            };

            this.on('sentence', onSentence);
            this.on('complete', onComplete);
            this.on('error', onError);

            this.queryStreaming(text, entityId, chatHistory).catch(reject);
        });
    }

    /**
     * Query sys_entity_agent with streaming response
     * Emits 'sentence' events as complete sentences are received
     */
    async queryStreaming(
        text: string,
        entityId: string,
        chatHistory?: ConversationMessage[]
    ): Promise<void> {
        if (this.isProcessing) {
            throw new Error('Already processing a query');
        }

        this.isProcessing = true;
        this.textBuffer = '';
        this.fullResponse = '';

        const ctx = this.sessionContext || { entityId, aiName: entityId };
        const formattedHistory = (chatHistory || []).map(msg => ({
            role: msg.role,
            content: msg.content,
        }));

        const variables: Record<string, unknown> = {
            text,
            entityId: ctx.entityId,
            chatId: ctx.chatId,
            chatHistory: formattedHistory,
            aiName: ctx.aiName || ctx.entityId,
            stream: true, // Enable streaming
        };

        if (ctx.agentContext && ctx.agentContext.length > 0) {
            variables.agentContext = ctx.agentContext;
        }

        if (ctx.model) {
            variables.model = ctx.model;
        }

        console.log('[StreamingCortexBridge] Starting streaming query:', {
            text: text.substring(0, 50),
            entityId: variables.entityId,
        });

        try {
            // Step 1: Make initial HTTP request to get subscriptionId
            const subscriptionId = await this.getSubscriptionId(variables);
            console.log('[StreamingCortexBridge] Got subscription ID:', subscriptionId);

            // Step 2: Subscribe to requestProgress
            await this.subscribeToProgress(subscriptionId);

        } catch (error) {
            this.isProcessing = false;
            console.error('[StreamingCortexBridge] Query error:', error);
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Make initial query to get subscription ID
     */
    private async getSubscriptionId(variables: Record<string, unknown>): Promise<string> {
        const response = await fetch(this.httpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: SYS_ENTITY_AGENT_QUERY,
                variables,
            }),
        });

        if (!response.ok) {
            throw new Error(`Cortex API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as GraphQLResponse;

        if (data.errors && data.errors.length > 0) {
            throw new Error(data.errors[0].message);
        }

        const subscriptionId = data.data?.sys_entity_agent?.result;
        if (!subscriptionId) {
            throw new Error('No subscription ID returned from sys_entity_agent');
        }

        return subscriptionId;
    }

    /**
     * Subscribe to requestProgress for streaming chunks
     */
    private async subscribeToProgress(subscriptionId: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // Create WebSocket client for subscription
            this.wsClient = createClient({
                url: this.wsUrl,
                webSocketImpl: WebSocket,
            });

            let resolved = false;

            this.wsClient.subscribe<RequestProgressData>(
                {
                    query: REQUEST_PROGRESS_SUBSCRIPTION,
                    variables: { requestIds: [subscriptionId] },
                },
                {
                    next: (result) => {
                        const progressData = (result.data as RequestProgressData)?.requestProgress;
                        if (!progressData) return;

                        const { data, progress, info, error } = progressData;

                        // Handle errors
                        if (error) {
                            console.error('[StreamingCortexBridge] Stream error:', error);
                            this.emit('error', new Error(error));
                            return;
                        }

                        // Process info block (tool status, etc.)
                        if (info) {
                            this.processInfo(info);
                        }

                        // Process data block (content)
                        if (data) {
                            this.processData(data);
                        }

                        // Handle completion
                        if (progress === 1) {
                            this.flushBuffer();
                            this.isProcessing = false;
                            this.emit('complete', this.fullResponse);
                            this.cleanup();
                            if (!resolved) {
                                resolved = true;
                                resolve();
                            }
                        }
                    },
                    error: (err: unknown) => {
                        console.error('[StreamingCortexBridge] Subscription error:', err);
                        this.isProcessing = false;
                        const error = err instanceof Error ? err : new Error(String(err));
                        this.emit('error', error);
                        this.cleanup();
                        if (!resolved) {
                            resolved = true;
                            reject(error);
                        }
                    },
                    complete: () => {
                        console.log('[StreamingCortexBridge] Subscription complete');
                        this.flushBuffer();
                        this.isProcessing = false;
                        this.cleanup();
                        if (!resolved) {
                            resolved = true;
                            resolve();
                        }
                    },
                }
            );
        });
    }

    /**
     * Process info block from stream
     */
    private processInfo(info: string): void {
        try {
            const parsed = typeof info === 'string' ? JSON.parse(info) : info;

            // Handle tool messages
            if (parsed.toolMessage) {
                this.handleToolMessage(parsed.toolMessage);
            }

            // Handle ephemeral flag (thinking mode)
            if (parsed.ephemeral !== undefined) {
                this.emit('thinking', !!parsed.ephemeral);
            }

        } catch (e) {
            console.warn('[StreamingCortexBridge] Failed to parse info:', e);
        }
    }

    /**
     * Handle tool status messages
     */
    private handleToolMessage(toolMessage: ToolMessage): void {
        const { type, userMessage, toolName, success, error } = toolMessage;

        if (type === 'start') {
            const event: ToolStatusEvent = {
                name: toolName || 'tool',
                status: 'running',
                message: userMessage || `Running ${toolName || 'tool'}...`,
                timestamp: Date.now(),
            };
            this.emit('tool-status', event);
            console.log('[StreamingCortexBridge] Tool started:', toolName, userMessage);

            // Speak the tool userMessage so user hears something while tool runs
            // This prevents awkward silence during tool execution
            if (userMessage && userMessage.trim().length > 0) {
                console.log('[StreamingCortexBridge] Emitting tool userMessage as sentence for TTS');
                this.fullResponse += userMessage + ' ';
                this.emit('sentence', userMessage);
            }
        } else if (type === 'finish') {
            const event: ToolStatusEvent = {
                name: toolName || 'tool',
                status: success ? 'completed' : 'error',
                message: error || (success ? 'Completed' : 'Failed'),
                timestamp: Date.now(),
            };
            this.emit('tool-status', event);
            console.log('[StreamingCortexBridge] Tool finished:', toolName, success ? 'success' : 'error');
        }
    }

    /**
     * Process data block from stream
     */
    private processData(data: string): void {
        try {
            const parsed = JSON.parse(data);

            // Skip tool call chunks
            if (parsed?.choices?.[0]?.delta?.tool_calls) {
                return;
            }

            // Extract content
            let content: string | undefined;
            if (typeof parsed === 'string') {
                content = parsed;
            } else if (parsed?.choices?.[0]?.delta?.content) {
                content = parsed.choices[0].delta.content;
            } else if (parsed?.content) {
                content = parsed.content;
            } else if (parsed?.message) {
                content = parsed.message;
            }

            if (content) {
                this.addToBuffer(content);
            }
        } catch {
            // If not JSON, treat as raw string
            if (typeof data === 'string' && data.trim()) {
                this.addToBuffer(data);
            }
        }
    }

    /**
     * Add content to buffer and emit sentences when complete
     */
    private addToBuffer(content: string): void {
        this.textBuffer += content;
        this.fullResponse += content;

        // Check for sentence boundaries
        this.emitCompleteSentences();
    }

    /**
     * Emit complete sentences from buffer
     */
    private emitCompleteSentences(): void {
        // Keep processing while we find sentence endings
        let match: RegExpExecArray | null;

        while ((match = this.SENTENCE_ENDINGS.exec(this.textBuffer)) !== null) {
            const sentenceEnd = match.index + match[0].length;
            const sentence = this.textBuffer.substring(0, sentenceEnd).trim();

            // Only emit if sentence is long enough
            if (sentence.length >= this.MIN_SENTENCE_LENGTH) {
                console.log('[StreamingCortexBridge] Emitting sentence:', sentence.substring(0, 50) + '...');
                this.emit('sentence', sentence);
            }

            // Remove processed sentence from buffer
            this.textBuffer = this.textBuffer.substring(sentenceEnd);
        }
    }

    /**
     * Flush any remaining content in buffer
     */
    private flushBuffer(): void {
        const remaining = this.textBuffer.trim();
        if (remaining.length > 0) {
            console.log('[StreamingCortexBridge] Flushing remaining:', remaining.substring(0, 50) + '...');
            this.emit('sentence', remaining);
            this.textBuffer = '';
        }
    }

    /**
     * Cleanup WebSocket connection
     */
    private cleanup(): void {
        if (this.wsClient) {
            this.wsClient.dispose();
            this.wsClient = null;
        }
    }

    /**
     * Cancel current query
     */
    cancel(): void {
        this.cleanup();
        this.isProcessing = false;
        this.textBuffer = '';
    }

    /**
     * Check if currently processing
     */
    get processing(): boolean {
        return this.isProcessing;
    }
}

// Type declaration for EventEmitter
export interface StreamingCortexBridge {
    on<K extends keyof StreamEvents>(event: K, listener: StreamEvents[K]): this;
    emit<K extends keyof StreamEvents>(event: K, ...args: Parameters<StreamEvents[K]>): boolean;
}
