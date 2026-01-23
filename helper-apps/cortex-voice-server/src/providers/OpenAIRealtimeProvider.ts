/**
 * OpenAI Realtime API Voice Provider
 *
 * Uses OpenAI's native realtime WebSocket API for lowest latency voice interaction.
 * Supports voice-to-voice with server-side VAD and interruption handling.
 */

import WebSocket from 'ws';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
} from '../types.js';

const REALTIME_API_URL = 'wss://api.openai.com/v1/realtime';
const MODEL = 'gpt-4o-realtime-preview-2024-12-17';

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

    constructor(cortexBridge: ICortexBridge, private apiKey: string) {
        super(cortexBridge);
    }

    private generateEventId(): string {
        return `evt_${++this.eventId}`;
    }

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

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
                this.configureSession(config);
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

    private configureSession(config: VoiceConfig): void {
        // Available voices: alloy, ash, ballad, coral, sage, shimmer, verse, echo
        // ash, coral, sage, verse are more natural/expressive
        const voice = config.voiceId || 'verse';

        const sessionConfig = {
            event_id: this.generateEventId(),
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: this.buildSystemInstructions(config),
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
                    description: 'Query the Cortex entity agent for information, execute tools, and get responses. Use this for any request that requires accessing entity knowledge, executing actions, or getting intelligent responses.',
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

    private buildSystemInstructions(config: VoiceConfig): string {
        return `You are a voice assistant for an entity system. Your role is to help users interact with the entity "${config.entityId}" through natural voice conversation.

IMPORTANT GUIDELINES:
1. Keep responses concise and conversational - this is voice, not text
2. Use the cortex_query tool for ANY request that requires:
   - Searching for information
   - Executing entity tools
   - Getting intelligent responses based on entity context
   - Accessing entity memory or knowledge
3. When using tools, provide brief verbal acknowledgment like "Let me check that" or "One moment"
4. Never fabricate information - always use cortex_query for factual queries
5. Be natural and engaging - use appropriate pacing and tone for voice
6. If the user asks you to do something the entity can do, use cortex_query

The entity has access to many tools including search, image generation, calculations, and more. Always route tool requests through cortex_query.`;
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
                }
                break;

            case 'response.created':
                this.setState('processing');
                break;

            case 'response.audio_transcript.delta':
                // Assistant transcript streaming
                if (event.delta) {
                    this.emit('transcript', {
                        type: 'assistant',
                        content: event.delta,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }
                break;

            case 'response.audio_transcript.done':
                // Final assistant transcript
                if (event.transcript) {
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
                }
                break;

            case 'response.audio.delta':
                // Audio chunk from assistant
                if (event.delta) {
                    this.setState('speaking');
                    this.emit('audio', {
                        data: event.delta,
                        sampleRate: 24000,
                    });
                }
                break;

            case 'response.audio.done':
                // Audio response complete
                break;

            case 'response.done':
                this.setState('idle');
                break;

            case 'response.function_call_arguments.done':
                // Tool call complete, execute it
                this.handleToolCall(event);
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

        if (name === 'cortex_query' && args.query) {
            this.emit('tool-status', {
                name: 'cortex_query',
                status: 'running',
                message: 'Processing your request...',
                timestamp: Date.now(),
            });

            try {
                const response = await this.cortexBridge.query(
                    args.query,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8)
                );

                this.emit('tool-status', {
                    name: response.tool || 'cortex_query',
                    status: 'completed',
                    message: 'Done',
                    timestamp: Date.now(),
                });

                // Send tool result back to OpenAI
                this.send({
                    event_id: this.generateEventId(),
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: callId,
                        output: response.result,
                    },
                });

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
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
    }

    sendAudio(data: AudioData): void {
        if (!this.ws || !this._isConnected || this._isMuted) {
            return;
        }

        this.send({
            event_id: this.generateEventId(),
            type: 'input_audio_buffer.append',
            audio: data.data,
        });
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
    }

    interrupt(): void {
        if (!this.ws || !this._isConnected) {
            return;
        }

        this.send({
            event_id: this.generateEventId(),
            type: 'response.cancel',
        });
    }
}
