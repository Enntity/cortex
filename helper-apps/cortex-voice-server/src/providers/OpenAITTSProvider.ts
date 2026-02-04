/**
 * OpenAI TTS Voice Provider (Streaming)
 *
 * TTS via OpenAI's speech API with streaming bridge for Cortex.
 * Pipeline: STT (streaming) -> Cortex Agent (streaming) -> TTS (OpenAI)
 *
 * Audio format: PCM16 at 24kHz, matching the client StreamProcessor.
 */

import OpenAI from 'openai';
import { StreamingTTSProvider } from './StreamingTTSProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    ICortexBridge,
} from '../types.js';
import { STTProvider } from '../stt/index.js';

export class OpenAITTSProvider extends StreamingTTSProvider {
    readonly type: VoiceProviderType = 'openai-tts';
    protected readonly sttApiKeyName = 'openaiApiKey';

    private openai: OpenAI;
    private voice: string = 'alloy';
    private elevenlabsApiKey: string | null;

    constructor(
        cortexBridge: ICortexBridge,
        apiKey: string,
        deepgramApiKey?: string,
        elevenlabsApiKey?: string,
        sttProvider?: STTProvider,
    ) {
        super(
            cortexBridge,
            deepgramApiKey || null,
            sttProvider || 'deepgram',
        );
        this.elevenlabsApiKey = elevenlabsApiKey || null;
        this.openai = new OpenAI({ apiKey });
    }

    // ── Subclass overrides ────────────────────────────────────────

    protected configureVoice(config: VoiceConfig): void {
        if (config.voiceId) {
            this.voice = config.voiceId;
        }
        console.log(`[OpenAI TTS] Voice configured: ${this.voice}`);
    }

    protected getSTTApiKey(): string | undefined {
        return this.elevenlabsApiKey || undefined;
    }

    protected async synthesizeSpeech(text: string, trackId: string): Promise<void> {
        const response = await this.openai.audio.speech.create({
            model: 'tts-1',
            voice: this.voice as 'alloy',
            input: text,
            response_format: 'pcm',
            speed: 1.0,
        });

        // response.body is a Node.js Readable stream — iterate for genuine streaming
        const stream = response.body as unknown as AsyncIterable<Buffer>;
        let pendingBuffer = Buffer.alloc(0);
        const minChunkSize = 5120; // 2560 samples, aligned to 128-sample worklet frames

        for await (const chunk of stream) {
            pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(chunk)]);

            while (pendingBuffer.length >= minChunkSize) {
                const sendSize = Math.floor(minChunkSize / 256) * 256;
                const sendChunk = pendingBuffer.subarray(0, sendSize);
                pendingBuffer = pendingBuffer.subarray(sendSize);

                this.emit('audio', {
                    data: sendChunk.toString('base64'),
                    sampleRate: 24000,
                    trackId,
                });
            }
        }

        // Final chunk, aligned to 256 bytes for worklet compatibility
        if (pendingBuffer.length >= 256) {
            const alignedLength = Math.floor(pendingBuffer.length / 256) * 256;
            const finalChunk = pendingBuffer.subarray(0, alignedLength);
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
