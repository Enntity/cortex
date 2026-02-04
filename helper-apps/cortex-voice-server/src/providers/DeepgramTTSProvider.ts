/**
 * Deepgram Aura 2 Voice Provider (Streaming)
 *
 * TTS via Deepgram Aura 2 REST API with streaming bridge for Cortex.
 * Pipeline: STT (Deepgram streaming) -> Cortex Agent (streaming) -> TTS (Deepgram Aura 2)
 *
 * Audio format: PCM16 at 24kHz (linear16), matching the client StreamProcessor
 * which resamples from 24kHz → 48kHz.
 */

import { createClient, DeepgramClient } from '@deepgram/sdk';
import { StreamingTTSProvider } from './StreamingTTSProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    ICortexBridge,
} from '../types.js';
import { STTProvider } from '../stt/index.js';

export class DeepgramTTSProvider extends StreamingTTSProvider {
    readonly type: VoiceProviderType = 'deepgram';
    protected readonly sttApiKeyName = 'deepgramApiKey';

    private deepgram: DeepgramClient;
    private voiceModel: string = 'aura-2-thalia-en';
    private elevenlabsApiKey: string | null;

    constructor(
        cortexBridge: ICortexBridge,
        apiKey: string,
        elevenlabsApiKey?: string,
        sttProvider?: STTProvider,
    ) {
        super(
            cortexBridge,
            apiKey,           // deepgramApiKey — used for Deepgram STT
            sttProvider || 'deepgram',
        );
        this.elevenlabsApiKey = elevenlabsApiKey || null;
        this.deepgram = createClient(apiKey);
    }

    // ── Subclass overrides ────────────────────────────────────────

    protected configureVoice(config: VoiceConfig): void {
        if (config.voiceId) {
            this.voiceModel = config.voiceId; // e.g. "aura-2-thalia-en"
        }
        console.log(`[Deepgram] Voice configured: ${this.voiceModel}`);
    }

    protected getSTTApiKey(): string | undefined {
        return this.elevenlabsApiKey || undefined;
    }

    // 5ms fade-in at 24kHz = 120 samples — eliminates the DC-offset pop
    // at the start of each TTS response without being audible
    private static readonly FADE_IN_SAMPLES = 120;

    private applyFadeIn(buffer: Buffer): void {
        const sampleCount = Math.min(DeepgramTTSProvider.FADE_IN_SAMPLES, buffer.length / 2);
        for (let i = 0; i < sampleCount; i++) {
            const gain = i / DeepgramTTSProvider.FADE_IN_SAMPLES;
            const sample = buffer.readInt16LE(i * 2);
            buffer.writeInt16LE(Math.round(sample * gain), i * 2);
        }
    }

    protected async synthesizeSpeech(text: string, trackId: string): Promise<void> {
        const response = await this.deepgram.speak.request(
            { text },
            {
                model: this.voiceModel,
                encoding: 'linear16',
                sample_rate: 24000,
            },
        );

        const stream = await response.getStream();
        if (!stream) {
            throw new Error('Deepgram speak returned no audio stream');
        }

        const reader = stream.getReader();
        let pendingBuffer = Buffer.alloc(0);
        let headerStripped = false;
        let isFirstChunk = true;
        const minChunkSize = 5120; // 2560 samples, aligned to 128-sample worklet frames

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(value)]);

                // Deepgram linear16 responses include a WAV header — strip it
                if (!headerStripped && pendingBuffer.length >= 44) {
                    if (pendingBuffer[0] === 0x52 && pendingBuffer[1] === 0x49 &&
                        pendingBuffer[2] === 0x46 && pendingBuffer[3] === 0x46) { // "RIFF"
                        pendingBuffer = pendingBuffer.subarray(44);
                    }
                    headerStripped = true;
                }

                while (pendingBuffer.length >= minChunkSize) {
                    const sendSize = Math.floor(minChunkSize / 256) * 256;
                    const sendChunk = Buffer.from(pendingBuffer.subarray(0, sendSize));
                    pendingBuffer = pendingBuffer.subarray(sendSize);

                    if (isFirstChunk) {
                        this.applyFadeIn(sendChunk);
                        isFirstChunk = false;
                    }

                    this.emit('audio', {
                        data: sendChunk.toString('base64'),
                        sampleRate: 24000,
                        trackId,
                    });
                }
            }
        } finally {
            reader.releaseLock();
        }

        // Final chunk, aligned to 256 bytes for worklet compatibility
        if (pendingBuffer.length >= 256) {
            const alignedLength = Math.floor(pendingBuffer.length / 256) * 256;
            const finalChunk = Buffer.from(pendingBuffer.subarray(0, alignedLength));

            if (isFirstChunk) {
                this.applyFadeIn(finalChunk);
            }

            this.emit('audio', {
                data: finalChunk.toString('base64'),
                sampleRate: 24000,
                trackId,
            });
        }
    }

    protected async disconnectTTS(): Promise<void> {
        // REST-based - no persistent connection to tear down
    }
}
