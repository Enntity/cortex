/**
 * OpenAI TTS/STT Voice Provider
 *
 * Traditional pipeline: STT (Whisper) -> Cortex Agent -> TTS (OpenAI TTS)
 * Lower latency per-segment, more predictable, works with any text LLM.
 */

import OpenAI from 'openai';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
} from '../types.js';

export class OpenAITTSProvider extends BaseVoiceProvider {
    readonly type: VoiceProviderType = 'openai-tts';

    private openai: OpenAI;
    private conversationHistory: ConversationMessage[] = [];
    private audioBuffer: Buffer[] = [];
    private isProcessing: boolean = false;
    private pendingTranscription: boolean = false;
    private voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' = 'alloy';

    constructor(cortexBridge: ICortexBridge, apiKey: string) {
        super(cortexBridge);
        this.openai = new OpenAI({ apiKey });
    }

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

        // Map voice sample to OpenAI voice if available
        if (config.voiceId) {
            const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
            if (validVoices.includes(config.voiceId)) {
                this.voice = config.voiceId as typeof this.voice;
            }
        }

        this.setConnected(true);
        this.setState('idle');

        console.log(`[OpenAI TTS] Connected for entity: ${config.entityId}`);
    }

    async disconnect(): Promise<void> {
        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
        this.audioBuffer = [];
    }

    sendAudio(data: AudioData): void {
        if (!this._isConnected || this._isMuted || this.isProcessing) {
            return;
        }

        // Buffer incoming audio
        const buffer = Buffer.from(data.data, 'base64');
        this.audioBuffer.push(buffer);

        // Set state to listening
        if (this._state !== 'listening') {
            this.setState('listening');
        }
    }

    /**
     * Process buffered audio through STT -> Agent -> TTS pipeline
     * Called when VAD detects end of speech (client-side VAD)
     */
    async processBufferedAudio(): Promise<void> {
        if (this.audioBuffer.length === 0 || this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        this.setState('processing');

        try {
            // Combine audio buffers
            const combinedAudio = Buffer.concat(this.audioBuffer);
            this.audioBuffer = [];

            // Convert to WAV format for Whisper
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

            // Query Cortex agent
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

            // Emit assistant transcript
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

            // Convert response to speech
            await this.textToSpeech(response.result);
        } catch (error) {
            console.error('[OpenAI TTS] Error processing audio:', error);
            this.emitError(error as Error);
        } finally {
            this.isProcessing = false;
            this.setState('idle');
        }
    }

    private async textToSpeech(text: string): Promise<void> {
        this.setState('speaking');

        try {
            // Generate speech with OpenAI TTS
            const mp3Response = await this.openai.audio.speech.create({
                model: 'tts-1',
                voice: this.voice,
                input: text,
                response_format: 'pcm', // Get raw PCM for consistent streaming
                speed: 1.0,
            });

            // Stream the audio
            const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());

            // Send in chunks for smooth playback
            const chunkSize = 4800; // 100ms of 24kHz mono PCM16
            for (let i = 0; i < audioBuffer.length; i += chunkSize) {
                const chunk = audioBuffer.slice(i, Math.min(i + chunkSize, audioBuffer.length));
                this.emit('audio', {
                    data: chunk.toString('base64'),
                    sampleRate: 24000,
                });

                // Small delay between chunks for smooth playback
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } catch (error) {
            console.error('[OpenAI TTS] Error generating speech:', error);
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

        try {
            // Add to history and emit
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

            // Query Cortex
            this.setState('processing');

            const response = await this.cortexBridge.query(
                text,
                this._config!.entityId,
                this.conversationHistory.slice(-8)
            );

            // Emit response
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

            // Generate speech
            await this.textToSpeech(response.result);
        } finally {
            this.isProcessing = false;
        }
    }

    interrupt(): void {
        // For TTS provider, interruption clears the audio queue
        // The client should stop playback
        this.setState('idle');
    }

    /**
     * Convert raw PCM16 to WAV format for Whisper API
     */
    private pcmToWav(pcmData: Buffer, sampleRate: number): Buffer {
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataSize = pcmData.length;
        const headerSize = 44;

        const wav = Buffer.alloc(headerSize + dataSize);

        // RIFF header
        wav.write('RIFF', 0);
        wav.writeUInt32LE(36 + dataSize, 4);
        wav.write('WAVE', 8);

        // fmt chunk
        wav.write('fmt ', 12);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); // PCM
        wav.writeUInt16LE(numChannels, 22);
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(byteRate, 28);
        wav.writeUInt16LE(blockAlign, 32);
        wav.writeUInt16LE(bitsPerSample, 34);

        // data chunk
        wav.write('data', 36);
        wav.writeUInt32LE(dataSize, 40);
        pcmData.copy(wav, 44);

        return wav;
    }
}
