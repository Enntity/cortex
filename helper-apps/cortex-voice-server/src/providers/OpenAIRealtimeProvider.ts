/**
 * OpenAI Realtime API Voice Provider
 *
 * Uses OpenAI's native realtime WebSocket API for lowest latency voice interaction.
 * Supports voice-to-voice with server-side VAD and interruption handling.
 */

import { RealtimeClient } from '@openai/realtime-api-beta';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
} from '../types.js';

// Filler messages for tool execution
const FILLER_MESSAGES = [
    "Let me look that up for you.",
    "One moment while I check that.",
    "I'll find that information for you.",
    "Give me just a second.",
    "Let me see what I can find.",
];

export class OpenAIRealtimeProvider extends BaseVoiceProvider {
    readonly type: VoiceProviderType = 'openai-realtime';

    private client: RealtimeClient | null = null;
    private conversationHistory: ConversationMessage[] = [];
    private currentTranscript: string = '';
    private isProcessingTool: boolean = false;
    private pendingToolResponse: string | null = null;

    constructor(cortexBridge: ICortexBridge, private apiKey: string) {
        super(cortexBridge);
    }

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

        try {
            this.client = new RealtimeClient({
                apiKey: this.apiKey,
            });

            // Configure session
            await this.client.updateSession({
                modalities: ['text', 'audio'],
                instructions: this.buildSystemInstructions(config),
                voice: 'alloy',
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
            });

            // Add the cortex tool for entity agent queries
            await this.client.addTool(
                {
                    name: 'cortex_query',
                    description: 'Query the Cortex entity agent for information, execute tools, and get responses. Use this for any request that requires accessing the entity\'s knowledge, executing actions, or getting intelligent responses.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'The user\'s query or request to process',
                            },
                        },
                        required: ['query'],
                    },
                },
                async ({ query }: { query: string }) => {
                    return await this.handleCortexQuery(query);
                }
            );

            this.setupEventHandlers();

            await this.client.connect();
            this.setConnected(true);
            this.setState('idle');

            console.log(`[OpenAI Realtime] Connected for entity: ${config.entityId}`);
        } catch (error) {
            this.emitError(error as Error);
            throw error;
        }
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

    private setupEventHandlers(): void {
        if (!this.client) return;

        // Handle input audio transcription
        this.client.on('conversation.updated', (event: any) => {
            const { item } = event;

            if (item.role === 'user' && item.formatted?.transcript) {
                this.currentTranscript = item.formatted.transcript;
                this.emit('transcript', {
                    type: 'user',
                    content: this.currentTranscript,
                    isFinal: item.status === 'completed',
                    timestamp: Date.now(),
                });

                if (item.status === 'completed') {
                    this.conversationHistory.push({
                        role: 'user',
                        content: this.currentTranscript,
                        timestamp: Date.now(),
                    });
                    this.currentTranscript = '';
                }
            }

            if (item.role === 'assistant') {
                if (item.formatted?.transcript) {
                    this.emit('transcript', {
                        type: 'assistant',
                        content: item.formatted.transcript,
                        isFinal: item.status === 'completed',
                        timestamp: Date.now(),
                    });
                }

                if (item.status === 'completed' && item.formatted?.transcript) {
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: item.formatted.transcript,
                        timestamp: Date.now(),
                    });
                }
            }
        });

        // Handle audio output
        this.client.on('conversation.item.audio', (event: any) => {
            if (event.audio) {
                this.setState('speaking');
                this.emit('audio', {
                    data: event.audio,
                    sampleRate: 24000,
                });
            }
        });

        // Handle audio done
        this.client.on('conversation.item.audio.completed', () => {
            this.setState('idle');
        });

        // Handle speech detection
        this.client.on('input_audio_buffer.speech_started', () => {
            this.setState('listening');
        });

        this.client.on('input_audio_buffer.speech_stopped', () => {
            this.setState('processing');
        });

        // Handle responses
        this.client.on('response.created', () => {
            if (!this.isProcessingTool) {
                this.setState('processing');
            }
        });

        this.client.on('response.done', () => {
            if (!this.isProcessingTool) {
                this.setState('idle');
            }
        });

        // Handle errors
        this.client.on('error', (error: any) => {
            console.error('[OpenAI Realtime] Error:', error);
            this.emitError(new Error(error.message || 'Unknown realtime error'));
        });

        // Handle disconnection
        this.client.on('close', () => {
            this.setConnected(false);
            this.setState('idle');
        });
    }

    private async handleCortexQuery(query: string): Promise<string> {
        this.isProcessingTool = true;

        try {
            // Emit tool status
            this.emit('tool-status', {
                name: 'cortex_query',
                status: 'running',
                message: 'Processing your request...',
                timestamp: Date.now(),
            });

            // Query the Cortex entity agent
            const response = await this.cortexBridge.query(
                query,
                this._config!.entityId,
                this.conversationHistory.slice(-8) // Last 8 messages for context
            );

            // Handle media events if present
            if (response.tool?.includes('image') || response.tool?.includes('media')) {
                // Parse media URLs from response if present
                const mediaUrls = this.extractMediaUrls(response.result);
                if (mediaUrls.length > 0) {
                    this.emit('media', {
                        type: mediaUrls.length > 1 ? 'slideshow' : 'image',
                        urls: mediaUrls,
                    });
                }
            }

            // Emit completion status
            this.emit('tool-status', {
                name: response.tool || 'cortex_query',
                status: 'completed',
                message: 'Done',
                timestamp: Date.now(),
            });

            // Handle errors/warnings
            if (response.errors && response.errors.length > 0) {
                console.warn('[OpenAI Realtime] Cortex errors:', response.errors);
            }
            if (response.warnings && response.warnings.length > 0) {
                console.warn('[OpenAI Realtime] Cortex warnings:', response.warnings);
            }

            return response.result;
        } catch (error) {
            this.emit('tool-status', {
                name: 'cortex_query',
                status: 'error',
                message: (error as Error).message,
                timestamp: Date.now(),
            });

            return `I encountered an error while processing your request: ${(error as Error).message}`;
        } finally {
            this.isProcessingTool = false;
        }
    }

    private extractMediaUrls(text: string): string[] {
        // Extract URLs that look like media (images, videos)
        const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|webp|mp4|webm)/gi;
        const matches = text.match(urlRegex);
        return matches || [];
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            try {
                await this.client.disconnect();
            } catch (error) {
                console.error('[OpenAI Realtime] Error disconnecting:', error);
            }
            this.client = null;
        }

        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
        this.currentTranscript = '';
    }

    sendAudio(data: AudioData): void {
        if (!this.client || !this._isConnected || this._isMuted) {
            return;
        }

        try {
            this.client.appendInputAudio(data.data);
        } catch (error) {
            console.error('[OpenAI Realtime] Error sending audio:', error);
        }
    }

    async sendText(text: string): Promise<void> {
        if (!this.client || !this._isConnected) {
            throw new Error('Not connected');
        }

        try {
            // Add to conversation history
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

            // Send as user message
            await this.client.sendUserMessageContent([
                { type: 'input_text', text },
            ]);
        } catch (error) {
            this.emitError(error as Error);
            throw error;
        }
    }

    interrupt(): void {
        if (!this.client || !this._isConnected) {
            return;
        }

        try {
            this.client.cancelResponse();
        } catch (error) {
            console.error('[OpenAI Realtime] Error interrupting:', error);
        }
    }
}
