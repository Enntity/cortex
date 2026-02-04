/**
 * OpenAI Realtime API Voice Provider
 *
 * Uses OpenAI's native realtime WebSocket API for lowest latency voice interaction.
 * Supports voice-to-voice with server-side VAD and interruption handling.
 * Enriched with entity identity, continuity memory, voice style, and greeting.
 */

import WebSocket from 'ws';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
    EntitySessionContext,
} from '../types.js';

const REALTIME_API_URL = 'wss://api.openai.com/v1/realtime';
const MODEL = 'gpt-4o-realtime-preview-2024-12-17';

const MEMORY_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const TURNS_BEFORE_REFRESH = 10;

interface RealtimeEvent {
    type: string;
    event_id?: string;
    [key: string]: any;
}

export class OpenAIRealtimeProvider extends BaseVoiceProvider {
    readonly type: VoiceProviderType = 'openai-realtime';

    private ws: WebSocket | null = null;
    private conversationHistory: ConversationMessage[] = [];
    private eventId: number = 0;
    private memoryRefreshInterval: NodeJS.Timeout | null = null;
    private turnsSinceRefresh: number = 0;
    private sessionContext: EntitySessionContext | null = null;
    private pendingAssistantTranscript: string = '';
    private audioPlaying: boolean = false;
    private aiResponding: boolean = false;
    private currentAudioTrackId: string | null = null;
    private audioTrackCounter: number = 0;

    constructor(cortexBridge: ICortexBridge, private apiKey: string) {
        super(cortexBridge);
    }

    private generateEventId(): string {
        return `evt_${++this.eventId}`;
    }

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

        // Fetch entity context and voice sample in parallel
        const [sessionContext, voiceSampleText] = await Promise.all([
            this.cortexBridge.getSessionContext?.() ?? Promise.resolve(null),
            this.cortexBridge.getVoiceSampleText?.(config.entityId) ?? Promise.resolve(null),
        ]);

        this.sessionContext = sessionContext;

        return new Promise((resolve, reject) => {
            const url = `${REALTIME_API_URL}?model=${MODEL}`;

            this.ws = new WebSocket(url, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'OpenAI-Beta': 'realtime=v1',
                },
            });

