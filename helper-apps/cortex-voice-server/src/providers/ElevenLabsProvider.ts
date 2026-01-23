/**
 * ElevenLabs Voice Provider (Streaming)
 *
 * High-quality TTS with natural voices and voice cloning capability.
 * Supports streaming responses from Cortex - sentences are spoken as they arrive.
 * Pipeline: STT (Whisper) -> Cortex Agent (streaming) -> TTS (ElevenLabs) per sentence
 */

import OpenAI from 'openai';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
    ToolStatusEvent,
} from '../types.js';
import { StreamingCortexBridge } from '../cortex/StreamingCortexBridge.js';

export class ElevenLabsProvider extends BaseVoiceProvider {
    readonly type: VoiceProviderType = 'elevenlabs';

    private openai: OpenAI;
    private elevenlabs: ElevenLabsClient;
    private conversationHistory: ConversationMessage[] = [];
    private audioBuffer: Buffer[] = [];
    private isProcessing: boolean = false;
    private voiceId: string = 'pNInz6obpgDQGcFmaJgB'; // Default: Adam

    // Streaming support
    private streamingBridge: StreamingCortexBridge | null = null;
    private sentenceQueue: string[] = [];
    private isSpeaking: boolean = false;
    private currentTrackId: number = 0;

    constructor(
        cortexBridge: ICortexBridge,
        openaiApiKey: string,
        elevenlabsApiKey: string
    ) {
        super(cortexBridge);
        this.openai = new OpenAI({ apiKey: openaiApiKey });
        this.elevenlabs = new ElevenLabsClient({ apiKey: elevenlabsApiKey });

        // Check if cortexBridge is a StreamingCortexBridge
        if (cortexBridge instanceof StreamingCortexBridge) {
            this.streamingBridge = cortexBridge;
            this.setupStreamingListeners();
        }
    }

    /**
     * Setup listeners for streaming bridge events
     */
    private setupStreamingListeners(): void {
        if (!this.streamingBridge) return;

        // Handle incoming sentences - queue them for TTS
        this.streamingBridge.on('sentence', (sentence: string) => {
            console.log('[ElevenLabs] Received sentence:', sentence.substring(0, 50) + '...');
            this.queueSentence(sentence);
        });

        // Forward tool status events
        this.streamingBridge.on('tool-status', (event: ToolStatusEvent) => {
            this.emit('tool-status', {
                ...event,
                timestamp: Date.now(),
            });
        });

        // Handle thinking state
        this.streamingBridge.on('thinking', (isThinking: boolean) => {
            if (isThinking && this._state === 'processing') {
                // Emit a thinking tool status
                this.emit('tool-status', {
                    name: 'thinking',
                    status: 'running',
                    message: 'Thinking...',
                    timestamp: Date.now(),
                });
            }
        });

        // Handle completion
        this.streamingBridge.on('complete', (fullText: string) => {
            console.log('[ElevenLabs] Stream complete, full response length:', fullText.length);

            // Emit the full transcript
            this.emit('transcript', {
                type: 'assistant',
                content: fullText,
                isFinal: true,
                timestamp: Date.now(),
            });

            // Add to conversation history
            this.conversationHistory.push({
                role: 'assistant',
                content: fullText,
                timestamp: Date.now(),
            });
        });

        // Handle errors
        this.streamingBridge.on('error', (error: Error) => {
            console.error('[ElevenLabs] Stream error:', error);
            this.emitError(error);
            this.isProcessing = false;
            this.setState('idle');
        });
    }

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

        // Use custom voice ID if provided
        if (config.voiceId) {
            this.voiceId = config.voiceId;
        }

        // If entity has a voice sample, try to clone it
        if (config.voiceSample) {
            try {
                await this.setupVoiceClone(config.voiceSample, config.entityId);
            } catch (error) {
                console.warn('[ElevenLabs] Failed to setup voice clone, using default:', error);
            }
        }

        this.setConnected(true);
        this.setState('idle');

