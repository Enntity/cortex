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
    $stream: Boolean,
    $userInfo: String
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
        stream: $stream,
        userInfo: $userInfo
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

const SYS_GENERATOR_VOICE_FILLER_QUERY = `
query SysGeneratorVoiceFiller(
    $entityId: String,
    $chatHistory: [MultiMessage]
) {
    sys_generator_voice_filler(
        entityId: $entityId,
        chatHistory: $chatHistory
    ) {
        result
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
    userInfo?: string;
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
    'filler': (text: string) => void; // Filler phrases (not added to transcript/history)
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

    // Single chained filler timer for natural conversation flow
    private fillerTimer: ReturnType<typeof setTimeout> | null = null;
    private fillerStartTime: number = 0;
    private lastSpeechTime: number = 0; // Track when we last emitted speech
    private clientAudioPlaying: boolean = false; // Track if client is playing audio
    private hasEmittedContent: boolean = false; // Track if any real content has been emitted

    // Timing milestones for fillers (ms from start)
    // Note: acknowledgment disabled for now - was stepping on responses
    private readonly FILLER_MILESTONES = [
        // { time: 1600, category: 'acknowledgment' as const },
        { time: 4000, category: 'thinking' as const },
        { time: 10000, category: 'extended' as const },
        // Extended fillers repeat every ~4s after 10s mark
    ];
    private readonly EXTENDED_INTERVAL = 4000;
    private readonly FILLER_VARIANCE = 500; // ±500ms randomness for natural feel
    private readonly MIN_SPEECH_GAP = 3000; // Minimum 3s between any speech

    // Categorized filler phrases
    private fillers: {
        acknowledgment: string[];
        thinking: string[];
        tool: string[];
        extended: string[];
    } = {
        acknowledgment: ['Mm', 'Hmm', 'Ah', 'Mhm', 'Oh'],
        thinking: ['Let me think...', 'Hmm...', 'One moment...', 'Good question...', 'Let me see...'],
        tool: ['Working on that...', 'On it...', 'Let me check...', 'One sec...', 'Looking into it...'],
        extended: ['Still working...', 'Almost there...', 'Bear with me...', 'Just a moment longer...', 'Nearly done...']
    };
    private fillersLoaded: boolean = false;

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
            userInfo: config.userInfo,
        };
        console.log('[StreamingCortexBridge] Session context set:', {
            entityId: this.sessionContext.entityId,
            model: this.sessionContext.model,
            hasAgentContext: !!this.sessionContext.agentContext,
            hasUserInfo: !!this.sessionContext.userInfo,
        });

        // Load entity-specific fillers in the background
        this.loadFillers(config.entityId).catch((err) => {
            console.warn('[StreamingCortexBridge] Failed to load entity fillers, using defaults:', err.message);
        });
    }

    /**
     * Load categorized filler phrases from the entity via sys_generator_voice_filler
     */
    private async loadFillers(entityId: string): Promise<void> {
        if (this.fillersLoaded) return;

        try {
            const fillerController = new AbortController();
            const fillerTimeout = setTimeout(() => fillerController.abort(), 30000);

            const response = await fetch(this.httpUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: SYS_GENERATOR_VOICE_FILLER_QUERY,
                    variables: {
                        entityId,
                        chatHistory: [],
                    },
                }),
                signal: fillerController.signal,
            });

            clearTimeout(fillerTimeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            interface FillerResult {
                acknowledgment?: string[];
                thinking?: string[];
                tool?: string[];
                extended?: string[];
            }

            const data = await response.json() as {
                data?: { sys_generator_voice_filler?: { result: string | FillerResult } };
            };
            const result = data?.data?.sys_generator_voice_filler?.result;

            if (result) {
                // Parse the result - could be a JSON string or already an object
                const parsed: FillerResult = typeof result === 'string' ? JSON.parse(result) : result;

                // Validate and merge with defaults (keep defaults if category missing)
                if (parsed && typeof parsed === 'object') {
                    if (Array.isArray(parsed.acknowledgment) && parsed.acknowledgment.length > 0) {
                        this.fillers.acknowledgment = parsed.acknowledgment;
                    }
                    if (Array.isArray(parsed.thinking) && parsed.thinking.length > 0) {
                        this.fillers.thinking = parsed.thinking;
                    }
                    if (Array.isArray(parsed.tool) && parsed.tool.length > 0) {
                        this.fillers.tool = parsed.tool;
                    }
                    if (Array.isArray(parsed.extended) && parsed.extended.length > 0) {
                        this.fillers.extended = parsed.extended;
                    }
                    this.fillersLoaded = true;
                    console.log('[StreamingCortexBridge] Loaded entity fillers:', {
                        acknowledgment: this.fillers.acknowledgment.length,
                        thinking: this.fillers.thinking.length,
                        tool: this.fillers.tool.length,
                        extended: this.fillers.extended.length,
                    });
                }
            }
        } catch (error) {
            // Keep using defaults on error
            console.warn('[StreamingCortexBridge] Could not load fillers:', error);
        }
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

        // Start filler timer for long-running queries (will be stopped when content arrives)
        this.startFillerTimer();

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

        if (ctx.userInfo) {
            variables.userInfo = ctx.userInfo;
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
            this.stopFillerTimer();
            this.cleanup();
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(this.httpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
                        if (!resolved) {
                            resolved = true;
                            this.emit('complete', this.fullResponse);
                            resolve();
                        }
                        this.cleanup();
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

            // Handle app commands (e.g., showOverlay)
            if (parsed.appCommand) {
                this.handleAppCommand(parsed.appCommand);
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
     * Handle app commands from Cortex tools
     */
    private handleAppCommand(command: { type: string; items?: unknown[]; narrative?: string; [key: string]: unknown }): void {
        if (command.type === 'showOverlay' && command.items && Array.isArray(command.items)) {
            console.log('[StreamingCortexBridge] ShowOverlay command received:', command.items.length, 'items', command.narrative ? 'with narrative' : '');

            // Emit media event for overlay display
            const event: MediaEvent = {
                type: 'overlay',
                items: command.items as MediaEvent['items'],
            };
            this.emit('media', event);

            // If there's a narrative, queue it for TTS
            if (command.narrative && typeof command.narrative === 'string' && command.narrative.trim()) {
                console.log('[StreamingCortexBridge] Queuing narrative for TTS:', command.narrative.substring(0, 50) + '...');
                // Add to full response for history
                this.fullResponse += command.narrative + ' ';
                // Emit as sentence for TTS
                this.emitSpeech(command.narrative.trim());
            }
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

            // Emit a tool-specific filler immediately (if appropriate)
            this.emitToolFiller();

        } else if (type === 'finish') {
            // Stop filler timers when tool completes
            this.stopFillerTimer();

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

        // Clean markdown images BEFORE sentence splitting
        // (prevents TTS from speaking URLs if model uses markdown)
        this.cleanMarkdownFromBuffer();

        // Check for sentence boundaries
        this.emitCompleteSentences();
    }

    /**
     * Clean markdown images from buffer to prevent TTS speaking URLs
     * Media display should use ShowOverlay tool, not inline markdown
     */
    private cleanMarkdownFromBuffer(): void {
        // Match complete markdown images: ![alt](url)
        const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

        // Replace markdown with just alt text to prevent TTS from speaking URLs
        this.textBuffer = this.textBuffer.replace(imageRegex, (_, alt) => alt ? `[${alt}]` : '');
        this.fullResponse = this.fullResponse.replace(imageRegex, (_, alt) => alt ? `[${alt}]` : '');
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
                this.emitSentence(sentence);
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
            this.emitSentence(remaining);
            this.textBuffer = '';
        }
    }

    /**
     * Emit speech, tracking timing for natural pacing
     */
    private emitSpeech(text: string): void {
        this.lastSpeechTime = Date.now();
        this.emit('sentence', text);
    }

    /**
     * Emit a sentence and stop filler timers (real content has arrived)
     */
    private emitSentence(text: string): void {
        this.stopFillerTimer(); // Stop all fillers - real content is here
        this.hasEmittedContent = true; // Mark that we have real content

        // Clean any remaining markdown from text (in case it wasn't caught in buffer)
        const cleanText = this.cleanMarkdownFromText(text);

        // Emit the cleaned text for TTS
        if (cleanText.trim()) {
            this.emitSpeech(cleanText.trim());
        }
    }

    /**
     * Clean markdown syntax from text to prevent TTS speaking URLs
     */
    private cleanMarkdownFromText(text: string): string {
        let cleanText = text;

        // Remove ![alt](url) syntax, keep alt text
        cleanText = cleanText.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => alt || '');

        // Remove [label](url) syntax for media files, keep label
        cleanText = cleanText.replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov)\)/gi, (_, label) => label || '');

        // Clean up any double spaces
        cleanText = cleanText.replace(/\s+/g, ' ').trim();

        return cleanText;
    }

    /**
     * Start the filler timer chain for natural conversation flow
     * Single timer that fires at milestones: 800ms, 2s, 5s, 7s, 9s...
     */
    private startFillerTimer(): void {
        this.stopFillerTimer();
        this.fillerStartTime = Date.now();
        this.hasEmittedContent = false;
        this.scheduleNextFiller();
    }

    /**
     * Schedule the next filler based on elapsed time
     */
    private scheduleNextFiller(): void {
        const elapsed = Date.now() - this.fillerStartTime;

        // Find the next milestone we haven't passed yet
        let nextTime: number;
        let category: 'acknowledgment' | 'thinking' | 'extended';

        // Check fixed milestones first
        const nextMilestone = this.FILLER_MILESTONES.find(m => m.time > elapsed);
        if (nextMilestone) {
            nextTime = nextMilestone.time;
            category = nextMilestone.category;
        } else {
            // Past all fixed milestones - schedule repeating extended fillers
            const lastFixedTime = this.FILLER_MILESTONES[this.FILLER_MILESTONES.length - 1].time;
            const timeSinceLast = elapsed - lastFixedTime;
            const intervalsPassed = Math.floor(timeSinceLast / this.EXTENDED_INTERVAL);
            nextTime = lastFixedTime + ((intervalsPassed + 1) * this.EXTENDED_INTERVAL);
            category = 'extended';
        }

        // Add randomness to feel more natural (±FILLER_VARIANCE ms)
        const variance = Math.floor(Math.random() * this.FILLER_VARIANCE * 2) - this.FILLER_VARIANCE;
        const delay = Math.max(50, (nextTime - elapsed) + variance); // Ensure at least 50ms delay

        this.fillerTimer = setTimeout(() => {
            const didEmit = this.shouldEmitFiller();
            if (didEmit) {
                this.emitFiller(category);
            }
            // Chain to next filler (will stop naturally when hasEmittedContent or !isProcessing)
            if (this.isProcessing && !this.hasEmittedContent) {
                // If we just emitted, wait at least MIN_SPEECH_GAP before scheduling next
                const nextDelay = didEmit ? this.MIN_SPEECH_GAP : 0;
                this.fillerTimer = setTimeout(() => {
                    if (this.isProcessing && !this.hasEmittedContent) {
                        this.scheduleNextFiller();
                    }
                }, nextDelay);
            }
        }, delay);
    }

    /**
     * Check if we should emit a filler (processing, not playing audio, respects speech gap)
     */
    private shouldEmitFiller(): boolean {
        if (!this.isProcessing) return false;
        if (this.hasEmittedContent) return false; // Real content has started, no more fillers
        if (this.clientAudioPlaying) {
            console.log('[StreamingCortexBridge] Skipping filler - client audio is playing');
            return false;
        }

        // Check minimum gap since last speech
        const timeSinceLastSpeech = Date.now() - this.lastSpeechTime;
        if (timeSinceLastSpeech < this.MIN_SPEECH_GAP) {
            console.log('[StreamingCortexBridge] Skipping filler - too soon since last speech');
            return false;
        }

        return true;
    }

    /**
     * Emit a filler phrase from the specified category
     * Fillers are spoken but not added to transcript/history
     */
    private emitFiller(category: 'acknowledgment' | 'thinking' | 'tool' | 'extended'): void {
        const phrases = this.fillers[category];
        if (!phrases || phrases.length === 0) return;

        // Pick a random phrase from the category
        const phrase = phrases[Math.floor(Math.random() * phrases.length)];
        console.log(`[StreamingCortexBridge] Emitting ${category} filler:`, phrase);

        // Emit as filler (not sentence) - won't be added to transcript/history
        this.lastSpeechTime = Date.now();
        this.emit('filler', phrase);
    }

    /**
     * Emit a tool-specific filler (called when tools start)
     */
    private emitToolFiller(): void {
        if (this.shouldEmitFiller()) {
            this.emitFiller('tool');
        }
    }

    /**
     * Set client audio playing state - used to skip fillers when audio is already playing
     */
    setClientAudioPlaying(playing: boolean): void {
        this.clientAudioPlaying = playing;
        console.log('[StreamingCortexBridge] Client audio playing:', playing);
    }

    /**
     * Stop the filler timer
     */
    private stopFillerTimer(): void {
        if (this.fillerTimer) {
            clearTimeout(this.fillerTimer);
            this.fillerTimer = null;
        }
    }

    /**
     * Cleanup WebSocket connection and timers
     */
    private cleanup(): void {
        this.stopFillerTimer();
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
        this.lastSpeechTime = 0;
        this.hasEmittedContent = false;
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
