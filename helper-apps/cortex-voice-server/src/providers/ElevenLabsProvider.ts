/**
 * ElevenLabs Voice Provider
 *
 * High-quality TTS with natural voices and voice cloning capability.
 * Pipeline: STT (Whisper) -> Cortex Agent -> TTS (ElevenLabs)
 */

import OpenAI from 'openai';
import { ElevenLabsClient } from 'elevenlabs';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
} from '../types.js';

export class ElevenLabsProvider extends BaseVoiceProvider {
    readonly type: VoiceProviderType = 'elevenlabs';

    private openai: OpenAI;
    private elevenlabs: ElevenLabsClient;
    private conversationHistory: ConversationMessage[] = [];
    private audioBuffer: Buffer[] = [];
    private isProcessing: boolean = false;
    private voiceId: string = 'pNInz6obpgDQGcFmaJgB'; // Default: Adam

    constructor(
        cortexBridge: ICortexBridge,
        openaiApiKey: string,
        elevenlabsApiKey: string
    ) {
        super(cortexBridge);
        this.openai = new OpenAI({ apiKey: openaiApiKey });
        this.elevenlabs = new ElevenLabsClient({ apiKey: elevenlabsApiKey });
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

        console.log(`[ElevenLabs] Connected for entity: ${config.entityId}, voice: ${this.voiceId}`);
    }

    private async setupVoiceClone(voiceSampleUrl: string, entityId: string): Promise<void> {
        // Check if we already have a cloned voice for this entity
        // In production, this would check a database or cache
        // For now, we'll use the provided voiceId or create a new clone

        // ElevenLabs voice cloning requires the Professional plan
        // This is a placeholder for voice cloning implementation
        console.log(`[ElevenLabs] Voice sample available for cloning: ${voiceSampleUrl}`);
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

        const buffer = Buffer.from(data.data, 'base64');
        this.audioBuffer.push(buffer);

        if (this._state !== 'listening') {
            this.setState('listening');
        }
    }

    /**
     * Process buffered audio through STT -> Agent -> TTS pipeline
     */
    async processBufferedAudio(): Promise<void> {
        if (this.audioBuffer.length === 0 || this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        this.setState('processing');

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

            // Generate speech with ElevenLabs
            await this.textToSpeech(response.result);
        } catch (error) {
            console.error('[ElevenLabs] Error processing audio:', error);
            this.emitError(error as Error);
        } finally {
            this.isProcessing = false;
            this.setState('idle');
        }
    }

    private async textToSpeech(text: string): Promise<void> {
        this.setState('speaking');

        try {
            // Generate speech with ElevenLabs streaming
            const audioStream = await this.elevenlabs.textToSpeech.convertAsStream(
                this.voiceId,
                {
                    text,
                    model_id: 'eleven_turbo_v2_5', // Fast, high-quality model
                    output_format: 'pcm_24000', // 24kHz PCM for consistency
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true,
                    },
                }
            );

            // Stream chunks to client
            for await (const chunk of audioStream) {
                if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
                    this.emit('audio', {
                        data: Buffer.from(chunk).toString('base64'),
                        sampleRate: 24000,
                    });
                }
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

            const response = await this.cortexBridge.query(
                text,
                this._config!.entityId,
                this.conversationHistory.slice(-8)
            );

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
        } finally {
            this.isProcessing = false;
        }
    }

    interrupt(): void {
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