        console.log(`[ElevenLabs] Connected for entity: ${config.entityId}, voice: ${this.voiceId}, streaming: ${!!this.streamingBridge}`);
    }

    private async setupVoiceClone(voiceSampleUrl: string, _entityId: string): Promise<void> {
        // Voice cloning requires ElevenLabs Professional plan - placeholder for future implementation
        console.log(`[ElevenLabs] Voice sample available for cloning: ${voiceSampleUrl}`);
    }

    async disconnect(): Promise<void> {
        // Cancel any streaming query
        if (this.streamingBridge) {
            this.streamingBridge.cancel();
        }

        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
        this.audioBuffer = [];
        this.sentenceQueue = [];
        this.isSpeaking = false;
    }

    sendAudio(data: AudioData): void {
        if (!this._isConnected || this._isMuted || this.isProcessing) {
            return;
        }

        const buffer = Buffer.from(data.data, 'base64');
        this.audioBuffer.push(buffer);

        if (this._state !== 'listening') {
            this.setState('listening');
        }
    }

    /**
     * Queue a sentence for TTS processing
     */
    private queueSentence(sentence: string): void {
        this.sentenceQueue.push(sentence);
        this.processNextSentence();
    }

    /**
     * Process the next sentence in the queue
     */
    private async processNextSentence(): Promise<void> {
        // Don't start if already speaking or queue is empty
        if (this.isSpeaking || this.sentenceQueue.length === 0) {
            return;
        }

        this.isSpeaking = true;
        const sentence = this.sentenceQueue.shift()!;
        this.currentTrackId++;
        const trackId = `sentence-${this.currentTrackId}`;

        try {
            this.setState('speaking');

            // Emit partial transcript as we speak
            this.emit('transcript', {
                type: 'assistant',
                content: sentence,
                isFinal: false, // Partial - more may be coming
                timestamp: Date.now(),
            });

            await this.textToSpeechSentence(sentence, trackId);
        } catch (error) {
            console.error('[ElevenLabs] Error speaking sentence:', error);
        } finally {
            this.isSpeaking = false;

            // Process next sentence if available
            if (this.sentenceQueue.length > 0) {
                this.processNextSentence();
            } else if (!this.isProcessing) {
                // All done, back to idle
                this.setState('idle');
            }
        }
    }

    /**
     * Convert a single sentence to speech (streaming)
     */
    private async textToSpeechSentence(text: string, trackId: string): Promise<void> {
        try {
            const audioStream = await this.elevenlabs.textToSpeech.stream(
                this.voiceId,
                {
                    text,
                    modelId: 'eleven_v3',
                    outputFormat: 'pcm_24000',
                    voiceSettings: {
                        stability: 0.5,
                        similarityBoost: 0.75,
                        style: 0.0,
                        useSpeakerBoost: true,
                    },
                }
            );

            let pendingBuffer = Buffer.alloc(0);
            const minChunkSize = 4800; // 100ms of 24kHz mono PCM16

            for await (const chunk of audioStream) {
                if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
                    pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(chunk)]);

                    while (pendingBuffer.length >= minChunkSize) {
                        const sendSize = Math.floor(minChunkSize / 2) * 2;
                        const sendChunk = pendingBuffer.subarray(0, sendSize);
                        pendingBuffer = pendingBuffer.subarray(sendSize);

                        this.emit('audio', {
                            data: sendChunk.toString('base64'),
                            sampleRate: 24000,
                            trackId,
                        });
                    }
                }
            }

            // Send remaining data
            if (pendingBuffer.length >= 2) {
                const alignedLength = Math.floor(pendingBuffer.length / 2) * 2;
                const finalChunk = pendingBuffer.subarray(0, alignedLength);
                this.emit('audio', {
                    data: finalChunk.toString('base64'),
                    sampleRate: 24000,
                    trackId,
                });
            }
        } catch (error) {
            console.error('[ElevenLabs] Error generating speech for sentence:', error);
            throw error;
        }
    }

    /**
     * Process buffered audio through STT -> Streaming Agent -> TTS pipeline
     */
    async processBufferedAudio(): Promise<void> {
        if (this.audioBuffer.length === 0 || this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        this.setState('processing');
        this.sentenceQueue = []; // Clear any pending sentences

        try {
            // Combine and convert audio
            const combinedAudio = Buffer.concat(this.audioBuffer);
            this.audioBuffer = [];

            const wavBuffer = this.pcmToWav(combinedAudio, 24000);

            // Transcribe with Whisper
            const transcription = await this.openai.audio.transcriptions.create({
                file: new File([wavBuffer], 'audio.wav', { type: 'audio/wav' }),
                model: 'whisper-1',
                language: 'en',
            });

            const userText = transcription.text.trim();

            if (!userText) {
                this.setState('idle');
                this.isProcessing = false;
                return;
            }

            // Emit user transcript
            this.emit('transcript', {
                type: 'user',
                content: userText,
                isFinal: true,
                timestamp: Date.now(),
            });

            this.conversationHistory.push({
                role: 'user',
                content: userText,
                timestamp: Date.now(),
            });

            // Use streaming or non-streaming based on bridge type
            if (this.streamingBridge) {
                // Streaming mode - sentences will arrive via events
                console.log('[ElevenLabs] Using streaming mode for response');
                await this.streamingBridge.queryStreaming(
                    userText,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8)
                );
            } else {
                // Non-streaming fallback
                console.log('[ElevenLabs] Using non-streaming mode (fallback)');
                await this.processNonStreaming(userText);
            }
        } catch (error) {
            console.error('[ElevenLabs] Error processing audio:', error);
            this.emitError(error as Error);
            this.setState('idle');
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Non-streaming fallback for older CortexBridge
     */
    private async processNonStreaming(userText: string): Promise<void> {
        this.emit('tool-status', {
            name: 'processing',
            status: 'running',
            message: 'Thinking...',
            timestamp: Date.now(),
        });

        const response = await this.cortexBridge.query(
            userText,
            this._config!.entityId,
            this.conversationHistory.slice(-8)
        );

        this.emit('tool-status', {
            name: response.tool || 'response',
            status: 'completed',
            message: 'Done',
            timestamp: Date.now(),
        });

        this.emit('transcript', {
            type: 'assistant',
            content: response.result,
            isFinal: true,
            timestamp: Date.now(),
        });

        this.conversationHistory.push({
            role: 'assistant',
            content: response.result,
            timestamp: Date.now(),
        });

        await this.textToSpeech(response.result);
    }

    /**
     * Full text to speech (for non-streaming fallback)
     */
    private async textToSpeech(text: string): Promise<void> {
        this.setState('speaking');

        try {
            const audioStream = await this.elevenlabs.textToSpeech.stream(
                this.voiceId,
                {
                    text,
                    modelId: 'eleven_v3',
                    outputFormat: 'pcm_24000',
                    voiceSettings: {
                        stability: 0.5,
                        similarityBoost: 0.75,
                        style: 0.0,
                        useSpeakerBoost: true,
                    },
                }
            );

            let pendingBuffer = Buffer.alloc(0);
            const minChunkSize = 4800;

            for await (const chunk of audioStream) {
                if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
                    pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(chunk)]);

                    while (pendingBuffer.length >= minChunkSize) {
                        const sendSize = Math.floor(minChunkSize / 2) * 2;
                        const sendChunk = pendingBuffer.subarray(0, sendSize);
                        pendingBuffer = pendingBuffer.subarray(sendSize);

                        this.emit('audio', {
                            data: sendChunk.toString('base64'),
                            sampleRate: 24000,
                        });
                    }
                }
            }

            if (pendingBuffer.length >= 2) {
                const alignedLength = Math.floor(pendingBuffer.length / 2) * 2;
                const finalChunk = pendingBuffer.subarray(0, alignedLength);
                this.emit('audio', {
                    data: finalChunk.toString('base64'),
                    sampleRate: 24000,
                });
            }
        } catch (error) {
            console.error('[ElevenLabs] Error generating speech:', error);
            throw error;
        } finally {
            this.setState('idle');
        }
    }

    async sendText(text: string): Promise<void> {
        if (!this._isConnected) {
            throw new Error('Not connected');
        }

        this.isProcessing = true;
        this.sentenceQueue = [];

        try {
            this.emit('transcript', {
                type: 'user',
                content: text,
                isFinal: true,
                timestamp: Date.now(),
            });

            this.conversationHistory.push({
                role: 'user',
                content: text,
                timestamp: Date.now(),
            });

            this.setState('processing');

            if (this.streamingBridge) {
                await this.streamingBridge.queryStreaming(
                    text,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8)
                );
            } else {
                await this.processNonStreaming(text);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    interrupt(): void {
        // Cancel streaming if active
        if (this.streamingBridge) {
            this.streamingBridge.cancel();
        }

        // Clear sentence queue
        this.sentenceQueue = [];
        this.isSpeaking = false;
        this.isProcessing = false;

        this.setState('idle');
    }

    private pcmToWav(pcmData: Buffer, sampleRate: number): Buffer {
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataSize = pcmData.length;
        const headerSize = 44;

        const wav = Buffer.alloc(headerSize + dataSize);

        wav.write('RIFF', 0);
        wav.writeUInt32LE(36 + dataSize, 4);
        wav.write('WAVE', 8);
        wav.write('fmt ', 12);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(numChannels, 22);
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(byteRate, 28);
        wav.writeUInt16LE(blockAlign, 32);
        wav.writeUInt16LE(bitsPerSample, 34);
        wav.write('data', 36);
        wav.writeUInt32LE(dataSize, 40);
        pcmData.copy(wav, 44);

        return wav;
    }
}
