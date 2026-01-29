/**
 * Voice Provider Factory
 *
 * Creates the appropriate voice provider based on configuration.
 * Supports pluggable providers: OpenAI Realtime, OpenAI TTS, ElevenLabs
 */

import {
    IVoiceProvider,
    VoiceProviderType,
    ICortexBridge,
    ServerConfig,
} from '../types.js';
import { OpenAIRealtimeProvider } from './OpenAIRealtimeProvider.js';
import { OpenAITTSProvider } from './OpenAITTSProvider.js';
import { ElevenLabsProvider } from './ElevenLabsProvider.js';

export { BaseVoiceProvider } from './BaseProvider.js';
export { OpenAIRealtimeProvider } from './OpenAIRealtimeProvider.js';
export { OpenAITTSProvider } from './OpenAITTSProvider.js';
export { ElevenLabsProvider } from './ElevenLabsProvider.js';

/**
 * Create a voice provider instance based on type
 */
export function createVoiceProvider(
    type: VoiceProviderType,
    cortexBridge: ICortexBridge,
    config: ServerConfig
): IVoiceProvider {
    switch (type) {
        case 'openai-realtime':
            if (!config.openaiApiKey) {
                throw new Error('OpenAI API key required for openai-realtime provider');
            }
            return new OpenAIRealtimeProvider(cortexBridge, config.openaiApiKey);

        case 'openai-tts':
            if (!config.openaiApiKey) {
                throw new Error('OpenAI API key required for openai-tts provider');
            }
            return new OpenAITTSProvider(cortexBridge, config.openaiApiKey);

        case 'elevenlabs':
            if (!config.elevenlabsApiKey) {
                throw new Error('ElevenLabs API key required for elevenlabs provider');
            }
            return new ElevenLabsProvider(
                cortexBridge,
                config.elevenlabsApiKey,
                config.deepgramApiKey,
                config.sttProvider || 'elevenlabs' // Default to ElevenLabs streaming STT
            );

        default:
            throw new Error(`Unknown voice provider type: ${type}`);
    }
}

/**
 * Check if a provider type is available based on configuration
 */
export function isProviderAvailable(
    type: VoiceProviderType,
    config: ServerConfig
): boolean {
    switch (type) {
        case 'openai-realtime':
        case 'openai-tts':
            return !!config.openaiApiKey;

        case 'elevenlabs':
            return !!config.openaiApiKey && !!config.elevenlabsApiKey;

        default:
            return false;
    }
}

/**
 * Get list of available providers
 */
export function getAvailableProviders(config: ServerConfig): VoiceProviderType[] {
    const providers: VoiceProviderType[] = [];

    if (config.openaiApiKey) {
        providers.push('openai-realtime', 'openai-tts');
    }

    if (config.openaiApiKey && config.elevenlabsApiKey) {
        providers.push('elevenlabs');
    }

    return providers;
}
