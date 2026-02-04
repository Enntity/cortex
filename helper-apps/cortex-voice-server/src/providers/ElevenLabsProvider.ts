/**
 * ElevenLabs Voice Provider (Streaming)
 *
 * High-quality TTS with natural voices and voice cloning capability.
 * Supports streaming responses from Cortex - sentences are spoken as they arrive.
 * Pipeline: STT (Deepgram streaming) -> Cortex Agent (streaming) -> TTS (ElevenLabs)
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { StreamingTTSProvider } from './StreamingTTSProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    VoiceSettings,
    ICortexBridge,
} from '../types.js';
import { STTProvider } from '../stt/index.js';

export class ElevenLabsProvider extends StreamingTTSProvider {
    readonly type: VoiceProviderType = 'elevenlabs';
    protected readonly sttApiKeyName = 'elevenlabsApiKey';

    private elevenlabs: ElevenLabsClient;
    private elevenlabsApiKey: string;
    private voiceId: string = 'pNInz6obpgDQGcFmaJgB'; // Default: Adam
    private voiceSettings: VoiceSettings = {
        stability: 0.5,
        similarity: 0.75,
        style: 0.0,
        speakerBoost: true,
    };

    constructor(
        cortexBridge: ICortexBridge,
        elevenlabsApiKey: string,
        deepgramApiKey?: string,
        sttProvider?: STTProvider,
    ) {
        super(
            cortexBridge,
            deepgramApiKey || null,
            sttProvider || 'elevenlabs',
        );
        this.elevenlabsApiKey = elevenlabsApiKey;
        this.elevenlabs = new ElevenLabsClient({ apiKey: elevenlabsApiKey });
    }

    // ── Subclass overrides ────────────────────────────────────────

    protected configureVoice(config: VoiceConfig): void {
        if (config.voiceId) {
            this.voiceId = config.voiceId;
        }

        if (config.voiceSettings) {
            this.voiceSettings = {
                stability: config.voiceSettings.stability ?? this.voiceSettings.stability,
                similarity: config.voiceSettings.similarity ?? this.voiceSettings.similarity,
                style: config.voiceSettings.style ?? this.voiceSettings.style,
                speakerBoost: config.voiceSettings.speakerBoost ?? this.voiceSettings.speakerBoost,
            };
        }

        // If entity has a voice sample, try to clone it
        if (config.voiceSample) {
            this.setupVoiceClone(config.voiceSample).catch(error => {
                console.warn('[ElevenLabs] Failed to setup voice clone, using default:', error);
            });
        }

        console.log(`[ElevenLabs] Voice configured: ${this.voiceId}, settings:`, this.voiceSettings);
    }

    protected getSTTApiKey(): string | undefined {
        return this.elevenlabsApiKey;
    }

    protected async synthesizeSpeech(text: string, trackId: string): Promise<void> {
        const audioStream = await this.elevenlabs.textToSpeech.stream(
            this.voiceId,
            {
                text,
                modelId: 'eleven_v3',
                outputFormat: 'pcm_24000',
                voiceSettings: {
                    stability: this.voiceSettings.stability ?? 0.5,
                    similarityBoost: this.voiceSettings.similarity ?? 0.75,
                    style: this.voiceSettings.style ?? 0.0,
                    useSpeakerBoost: this.voiceSettings.speakerBoost ?? true,
                },
            },
        );

        let pendingBuffer = Buffer.alloc(0);
        const minChunkSize = 5120; // 2560 samples, aligned to 128-sample worklet frames

        for await (const chunk of audioStream) {
            if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
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

    // ── ElevenLabs-specific ───────────────────────────────────────

    private async setupVoiceClone(voiceSampleUrl: string): Promise<void> {
        // Voice cloning requires ElevenLabs Professional plan - placeholder for future implementation
        console.log(`[ElevenLabs] Voice sample available for cloning: ${voiceSampleUrl}`);
    }
}
