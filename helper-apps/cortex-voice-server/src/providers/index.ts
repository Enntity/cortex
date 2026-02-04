/**
 * Voice Provider Factory
 *
 * Creates the appropriate voice provider based on configuration.
 * Supports pluggable providers: OpenAI Realtime, OpenAI TTS, ElevenLabs, Deepgram
 */

import {
    IVoiceProvider,
    VoiceProviderType,
    VoicePreference,
    VoiceSettings,
    ICortexBridge,
    ServerConfig,
} from '../types.js';
import { OpenAIRealtimeProvider } from './OpenAIRealtimeProvider.js';
import { OpenAITTSProvider } from './OpenAITTSProvider.js';
import { ElevenLabsProvider } from './ElevenLabsProvider.js';
import { DeepgramTTSProvider } from './DeepgramTTSProvider.js';
import { InWorldTTSProvider } from './InWorldTTSProvider.js';

export { BaseVoiceProvider } from './BaseProvider.js';
export { StreamingTTSProvider } from './StreamingTTSProvider.js';
export { OpenAIRealtimeProvider } from './OpenAIRealtimeProvider.js';
export { OpenAITTSProvider } from './OpenAITTSProvider.js';
export { ElevenLabsProvider } from './ElevenLabsProvider.js';
export { DeepgramTTSProvider } from './DeepgramTTSProvider.js';
export { InWorldTTSProvider } from './InWorldTTSProvider.js';

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
            return new OpenAITTSProvider(
                cortexBridge,
                config.openaiApiKey,
                config.deepgramApiKey,
                config.elevenlabsApiKey,
                config.sttProvider || 'deepgram',
            );

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

        case 'deepgram':
            if (!config.deepgramApiKey) {
                throw new Error('Deepgram API key required for deepgram provider');
            }
            return new DeepgramTTSProvider(
                cortexBridge,
                config.deepgramApiKey,
                config.elevenlabsApiKey,
                config.sttProvider || 'deepgram' // Default to Deepgram streaming STT
            );

        case 'inworld':
            if (!config.inworldApiKey) {
                throw new Error('InWorld API key required for inworld provider');
            }
            return new InWorldTTSProvider(
                cortexBridge,
                config.inworldApiKey,
                config.deepgramApiKey,
                config.elevenlabsApiKey,
                config.sttProvider || 'deepgram',
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

        case 'deepgram':
            return !!config.deepgramApiKey;

        case 'inworld':
            return !!config.inworldApiKey;

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

    if (config.deepgramApiKey) {
        providers.push('deepgram');
    }

    if (config.inworldApiKey) {
        providers.push('inworld');
    }

    return providers;
}

/**
 * Provider-specific voice delivery instructions.
 * Injected into the LLM system prompt so responses are formatted
 * for the active TTS engine's capabilities.
 */
export const VOICE_PROVIDER_INSTRUCTIONS: Record<VoiceProviderType, string> = {
    'elevenlabs': `## Delivery & Emotion
- Use audio tags to express emotion naturally: [laughs], [sighs], [whispers], [excited], [sarcastic], [curious], [crying], [mischievously]
- Use CAPS for vocal EMPHASIS on key words
- Use ellipses (…) for pauses and weight: "It was incredible… I couldn't believe it."
- Match emotional tags to context - don't overuse them; let them enhance natural moments
- Example: "You are NOT going to believe this [laughs] … it actually worked!"`,

    'deepgram': `## Delivery & Expression
- Express emotion through word choice, punctuation, and natural phrasing — do NOT use bracket tags like [laughs] or [sighs], they will be read literally
- Do NOT use markdown emphasis like *word* or **word** — the asterisks will be spoken aloud
- Use exclamation points for enthusiasm and energy
- Use ellipses (...) for dramatic pauses and pacing
- Use commas to create natural breathing pauses
- Keep sentences short and direct rather than long run-ons
- Use hyphens for additional pauses in complex statements
- A well-placed "um" or "uh" can add conversational warmth — use sparingly`,

    'openai-tts': `## Delivery & Emotion
- Express emotion through word choice and natural phrasing — do NOT use bracket tags like [laughs] or [sighs]
- Use CAPS for vocal EMPHASIS on key words
- Use ellipses (...) for pauses
- Keep a natural, conversational tone`,

    'openai-realtime': `## Delivery & Emotion
- Express emotion through word choice and natural phrasing
- Use CAPS for vocal EMPHASIS on key words
- Use ellipses (...) for pauses
- Keep a natural, conversational tone`,

    'inworld': `## Delivery & Emotion
- Use audio tags to express emotion naturally: [laughs], [sighs], [whispers], [excited], [sarcastic], [curious], [crying], [mischievously]
- Use CAPS for vocal EMPHASIS on key words
- Use ellipses (…) for pauses and weight: "It was incredible… I couldn't believe it."
- Match emotional tags to context - don't overuse them; let them enhance natural moments
- Example: "You are NOT going to believe this [laughs] … it actually worked!"`,
};

/**
 * Resolve voice provider from an ordered preferences array.
 * Iterates through preferences and returns the first one whose provider is available.
 * Falls back to server default if none match.
 */
export function resolveVoiceProvider(
    preferences: VoicePreference[] | undefined,
    config: ServerConfig,
): { type: VoiceProviderType; voiceId?: string; voiceSettings?: VoiceSettings } {
    if (preferences && preferences.length > 0) {
        for (const pref of preferences) {
            if (isProviderAvailable(pref.provider, config)) {
                const voiceSettings: VoiceSettings | undefined = pref.settings
                    ? {
                        stability: typeof pref.settings.stability === 'number' ? pref.settings.stability : undefined,
                        similarity: typeof pref.settings.similarity === 'number' ? pref.settings.similarity : undefined,
                        style: typeof pref.settings.style === 'number' ? pref.settings.style : undefined,
                        speakerBoost: typeof pref.settings.speakerBoost === 'boolean' ? pref.settings.speakerBoost : undefined,
                    }
                    : undefined;

                return {
                    type: pref.provider,
                    voiceId: pref.voiceId,
                    voiceSettings,
                };
            }
        }
    }

    // No preference matched — use server default
    return { type: config.defaultProvider };
}
