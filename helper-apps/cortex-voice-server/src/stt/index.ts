/**
 * Streaming STT Module
 *
 * Pluggable speech-to-text with multiple provider support.
 * ElevenLabs (primary), Deepgram, Whisper (batch fallback)
 */

export { StreamingSTT } from './StreamingSTT.js';
export type { StreamingSTTConfig, TranscriptEvent, STTProvider } from './StreamingSTT.js';
export { ElevenLabsStreamingSTT } from './ElevenLabsStreamingSTT.js';
export type { ElevenLabsSTTConfig } from './ElevenLabsStreamingSTT.js';
export { DeepgramStreamingSTT } from './DeepgramStreamingSTT.js';
export type { DeepgramSTTConfig } from './DeepgramStreamingSTT.js';

import { StreamingSTT } from './StreamingSTT.js';
import type { STTProvider, StreamingSTTConfig } from './StreamingSTT.js';
import { ElevenLabsStreamingSTT } from './ElevenLabsStreamingSTT.js';
import { DeepgramStreamingSTT } from './DeepgramStreamingSTT.js';

export interface STTFactoryConfig extends StreamingSTTConfig {
    provider: STTProvider;
    elevenlabsApiKey?: string;
    deepgramApiKey?: string;
}

/**
 * Create a streaming STT instance based on provider
 */
export function createStreamingSTT(config: STTFactoryConfig): StreamingSTT | null {
    switch (config.provider) {
        case 'elevenlabs':
            if (!config.elevenlabsApiKey) {
                console.warn('[STT] ElevenLabs STT requested but no API key provided');
                return null;
            }
            return new ElevenLabsStreamingSTT({
                apiKey: config.elevenlabsApiKey,
                sampleRate: config.sampleRate,
                language: config.language,
            });

        case 'deepgram':
            if (!config.deepgramApiKey) {
                console.warn('[STT] Deepgram STT requested but no API key provided');
                return null;
            }
            return new DeepgramStreamingSTT({
                apiKey: config.deepgramApiKey,
                sampleRate: config.sampleRate,
                language: config.language,
            });

        case 'whisper':
            // Whisper is batch-only, handled separately
            console.log('[STT] Whisper selected - will use batch transcription');
            return null;

        default:
            console.warn(`[STT] Unknown provider: ${config.provider}`);
            return null;
    }
}
