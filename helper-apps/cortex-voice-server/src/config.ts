/**
 * Server Configuration
 *
 * Loads configuration from environment variables with sensible defaults.
 */

import { config as loadEnv } from 'dotenv';
import { ServerConfig, VoiceProviderType } from './types.js';

// Load .env file in development
loadEnv();

function getEnvString(key: string, defaultValue?: string): string {
    const value = process.env[key];
    if (value === undefined && defaultValue === undefined) {
        throw new Error(`Required environment variable ${key} is not set`);
    }
    return value || defaultValue!;
}

function getEnvNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        console.warn(`Invalid number for ${key}, using default: ${defaultValue}`);
        return defaultValue;
    }
    return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

function getCorsOrigins(): string | string[] {
    const origins = process.env.CORS_ORIGINS;
    if (!origins) {
        console.warn('[Config] CORS_ORIGINS not configured - blocking all cross-origin requests');
        return [];
    }
    if (origins === '*') {
        return '*';
    }
    return origins.split(',').map(o => o.trim());
}

function getDefaultProvider(): VoiceProviderType {
    const provider = process.env.DEFAULT_VOICE_PROVIDER as VoiceProviderType;
    const validProviders: VoiceProviderType[] = ['openai-realtime', 'openai-tts', 'elevenlabs', 'deepgram', 'inworld'];

    if (provider && validProviders.includes(provider)) {
        return provider;
    }

    return 'openai-realtime';
}

function getSTTProvider(): 'elevenlabs' | 'deepgram' | 'whisper' {
    const provider = process.env.STT_PROVIDER?.toLowerCase();
    if (provider === 'deepgram') return 'deepgram';
    if (provider === 'whisper') return 'whisper';
    return 'elevenlabs'; // Default to ElevenLabs streaming STT
}

export function loadConfig(): ServerConfig {
    return {
        port: getEnvNumber('PORT', 3001),
        corsOrigins: getCorsOrigins(),
        defaultProvider: getDefaultProvider(),
        openaiApiKey: process.env.OPENAI_API_KEY,
        elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
        deepgramApiKey: process.env.DEEPGRAM_API_KEY,
        inworldApiKey: process.env.INWORLD_API_KEY,
        sttProvider: getSTTProvider(),
        cortexApiUrl: getEnvString('CORTEX_API_URL', 'http://localhost:4000/graphql'),
        maxAudioMessages: getEnvNumber('MAX_AUDIO_MESSAGES', 8),
        idleTimeoutBaseMs: getEnvNumber('IDLE_TIMEOUT_BASE_MS', 2500),
        idleTimeoutMaxMs: getEnvNumber('IDLE_TIMEOUT_MAX_MS', 60000),
        audioBlockTimeoutMs: getEnvNumber('AUDIO_BLOCK_TIMEOUT_MS', 180000),
        debug: getEnvBoolean('DEBUG', false),
        authSecret: process.env.AUTH_SECRET || '',
    };
}

export function validateConfig(config: ServerConfig): void {
    const errors: string[] = [];

    if (!config.openaiApiKey) {
        errors.push('OPENAI_API_KEY is required');
    }

    if (config.defaultProvider === 'elevenlabs' && !config.elevenlabsApiKey) {
        errors.push('ELEVENLABS_API_KEY is required when using elevenlabs provider');
    }

    if (config.defaultProvider === 'deepgram' && !config.deepgramApiKey) {
        errors.push('DEEPGRAM_API_KEY is required when using deepgram provider');
    }

    if (config.defaultProvider === 'inworld' && !config.inworldApiKey) {
        errors.push('INWORLD_API_KEY is required when using inworld provider');
    }

    if (errors.length > 0) {
        throw new Error(`Configuration errors:\n${errors.join('\n')}`);
    }
}
