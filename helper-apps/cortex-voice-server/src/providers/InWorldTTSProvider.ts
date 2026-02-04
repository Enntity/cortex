/**
 * InWorld TTS Voice Provider (Streaming)
 *
 * TTS via InWorld REST streaming API with streaming bridge for Cortex.
 * Pipeline: STT (Deepgram/ElevenLabs) -> Cortex Agent (streaming) -> TTS (InWorld)
 *
 * Audio format: PCM16 at 24kHz (LINEAR16), matching the client StreamProcessor
 * which resamples from 24kHz → 48kHz.
 *
 * Streaming endpoint returns newline-delimited JSON. Each PCM chunk includes
 * a 44-byte WAV header that must be stripped.
 *
 * @see https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech-stream
 */

import { StreamingTTSProvider } from './StreamingTTSProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    ICortexBridge,
} from '../types.js';
import { STTProvider } from '../stt/index.js';

const INWORLD_STREAM_URL = 'https://api.inworld.ai/tts/v1/voice:stream';

interface InWorldStreamChunk {
    result?: {
        audioContent?: string;
        usage?: {
            processedCharactersCount?: number;
            modelId?: string;
        };
        timestampInfo?: unknown;
    };
    error?: {
        code?: number;
        message?: string;
        details?: unknown[];
    };
}

export class InWorldTTSProvider extends StreamingTTSProvider {
    readonly type: VoiceProviderType = 'inworld';
    protected readonly sttApiKeyName = 'inworldApiKey';

    private inworldApiKey: string;
    private voiceId: string = 'Pixie';
    private modelId: string = 'inworld-tts-1.5-max';
    private elevenlabsApiKey: string | null;

    constructor(
        cortexBridge: ICortexBridge,
        inworldApiKey: string,
        deepgramApiKey?: string,
        elevenlabsApiKey?: string,
        sttProvider?: STTProvider,
    ) {
        super(
            cortexBridge,
            deepgramApiKey || null,
            sttProvider || 'deepgram',
        );
        this.inworldApiKey = inworldApiKey;
        this.elevenlabsApiKey = elevenlabsApiKey || null;
    }

    // ── Subclass overrides ────────────────────────────────────────

    protected configureVoice(config: VoiceConfig): void {
        if (config.voiceId) {
            this.voiceId = config.voiceId;
        }
        console.log(`[InWorld] Voice configured: ${this.voiceId}, model: ${this.modelId}`);
    }

    protected getSTTApiKey(): string | undefined {
        return this.elevenlabsApiKey || undefined;
    }

    protected async synthesizeSpeech(text: string, trackId: string): Promise<void> {
        const response = await fetch(INWORLD_STREAM_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${this.inworldApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text,
                voiceId: this.voiceId,
                modelId: this.modelId,
                audioConfig: {
                    audioEncoding: 'LINEAR16',
                    sampleRateHertz: 24000,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`InWorld TTS error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
            throw new Error('InWorld TTS returned no response body');
        }

        // Parse newline-delimited JSON stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let jsonBuffer = '';
        let pendingAudio = Buffer.alloc(0);
        let isFirstChunk = true;
        const minChunkSize = 5120; // 2560 samples, aligned to 128-sample worklet frames

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                jsonBuffer += decoder.decode(value, { stream: true });

                // Process complete JSON lines
                while (jsonBuffer.includes('\n')) {
                    const newlineIdx = jsonBuffer.indexOf('\n');
                    const line = jsonBuffer.slice(0, newlineIdx).trim();
                    jsonBuffer = jsonBuffer.slice(newlineIdx + 1);

                    if (!line) continue;

                    let chunk: InWorldStreamChunk;
                    try {
                        chunk = JSON.parse(line);
                    } catch {
                        console.warn('[InWorld] Failed to parse stream chunk:', line.substring(0, 100));
                        continue;
                    }

                    if (chunk.error) {
                        throw new Error(`InWorld TTS stream error ${chunk.error.code}: ${chunk.error.message}`);
                    }

                    const audioContent = chunk.result?.audioContent;
                    if (!audioContent) continue;

                    // Decode base64 audio and strip WAV header
                    let audioData = Buffer.from(audioContent, 'base64');
                    if (audioData.length > 44 &&
                        audioData[0] === 0x52 && audioData[1] === 0x49 &&
                        audioData[2] === 0x46 && audioData[3] === 0x46) { // "RIFF"
                        audioData = audioData.subarray(44);
                    }

                    pendingAudio = Buffer.concat([pendingAudio, audioData]);

                    // Emit aligned chunks as they accumulate
                    while (pendingAudio.length >= minChunkSize) {
                        const sendSize = Math.floor(minChunkSize / 256) * 256;
                        const sendChunk = Buffer.from(pendingAudio.subarray(0, sendSize));
                        pendingAudio = pendingAudio.subarray(sendSize);

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
            }
        } finally {
            reader.releaseLock();
        }

        // Process any remaining JSON in buffer (last line without trailing newline)
        const remaining = jsonBuffer.trim();
        if (remaining) {
            try {
                const chunk: InWorldStreamChunk = JSON.parse(remaining);
                const audioContent = chunk.result?.audioContent;
                if (audioContent) {
                    let audioData = Buffer.from(audioContent, 'base64');
                    if (audioData.length > 44 &&
                        audioData[0] === 0x52 && audioData[1] === 0x49 &&
                        audioData[2] === 0x46 && audioData[3] === 0x46) {
                        audioData = audioData.subarray(44);
                    }
                    pendingAudio = Buffer.concat([pendingAudio, audioData]);
                }
            } catch {
                // Ignore trailing partial JSON
            }
        }

        // Final audio chunk
        if (pendingAudio.length >= 256) {
            const alignedLength = Math.floor(pendingAudio.length / 256) * 256;
            const finalChunk = Buffer.from(pendingAudio.subarray(0, alignedLength));

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
        // REST-based — no persistent connection to tear down
    }

    // ── Audio helpers ─────────────────────────────────────────────

    // 5ms fade-in at 24kHz = 120 samples — eliminates DC-offset pop
    private static readonly FADE_IN_SAMPLES = 120;

    private applyFadeIn(buffer: Buffer): void {
        const sampleCount = Math.min(InWorldTTSProvider.FADE_IN_SAMPLES, buffer.length / 2);
        for (let i = 0; i < sampleCount; i++) {
            const gain = i / InWorldTTSProvider.FADE_IN_SAMPLES;
            const sample = buffer.readInt16LE(i * 2);
            buffer.writeInt16LE(Math.round(sample * gain), i * 2);
        }
    }
}
