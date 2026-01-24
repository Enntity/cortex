/**
 * Deepgram Streaming Speech-to-Text
 *
 * Provides real-time transcription with minimal latency.
 * Audio is streamed as it arrives, so transcript is ready
 * almost immediately when speech ends.
 */

import { createClient, LiveTranscriptionEvents, LiveClient } from '@deepgram/sdk';
import { StreamingSTT, StreamingSTTConfig } from './StreamingSTT.js';

export interface DeepgramSTTConfig extends StreamingSTTConfig {
    model?: string;
}

export class DeepgramStreamingSTT extends StreamingSTT {
    private client: ReturnType<typeof createClient>;
    private connection: LiveClient | null = null;
    private model: string;
    private keepAliveInterval: NodeJS.Timeout | null = null;

    constructor(config: DeepgramSTTConfig) {
        super(config);
        this.client = createClient(config.apiKey);
        this.model = config.model || 'nova-2'; // Fast and accurate
    }

    /**
     * Start a new transcription session
     */
    async start(): Promise<void> {
        if (this.connection) {
            await this.stop();
        }

        this.transcript = '';

        this.connection = this.client.listen.live({
            model: this.model,
            language: this.config.language || 'en',
            smart_format: true,
            sample_rate: this.config.sampleRate || 16000,
            channels: 1,
            encoding: 'linear16',
            interim_results: true,
            utterance_end_ms: 1000,
            vad_events: true,
        });

        this.connection.on(LiveTranscriptionEvents.Open, () => {
            console.log('[DeepgramSTT] Connection opened');
            this.isConnected = true;
            this.emit('connected');

            // Keep connection alive
            this.keepAliveInterval = setInterval(() => {
                if (this.connection && this.isConnected) {
                    this.connection.keepAlive();
                }
            }, 10000);
        });

        this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
            const text = data.channel?.alternatives?.[0]?.transcript;
            if (!text) return;

            if (data.is_final) {
                // Final transcript for this segment
                this.transcript += (this.transcript ? ' ' : '') + text;
                console.log('[DeepgramSTT] Final segment:', text);
                this.emit('transcript', { text: this.transcript, isFinal: true });
            } else {
                // Interim result
                const interim = this.transcript + (this.transcript ? ' ' : '') + text;
                this.emit('transcript', { text: interim, isFinal: false });
            }
        });

        this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
            console.log('[DeepgramSTT] Utterance end detected');
            this.emit('utteranceEnd', { text: this.transcript });
        });

        this.connection.on(LiveTranscriptionEvents.Error, (error) => {
            console.error('[DeepgramSTT] Error:', error);
            this.emit('error', error);
        });

        this.connection.on(LiveTranscriptionEvents.Close, () => {
            console.log('[DeepgramSTT] Connection closed');
            this.isConnected = false;
            this.emit('disconnected');
        });
    }

    /**
     * Send audio data for transcription
     */
    sendAudio(audioBuffer: Buffer): void {
        if (this.connection && this.isConnected) {
            // Convert Buffer to ArrayBuffer for Deepgram
            const arrayBuffer = audioBuffer.buffer.slice(
                audioBuffer.byteOffset,
                audioBuffer.byteOffset + audioBuffer.byteLength
            );
            this.connection.send(arrayBuffer);
        }
    }

    /**
     * Finalize and get the transcript, requesting any pending results
     */
    async finalize(): Promise<string> {
        // Give Deepgram a moment to send final results
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.transcript.trim();
    }

    /**
     * Stop the transcription session
     */
    async stop(): Promise<void> {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }

        if (this.connection) {
            this.connection.requestClose();
            this.connection = null;
        }

        this.isConnected = false;
        this.transcript = '';
    }
}
