/**
 * Streaming Speech-to-Text Interface
 *
 * Pluggable interface for real-time transcription providers.
 * Implementations: ElevenLabs (primary), Deepgram, Whisper (batch fallback)
 */

import { EventEmitter } from 'events';

export interface TranscriptEvent {
    text: string;
    isFinal: boolean;
    confidence?: number;
}

export interface StreamingSTTConfig {
    apiKey: string;
    sampleRate?: number;
    language?: string;
}

export abstract class StreamingSTT extends EventEmitter {
    protected config: StreamingSTTConfig;
    protected transcript: string = '';
    protected isConnected: boolean = false;

    constructor(config: StreamingSTTConfig) {
        super();
        this.config = config;
    }

    /**
     * Start a new transcription session
     */
    abstract start(): Promise<void>;

    /**
     * Send audio data for transcription
     */
    abstract sendAudio(audioBuffer: Buffer): void;

    /**
     * Get the current accumulated transcript
     */
    getTranscript(): string {
        return this.transcript.trim();
    }

    /**
     * Clear the transcript buffer (for new utterance)
     */
    clearTranscript(): void {
        this.transcript = '';
    }

    /**
     * Signal end of speech and get final transcript
     */
    abstract finalize(): Promise<string>;

    /**
     * Stop the transcription session
     */
    abstract stop(): Promise<void>;

    /**
     * Check if connected
     */
    get connected(): boolean {
        return this.isConnected;
    }

    /**
     * Whether the last failure was a fatal/non-retriable error (e.g. auth failure).
     * Subclasses set this to prevent pointless reconnection loops.
     */
    get fatal(): boolean {
        return false;
    }
}

export type STTProvider = 'elevenlabs' | 'deepgram' | 'whisper';
