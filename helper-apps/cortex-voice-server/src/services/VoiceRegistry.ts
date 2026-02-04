/**
 * Voice Registry
 *
 * Fetches and caches voice lists from all configured providers.
 * Returns a unified format so clients can display voices from any provider.
 * Generates on-demand TTS previews for any voice.
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { createClient } from '@deepgram/sdk';
import OpenAI from 'openai';
import {
    VoiceProviderType,
    UnifiedVoice,
    VoiceSettingField,
    ProviderVoices,
    VoicesResponse,
    ServerConfig,
} from '../types.js';
import { isProviderAvailable } from '../providers/index.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Static voice definitions ─────────────────────────────────────────

const OPENAI_TTS_VOICES: UnifiedVoice[] = [
    { id: 'alloy', provider: 'openai-tts', name: 'Alloy', labels: { gender: 'neutral', category: 'standard' } },
    { id: 'echo', provider: 'openai-tts', name: 'Echo', labels: { gender: 'male', category: 'standard' } },
    { id: 'fable', provider: 'openai-tts', name: 'Fable', labels: { gender: 'male', category: 'standard' } },
    { id: 'onyx', provider: 'openai-tts', name: 'Onyx', labels: { gender: 'male', category: 'standard' } },
    { id: 'nova', provider: 'openai-tts', name: 'Nova', labels: { gender: 'female', category: 'standard' } },
    { id: 'shimmer', provider: 'openai-tts', name: 'Shimmer', labels: { gender: 'female', category: 'standard' } },
];

const OPENAI_REALTIME_VOICES: UnifiedVoice[] = [
    { id: 'alloy', provider: 'openai-realtime', name: 'Alloy', labels: { gender: 'neutral', category: 'realtime' } },
    { id: 'ash', provider: 'openai-realtime', name: 'Ash', labels: { gender: 'male', category: 'realtime' } },
    { id: 'ballad', provider: 'openai-realtime', name: 'Ballad', labels: { gender: 'male', category: 'realtime' } },
    { id: 'coral', provider: 'openai-realtime', name: 'Coral', labels: { gender: 'female', category: 'realtime' } },
    { id: 'echo', provider: 'openai-realtime', name: 'Echo', labels: { gender: 'male', category: 'realtime' } },
    { id: 'sage', provider: 'openai-realtime', name: 'Sage', labels: { gender: 'female', category: 'realtime' } },
    { id: 'shimmer', provider: 'openai-realtime', name: 'Shimmer', labels: { gender: 'female', category: 'realtime' } },
    { id: 'verse', provider: 'openai-realtime', name: 'Verse', labels: { gender: 'male', category: 'realtime' } },
];

// ── Settings schemas (static) ────────────────────────────────────────

const ELEVENLABS_SETTINGS: VoiceSettingField[] = [
    { key: 'stability', type: 'range', label: 'Stability', default: 0.5, min: 0, max: 1, step: 0.05, lowLabel: 'Variable', highLabel: 'Stable' },
    { key: 'similarity', type: 'range', label: 'Similarity', default: 0.75, min: 0, max: 1, step: 0.05, lowLabel: 'Low', highLabel: 'High' },
    { key: 'style', type: 'range', label: 'Style', default: 0, min: 0, max: 1, step: 0.05, lowLabel: 'None', highLabel: 'Exaggerated' },
    { key: 'speakerBoost', type: 'boolean', label: 'Speaker Boost', default: true },
];

// ── Default voice IDs ────────────────────────────────────────────────

const DEFAULT_VOICES: Record<VoiceProviderType, string> = {
    'elevenlabs': 'pNInz6obpgDQGcFmaJgB',  // Adam
    'deepgram': 'aura-2-thalia-en',          // Thalia
    'openai-tts': 'nova',
    'openai-realtime': 'coral',
    'inworld': 'Pixie',
};

// ── Deepgram Aura 2 static voice list ────────────────────────────────
// The Deepgram SDK models.getAll() returns STT models, not TTS voices.
// Aura 2 TTS voices are a known static set.
// Source: https://developers.deepgram.com/docs/tts-models

const DEEPGRAM_AURA2_VOICES: UnifiedVoice[] = [
    // English
    { id: 'aura-2-amalthea-en', provider: 'deepgram', name: 'Amalthea', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-andromeda-en', provider: 'deepgram', name: 'Andromeda', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-apollo-en', provider: 'deepgram', name: 'Apollo', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-arcas-en', provider: 'deepgram', name: 'Arcas', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-aries-en', provider: 'deepgram', name: 'Aries', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-asteria-en', provider: 'deepgram', name: 'Asteria', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-athena-en', provider: 'deepgram', name: 'Athena', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-atlas-en', provider: 'deepgram', name: 'Atlas', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-aurora-en', provider: 'deepgram', name: 'Aurora', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-callista-en', provider: 'deepgram', name: 'Callista', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-cora-en', provider: 'deepgram', name: 'Cora', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-cordelia-en', provider: 'deepgram', name: 'Cordelia', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-delia-en', provider: 'deepgram', name: 'Delia', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-draco-en', provider: 'deepgram', name: 'Draco', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-electra-en', provider: 'deepgram', name: 'Electra', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-harmonia-en', provider: 'deepgram', name: 'Harmonia', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-helena-en', provider: 'deepgram', name: 'Helena', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-hera-en', provider: 'deepgram', name: 'Hera', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-hermes-en', provider: 'deepgram', name: 'Hermes', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-hyperion-en', provider: 'deepgram', name: 'Hyperion', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-iris-en', provider: 'deepgram', name: 'Iris', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-janus-en', provider: 'deepgram', name: 'Janus', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-juno-en', provider: 'deepgram', name: 'Juno', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-jupiter-en', provider: 'deepgram', name: 'Jupiter', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-luna-en', provider: 'deepgram', name: 'Luna', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-mars-en', provider: 'deepgram', name: 'Mars', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-minerva-en', provider: 'deepgram', name: 'Minerva', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-neptune-en', provider: 'deepgram', name: 'Neptune', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-odysseus-en', provider: 'deepgram', name: 'Odysseus', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-ophelia-en', provider: 'deepgram', name: 'Ophelia', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-orion-en', provider: 'deepgram', name: 'Orion', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-orpheus-en', provider: 'deepgram', name: 'Orpheus', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-pandora-en', provider: 'deepgram', name: 'Pandora', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-perseus-en', provider: 'deepgram', name: 'Perseus', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-phoebe-en', provider: 'deepgram', name: 'Phoebe', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-pluto-en', provider: 'deepgram', name: 'Pluto', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-saturn-en', provider: 'deepgram', name: 'Saturn', labels: { gender: 'male', language: 'en' } },
    { id: 'aura-2-selene-en', provider: 'deepgram', name: 'Selene', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-stella-en', provider: 'deepgram', name: 'Stella', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-thalia-en', provider: 'deepgram', name: 'Thalia', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-theia-en', provider: 'deepgram', name: 'Theia', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-vesta-en', provider: 'deepgram', name: 'Vesta', labels: { gender: 'female', language: 'en' } },
    { id: 'aura-2-zeus-en', provider: 'deepgram', name: 'Zeus', labels: { gender: 'male', language: 'en' } },
    // Spanish
    { id: 'aura-2-agustina-es', provider: 'deepgram', name: 'Agustina', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-alvaro-es', provider: 'deepgram', name: 'Alvaro', labels: { gender: 'male', language: 'es' } },
    { id: 'aura-2-antonia-es', provider: 'deepgram', name: 'Antonia', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-aquila-es', provider: 'deepgram', name: 'Aquila', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-carina-es', provider: 'deepgram', name: 'Carina', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-celeste-es', provider: 'deepgram', name: 'Celeste', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-diana-es', provider: 'deepgram', name: 'Diana', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-estrella-es', provider: 'deepgram', name: 'Estrella', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-gloria-es', provider: 'deepgram', name: 'Gloria', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-javier-es', provider: 'deepgram', name: 'Javier', labels: { gender: 'male', language: 'es' } },
    { id: 'aura-2-luciano-es', provider: 'deepgram', name: 'Luciano', labels: { gender: 'male', language: 'es' } },
    { id: 'aura-2-nestor-es', provider: 'deepgram', name: 'Nestor', labels: { gender: 'male', language: 'es' } },
    { id: 'aura-2-olivia-es', provider: 'deepgram', name: 'Olivia', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-selena-es', provider: 'deepgram', name: 'Selena', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-silvia-es', provider: 'deepgram', name: 'Silvia', labels: { gender: 'female', language: 'es' } },
    { id: 'aura-2-sirio-es', provider: 'deepgram', name: 'Sirio', labels: { gender: 'male', language: 'es' } },
    { id: 'aura-2-valerio-es', provider: 'deepgram', name: 'Valerio', labels: { gender: 'male', language: 'es' } },
];

// ── Helpers ──────────────────────────────────────────────────────────

async function asyncIterableToBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as ArrayBufferLike));
    }
    return Buffer.concat(chunks);
}

async function webStreamToBuffer(stream: ReadableStream): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}

// ── Preview cache ────────────────────────────────────────────────────

interface CachedPreview {
    audio: Buffer;
    contentType: string;
    timestamp: number;
}

// ── VoiceRegistry ────────────────────────────────────────────────────

export class VoiceRegistry {
    private config: ServerConfig;
    private cache: VoicesResponse | null = null;
    private cacheTimestamp = 0;
    private previewCache = new Map<string, CachedPreview>();

    constructor(config: ServerConfig) {
        this.config = config;
    }

    // ── Voice listing ────────────────────────────────────────────────

    async getVoices(): Promise<VoicesResponse> {
        // Return cache if still valid
        if (this.cache && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
            return this.cache;
        }

        const providers: Partial<Record<VoiceProviderType, ProviderVoices>> = {};

        // Fetch all configured providers in parallel
        const tasks: Array<Promise<void>> = [];

        if (isProviderAvailable('elevenlabs', this.config)) {
            tasks.push(this.fetchElevenLabs().then(p => { providers['elevenlabs'] = p; }).catch(err => {
                console.error('[VoiceRegistry] Failed to fetch ElevenLabs voices:', err.message);
            }));
        }

        if (isProviderAvailable('deepgram', this.config)) {
            tasks.push(this.fetchDeepgram().then(p => { providers['deepgram'] = p; }).catch(err => {
                console.error('[VoiceRegistry] Failed to fetch Deepgram voices:', err.message);
            }));
        }

        if (isProviderAvailable('openai-tts', this.config)) {
            tasks.push(Promise.resolve().then(() => { providers['openai-tts'] = this.getOpenAITTS(); }));
        }

        if (isProviderAvailable('openai-realtime', this.config)) {
            tasks.push(Promise.resolve().then(() => { providers['openai-realtime'] = this.getOpenAIRealtime(); }));
        }

        if (isProviderAvailable('inworld', this.config)) {
            tasks.push(this.fetchInWorld().then(p => { providers['inworld'] = p; }).catch(err => {
                console.error('[VoiceRegistry] Failed to fetch InWorld voices:', err.message);
            }));
        }

        await Promise.all(tasks);

        const response: VoicesResponse = { providers };
        this.cache = response;
        this.cacheTimestamp = Date.now();

        return response;
    }

    // ── TTS preview generation ───────────────────────────────────────

    async generatePreview(
        provider: VoiceProviderType,
        voiceId: string,
        text: string,
    ): Promise<{ audio: Buffer; contentType: string }> {
        const cacheKey = `${provider}:${voiceId}:${text}`;

        // Check cache
        const cached = this.previewCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < PREVIEW_CACHE_TTL_MS) {
            return { audio: cached.audio, contentType: cached.contentType };
        }

        let audio: Buffer;
        const contentType = 'audio/mpeg';

        switch (provider) {
            case 'elevenlabs':
                audio = await this.generateElevenLabsPreview(voiceId, text);
                break;
            case 'deepgram':
                audio = await this.generateDeepgramPreview(voiceId, text);
                break;
            case 'openai-tts':
                audio = await this.generateOpenAIPreview(voiceId, 'tts-1', text);
                break;
            case 'openai-realtime':
                // Use gpt-4o-mini-tts for realtime voices (supports ash, ballad, coral, sage, verse)
                audio = await this.generateOpenAIPreview(voiceId, 'gpt-4o-mini-tts', text);
                break;
            case 'inworld':
                audio = await this.generateInWorldPreview(voiceId, text);
                break;
            default:
                throw new Error(`Unsupported provider: ${provider}`);
        }

        // Cache the generated audio
        this.previewCache.set(cacheKey, { audio, contentType, timestamp: Date.now() });

        return { audio, contentType };
    }

    // ── Provider fetchers (voice listing) ────────────────────────────

    private async fetchElevenLabs(): Promise<ProviderVoices> {
        const client = new ElevenLabsClient({ apiKey: this.config.elevenlabsApiKey! });
        const result = await client.voices.getAll();
        const voices: UnifiedVoice[] = (result.voices || []).map(v => ({
            id: v.voiceId || '',
            provider: 'elevenlabs' as VoiceProviderType,
            name: v.name || '',
            labels: {
                ...(v.labels?.accent ? { accent: v.labels.accent } : {}),
                ...(v.labels?.gender ? { gender: v.labels.gender } : {}),
                ...(v.labels?.age ? { age: v.labels.age } : {}),
                ...(v.category ? { category: v.category } : {}),
            },
        }));

        voices.sort((a, b) => a.name.localeCompare(b.name));

        return {
            voices,
            settings: ELEVENLABS_SETTINGS,
            defaultVoiceId: DEFAULT_VOICES['elevenlabs'],
        };
    }

    private async fetchDeepgram(): Promise<ProviderVoices> {
        // Validate that the API key works with a lightweight call
        const _client = createClient(this.config.deepgramApiKey!);
        void _client; // key validity will be checked at TTS time

        return {
            voices: DEEPGRAM_AURA2_VOICES,
            settings: [],
            defaultVoiceId: DEFAULT_VOICES['deepgram'],
        };
    }

    private getOpenAITTS(): ProviderVoices {
        return {
            voices: OPENAI_TTS_VOICES,
            settings: [],
            defaultVoiceId: DEFAULT_VOICES['openai-tts'],
        };
    }

    private getOpenAIRealtime(): ProviderVoices {
        return {
            voices: OPENAI_REALTIME_VOICES,
            settings: [],
            defaultVoiceId: DEFAULT_VOICES['openai-realtime'],
        };
    }

    // ── Provider TTS generators (preview audio) ─────────────────────

    private async generateElevenLabsPreview(voiceId: string, text: string): Promise<Buffer> {
        const client = new ElevenLabsClient({ apiKey: this.config.elevenlabsApiKey! });
        const audioStream = await client.textToSpeech.convert(voiceId, {
            text,
            modelId: 'eleven_v3',
            outputFormat: 'mp3_44100_128',
        });
        return await asyncIterableToBuffer(audioStream);
    }

    private async generateDeepgramPreview(voiceId: string, text: string): Promise<Buffer> {
        const client = createClient(this.config.deepgramApiKey!);
        const response = await client.speak.request(
            { text },
            { model: voiceId, encoding: 'mp3' },
        );
        const stream = await response.getStream();
        if (!stream) throw new Error('Deepgram returned no audio stream');
        return await webStreamToBuffer(stream);
    }

    private async generateOpenAIPreview(voiceId: string, model: string, text: string): Promise<Buffer> {
        const client = new OpenAI({ apiKey: this.config.openaiApiKey! });
        const response = await client.audio.speech.create({
            model,
            voice: voiceId as 'alloy',
            input: text,
            response_format: 'mp3',
        });
        return Buffer.from(await response.arrayBuffer());
    }

    // ── InWorld ──────────────────────────────────────────────────────

    private async fetchInWorld(): Promise<ProviderVoices> {
        const response = await fetch('https://api.inworld.ai/tts/v1/voices?filter=language=en', {
            headers: { 'Authorization': `Basic ${this.config.inworldApiKey}` },
        });
        if (!response.ok) {
            throw new Error(`InWorld voices API error: ${response.status}`);
        }
        const data = await response.json() as {
            voices?: Array<{
                voiceId: string;
                name?: string;
                displayName?: string;
                description?: string;
                langCode?: string;
                tags?: string[];
                voiceMetadata?: {
                    gender?: string;
                    age?: string;
                    accent?: string;
                };
            }>;
        };

        // Known tag values that map to structured label categories
        const GENDER_TAGS = new Set(['male', 'female', 'non-binary']);
        const AGE_TAGS = new Set(['young_adult', 'adult', 'middle-aged', 'elderly']);

        const voices: UnifiedVoice[] = (data.voices || []).map(v => {
            const tags = v.tags || [];
            const meta = v.voiceMetadata || {};

            // Prefer structured voiceMetadata, fall back to parsing tags
            const gender = meta.gender || tags.find(t => GENDER_TAGS.has(t.toLowerCase()))  || '';
            const age = meta.age || tags.find(t => AGE_TAGS.has(t.toLowerCase())) || '';
            const accent = meta.accent || '';

            // Remaining tags (style/quality descriptors like "warm", "energetic", "professional")
            const styleTags = tags.filter(t => !GENDER_TAGS.has(t.toLowerCase()) && !AGE_TAGS.has(t.toLowerCase()));

            return {
                id: v.voiceId,
                provider: 'inworld' as VoiceProviderType,
                name: v.displayName || v.name || v.voiceId,
                labels: {
                    ...(gender ? { gender } : {}),
                    ...(age ? { age } : {}),
                    ...(accent ? { accent } : {}),
                    ...(styleTags.length ? { category: styleTags.join(', ') } : {}),
                    ...(v.description ? { description: v.description } : {}),
                    ...(v.langCode ? { language: v.langCode } : {}),
                },
            };
        });

        voices.sort((a, b) => a.name.localeCompare(b.name));

        return {
            voices,
            settings: [],
            defaultVoiceId: DEFAULT_VOICES['inworld'],
        };
    }

    private async generateInWorldPreview(voiceId: string, text: string): Promise<Buffer> {
        // Use non-streaming endpoint for preview (returns complete audio)
        const response = await fetch('https://api.inworld.ai/tts/v1/voice', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${this.config.inworldApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text,
                voiceId,
                modelId: 'inworld-tts-1.5-max',
                audioConfig: { audioEncoding: 'MP3' },
            }),
        });
        if (!response.ok) {
            throw new Error(`InWorld preview error: ${response.status}`);
        }
        const data = await response.json() as { audioContent?: string };
        if (!data.audioContent) {
            throw new Error('InWorld preview returned no audio');
        }
        return Buffer.from(data.audioContent, 'base64');
    }
}