            this.ws.on('open', () => {
                console.log(`[OpenAI Realtime] WebSocket connected`);
                this.setConnected(true);
                this.configureSession(config, sessionContext, voiceSampleText);
                this.sendGreeting(sessionContext);
                this.startMemoryRefresh();
                resolve();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const event: RealtimeEvent = JSON.parse(data.toString());
                    this.handleEvent(event);
                } catch (error) {
                    console.error('[OpenAI Realtime] Failed to parse message:', error);
                }
            });

            this.ws.on('error', (error) => {
                console.error('[OpenAI Realtime] WebSocket error:', error);
                this.emitError(error);
                reject(error);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[OpenAI Realtime] WebSocket closed: ${code} ${reason}`);
                this.setConnected(false);
                this.setState('idle');
            });
        });
    }

    private configureSession(
        config: VoiceConfig,
        sessionContext: EntitySessionContext | null,
        voiceSampleText: string | null,
    ): void {
        const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
        const voice = (config.voiceId && validVoices.includes(config.voiceId)) ? config.voiceId : 'verse';
        if (config.voiceId && !validVoices.includes(config.voiceId)) {
            console.warn(`[OpenAI Realtime] Voice '${config.voiceId}' not supported, falling back to '${voice}'`);
        }

        const sessionConfig = {
            event_id: this.generateEventId(),
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: this.buildSystemInstructions(config, sessionContext, voiceSampleText),
                voice,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                input_audio_transcription: {
                    model: 'whisper-1',
                },
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                },
                tools: [{
                    type: 'function',
                    name: 'cortex_query',
                    description: 'Query the entity\'s intelligent agent for information, tool execution, and capabilities. Use this for ANY request involving: web search, image/video generation, code execution, document analysis, complex reasoning, real-time data, entity memory, or specialized tools. Provide a clear, detailed description of what\'s needed — the agent selects the best approach.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'The user query or request to process',
                            },
                        },
                        required: ['query'],
                    },
                }],
                tool_choice: 'auto',
                temperature: 0.8,
                max_response_output_tokens: 4096,
            },
        };

        this.send(sessionConfig);
    }

    private buildSystemInstructions(
        config: VoiceConfig,
        sessionContext: EntitySessionContext | null,
        voiceSampleText: string | null,
    ): string {
        const entityName = sessionContext?.entityName || config.aiName || config.entityId;
        const parts: string[] = [];

        // Entity identity
        parts.push(`You are ${entityName}.`);
        if (sessionContext?.identity) {
            parts.push('');
            parts.push(sessionContext.identity);
        }

        // Continuity memory
        if (sessionContext?.continuityContext) {
            parts.push('');
            parts.push(sessionContext.continuityContext);
        }

        // Voice style examples
        if (voiceSampleText) {
            parts.push('');
            parts.push('## Your Voice & Style');
            parts.push('The following are examples of your speaking style. Match this tone and personality:');
            parts.push(voiceSampleText);
        }

        // Voice delivery instructions (set by SocketServer from VOICE_PROVIDER_INSTRUCTIONS)
        const voiceInstructions = config.voiceProviderInstructions;
        if (voiceInstructions) {
            parts.push('');
            parts.push(voiceInstructions);
        }

        // Tool guidance
        parts.push('');
        parts.push(`## Tools
You have access to a powerful entity agent via the cortex_query tool. Use it for:
- Searching the web or knowledge bases
- Generating, editing, or finding images and videos
- Executing code or interacting with workspaces
- Accessing memories and knowledge beyond what's in your context
- Complex reasoning, analysis, or multi-step tasks
- Any request that requires real-time information

When using cortex_query, provide a clear description of the user's intent.
Do NOT fabricate information — use cortex_query if you're unsure.
Briefly acknowledge tool use naturally: "Let me check that" / "One moment"`);

        // User context and datetime
        parts.push('');
        parts.push('## Context');
        parts.push(`The current date and time is ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}.`);
        if (config.userName) {
            parts.push(`You are speaking with ${config.userName}.`);
        }
        if (config.userInfo) {
            parts.push(config.userInfo);
        }

        // Voice-specific formatting
        parts.push('');
        parts.push(`## Response Format
Keep responses concise and conversational — this is voice, not text.
Do not use markdown formatting, bullet points, or numbered lists.
Speak naturally as you would in conversation.`);

        return parts.join('\n');
    }

    private sendGreeting(sessionContext: EntitySessionContext | null): void {
        const entityName = sessionContext?.entityName || this._config?.aiName || 'the assistant';

        this.send({
            event_id: this.generateEventId(),
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: `<INSTRUCTIONS>Greet the user briefly and naturally, like answering a phone call. Be warm but concise. Stay in character as ${entityName}.</INSTRUCTIONS>`,
                }],
            },
        });
        this.send({
            event_id: this.generateEventId(),
            type: 'response.create',
        });
    }

    private startMemoryRefresh(): void {
        this.stopMemoryRefresh();
        this.turnsSinceRefresh = 0;

        this.memoryRefreshInterval = setInterval(async () => {
            await this.refreshMemory();
        }, MEMORY_REFRESH_INTERVAL_MS);
    }

    private stopMemoryRefresh(): void {
        if (this.memoryRefreshInterval) {
            clearInterval(this.memoryRefreshInterval);
            this.memoryRefreshInterval = null;
        }
    }

    private async refreshMemory(): Promise<void> {
        if (!this.sessionContext?.useMemory) return;
        if (!this.cortexBridge.getSessionContext) return;

        try {
            const updated = await this.cortexBridge.getSessionContext();
            if (!updated) return;

            this.sessionContext = updated;
            this.turnsSinceRefresh = 0;

            // Rebuild instructions with fresh memory and send session.update
            const instructions = this.buildSystemInstructions(
                this._config!,
                this.sessionContext,
                null, // voice sample doesn't change, omit to keep prompt shorter on refresh
            );

            this.send({
                event_id: this.generateEventId(),
                type: 'session.update',
                session: { instructions },
            });

            console.log('[OpenAI Realtime] Memory refreshed, instructions updated');
        } catch (error) {
            console.warn('[OpenAI Realtime] Memory refresh failed:', error);
        }
    }

    private send(event: RealtimeEvent): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(event));
        }
    }

    private handleEvent(event: RealtimeEvent): void {
        switch (event.type) {
            case 'session.created':
            case 'session.updated':
                console.log(`[OpenAI Realtime] Session ${event.type}`);
                this.setState('idle');
                break;

            case 'input_audio_buffer.speech_started':
                this.setState('listening');
                break;

            case 'input_audio_buffer.speech_stopped':
                this.setState('processing');
                break;

            case 'conversation.item.input_audio_transcription.completed':
                // User's speech transcribed
                if (event.transcript) {
                    console.log(`[OpenAI Realtime] User transcript: "${event.transcript.substring(0, 80)}"`);

                    this.emit('transcript', {
                        type: 'user',
                        content: event.transcript,
                        isFinal: true,
                        timestamp: Date.now(),
                    });
                    this.conversationHistory.push({
                        role: 'user',
                        content: event.transcript,
                        timestamp: Date.now(),
                    });
                    this.turnsSinceRefresh++;

                    if (this.conversationHistory.length > 100) {
                        this.conversationHistory = this.conversationHistory.slice(-100);
                    }

                    // Refresh memory after enough turns
                    if (this.turnsSinceRefresh >= TURNS_BEFORE_REFRESH) {
                        this.refreshMemory();
                    }
                }
                break;

            case 'response.created':
                this.pendingAssistantTranscript = '';
                this.aiResponding = true;
                this.currentAudioTrackId = null; // Will be set on first audio delta
                this.setState('processing');
                break;

            case 'response.audio_transcript.delta':
                // Assistant transcript streaming — accumulate deltas for display
                if (event.delta) {
                    this.pendingAssistantTranscript += event.delta;
                    this.emit('transcript', {
                        type: 'assistant',
                        content: this.pendingAssistantTranscript,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }
                break;

            case 'response.audio_transcript.done':
                // Final assistant transcript
                this.pendingAssistantTranscript = '';
                if (event.transcript) {
                    console.log(`[OpenAI Realtime] Assistant transcript: "${event.transcript.substring(0, 80)}"`);

                    this.emit('transcript', {
                        type: 'assistant',
                        content: event.transcript,
                        isFinal: true,
                        timestamp: Date.now(),
                    });
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: event.transcript,
                        timestamp: Date.now(),
                    });

                    if (this.conversationHistory.length > 100) {
                        this.conversationHistory = this.conversationHistory.slice(-100);
                    }
                }
                break;

            case 'response.audio.delta':
                // Audio chunk from assistant
                if (event.delta) {
                    // Emit track-start on first audio chunk of a response
                    if (!this.currentAudioTrackId) {
                        this.currentAudioTrackId = `rt_${++this.audioTrackCounter}`;
                        this.emit('track-start', {
                            trackId: this.currentAudioTrackId,
                            text: this.pendingAssistantTranscript || '',
                        });
                    }
                    this.audioPlaying = true;
                    this.setState('speaking');
                    this.emit('audio', {
                        data: event.delta,
                        sampleRate: 24000,
                        trackId: this.currentAudioTrackId,
                    });
                }
                break;

            case 'response.audio.done':
                console.log('[OpenAI Realtime] Audio stream complete');
                // Emit track-complete so the client knows to flush and report playback done
                if (this.currentAudioTrackId) {
                    this.emit('track-complete', { trackId: this.currentAudioTrackId });
                    this.currentAudioTrackId = null;
                }
                // audioPlaying will be cleared by onAudioPlaybackComplete() from client.
                // Safety fallback after a shorter delay (client should report via track complete).
                setTimeout(() => {
                    if (this.audioPlaying) {
                        console.log('[OpenAI Realtime] Audio playback safety timeout - releasing gate');
                        this.audioPlaying = false;
                    }
                }, 3000);
                break;

            case 'response.done': {
                this.aiResponding = false;
                // Log response summary for diagnostics
                const resp = event.response;
                if (resp) {
                    const outputTypes = resp.output?.map((o: any) => o.type) || [];
                    const status = resp.status;
                    console.log(`[OpenAI Realtime] Response done: status=${status}, outputs=[${outputTypes.join(', ')}]`);
                    if (status === 'failed' || status === 'incomplete') {
                        console.warn(`[OpenAI Realtime] Response ${status}:`, resp.status_details);
                    }
                    if (status === 'cancelled') {
                        this.audioPlaying = false;
                        this.currentAudioTrackId = null;
                    }
                }
                this.setState('idle');
                break;
            }

            case 'response.function_call_arguments.done':
                // Tool call complete, execute it
                this.handleToolCall(event);
                break;

            case 'response.content_part.added':
                console.log(`[OpenAI Realtime] Content part: ${event.part?.type || 'unknown'}`);
                break;

            case 'response.text.done':
                // Text-only response (no audio) — log and emit as transcript
                if (event.text) {
                    console.log(`[OpenAI Realtime] Text-only response (no audio): ${event.text.substring(0, 80)}...`);
                    this.emit('transcript', {
                        type: 'assistant',
                        content: event.text,
                        isFinal: true,
                        timestamp: Date.now(),
                    });
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: event.text,
                        timestamp: Date.now(),
                    });
                    if (this.conversationHistory.length > 100) {
                        this.conversationHistory = this.conversationHistory.slice(-100);
                    }
                }
                break;

            case 'error':
                console.error('[OpenAI Realtime] API error:', event.error);
                this.emitError(new Error(event.error?.message || 'Unknown error'));
                break;

            default:
                // Log unhandled events in debug
                if (event.type && !event.type.includes('.delta')) {
                    console.log(`[OpenAI Realtime] Event: ${event.type}`);
                }
        }
    }

    private async handleToolCall(event: RealtimeEvent): Promise<void> {
        const callId = event.call_id;
        const name = event.name;
        let args: any = {};

        try {
            args = JSON.parse(event.arguments || '{}');
        } catch (e) {
            console.error('[OpenAI Realtime] Failed to parse tool arguments:', e);
        }

        console.log(`[OpenAI Realtime] Tool call: ${name}, args: ${JSON.stringify(args).substring(0, 100)}`);

        if (name === 'cortex_query' && args.query) {
            this.emit('tool-status', {
                name: 'cortex_query',
                status: 'running',
                message: 'Processing your request...',
                timestamp: Date.now(),
            });

            try {
                // Filter out <INSTRUCTIONS> messages from history sent to Cortex
                const filteredHistory = this.conversationHistory.filter(
                    msg => !msg.content.trim().startsWith('<INSTRUCTIONS>')
                );

                // Append the query as a user message so sys_entity_agent sees it
                // in chatHistory. The text parameter alone is not enough — the
                // prompt template expands {{chatHistory}} into messages but has
                // no {{text}} placeholder, so the query must be in the history.
                const historyWithQuery: ConversationMessage[] = [
                    ...filteredHistory.slice(-8),
                    { role: 'user', content: args.query, timestamp: Date.now() },
                ];

                const response = await this.cortexBridge.query(
                    args.query,
                    this._config!.entityId,
                    historyWithQuery
                );

                const result = response.result?.trim();

                if (!result) {
                    // Model returned empty — tell the realtime model to answer directly
                    console.warn('[OpenAI Realtime] cortex_query returned empty result for:', args.query);
                    this.emit('tool-status', {
                        name: 'cortex_query',
                        status: 'completed',
                        message: 'No result — answering directly',
                        timestamp: Date.now(),
                    });

                    this.send({
                        event_id: this.generateEventId(),
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: callId,
                            output: 'The agent could not retrieve results for this query. Please answer based on your own knowledge, or let the user know you were unable to look that up right now.',
                        },
                    });
                } else {
                    this.emit('tool-status', {
                        name: response.tool || 'cortex_query',
                        status: 'completed',
                        message: 'Done',
                        timestamp: Date.now(),
                    });

                    this.send({
                        event_id: this.generateEventId(),
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: callId,
                            output: result,
                        },
                    });
                }

                // Trigger response generation
                this.send({
                    event_id: this.generateEventId(),
                    type: 'response.create',
                });

            } catch (error) {
                this.emit('tool-status', {
                    name: 'cortex_query',
                    status: 'error',
                    message: (error as Error).message,
                    timestamp: Date.now(),
                });

                // Send error result
                this.send({
                    event_id: this.generateEventId(),
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: callId,
                        output: `Error: ${(error as Error).message}`,
                    },
                });

                this.send({
                    event_id: this.generateEventId(),
                    type: 'response.create',
                });
            }
        }
    }

    async disconnect(): Promise<void> {
        this.stopMemoryRefresh();
        this.audioPlaying = false;
        this.aiResponding = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
        this.sessionContext = null;
    }

    sendAudio(data: AudioData): void {
        if (!this.ws || !this._isConnected || this._isMuted) {
            return;
        }

        // Don't forward mic audio while the AI's audio is playing on the client
        // This prevents the echo feedback loop (speakers → mic → model → speakers)
        if (this.audioPlaying || this.aiResponding) {
            return;
        }

        this.send({
            event_id: this.generateEventId(),
            type: 'input_audio_buffer.append',
            audio: data.data,
        });
    }

    /**
     * Called by SocketServer when the client reports audio playback is complete.
     * Clears the audioPlaying gate so mic input resumes.
     */
    onAudioPlaybackComplete(): void {
        this.audioPlaying = false;
    }

    async sendText(text: string): Promise<void> {
        if (!this.ws || !this._isConnected) {
            throw new Error('Not connected');
        }

        this.conversationHistory.push({
            role: 'user',
            content: text,
            timestamp: Date.now(),
        });
        this.turnsSinceRefresh++;

        if (this.conversationHistory.length > 100) {
            this.conversationHistory = this.conversationHistory.slice(-100);
        }

        this.emit('transcript', {
            type: 'user',
            content: text,
            isFinal: true,
            timestamp: Date.now(),
        });

        // Create user message
        this.send({
            event_id: this.generateEventId(),
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text,
                }],
            },
        });

        // Trigger response
        this.send({
            event_id: this.generateEventId(),
            type: 'response.create',
        });

        // Refresh memory after enough turns
        if (this.turnsSinceRefresh >= TURNS_BEFORE_REFRESH) {
            this.refreshMemory();
        }
    }

    interrupt(): void {
        if (!this.ws || !this._isConnected) {
            return;
        }

        this.audioPlaying = false;
        this.aiResponding = false;
        this.currentAudioTrackId = null;
        this.send({
            event_id: this.generateEventId(),
            type: 'response.cancel',
        });
    }
}
