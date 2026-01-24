/**
 * ElevenLabs Streaming Speech-to-Text
 *
 * Uses ElevenLabs' realtime WebSocket API for low-latency transcription.
 * Their Scribe v2 model provides excellent accuracy across 90+ languages.
 */

import WebSocket from 'ws';
import { StreamingSTT, StreamingSTTConfig } from './StreamingSTT.js';

export interface ElevenLabsSTTConfig extends StreamingSTTConfig {
    model?: string;
    region?: 'us' | 'eu' | 'default';
}

export class ElevenLabsStreamingSTT extends StreamingSTT {
    private ws: WebSocket | null = null;
    private model: string;
    private region: string;
    private pendingFinalize: ((value: string) => void) | null = null;
    private isConnecting: boolean = false;

    constructor(config: ElevenLabsSTTConfig) {
        super(config);
        this.model = config.model || 'scribe_v2_realtime';
        this.region = config.region || 'default';
    }

    private getEndpoint(): string {
        const language = this.config.language || 'en';

        let baseUrl: string;
        switch (this.region) {
            case 'us':
                baseUrl = 'wss://api.us.elevenlabs.io';
                break;
            case 'eu':
                baseUrl = 'wss://api.eu.residency.elevenlabs.io';
                break;
            default:
                baseUrl = 'wss://api.elevenlabs.io';
        }

        const params = new URLSearchParams({
            model_id: this.model,
            language_code: language,
        });

        return `${baseUrl}/v1/speech-to-text/realtime?${params.toString()}`;
    }

    async start(): Promise<void> {
        // Prevent concurrent connection attempts
        if (this.isConnecting) {
            console.log('[ElevenLabsSTT] Already connecting, skipping');
            return;
        }

        if (this.ws) {
            await this.stop();
        }

        this.transcript = '';
        this.isConnecting = true;

        return new Promise((resolve, reject) => {
            const endpoint = this.getEndpoint();
            console.log('[ElevenLabsSTT] Connecting to:', endpoint);

            try {
                this.ws = new WebSocket(endpoint, {
                    headers: {
                        'xi-api-key': this.config.apiKey,
                    },
                });
            } catch (error) {
                this.isConnecting = false;
                reject(error);
                return;
            }

            this.ws.on('open', () => {
                console.log('[ElevenLabsSTT] Connected');
                this.isConnected = true;
                this.isConnecting = false;
                this.emit('connected');
                resolve();
            });

            this.ws.on('message', (data: Buffer) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (error) {
                    console.error('[ElevenLabsSTT] Failed to parse message:', error);
                }
            });

            this.ws.on('error', (error) => {
                console.error('[ElevenLabsSTT] WebSocket error:', error.message);
                this.isConnecting = false;
                // Don't emit error event - just log it to prevent unhandled error crashes
                if (!this.isConnected) {
                    reject(error);
                }
            });

            this.ws.on('close', (code, reason) => {
                console.log('[ElevenLabsSTT] Connection closed:', code, reason.toString());
                this.isConnected = false;
                this.isConnecting = false;
                this.ws = null;
                this.emit('disconnected');

                // Don't auto-reconnect - let the provider handle reconnection
            });
        });
    }

    private handleMessage(message: any): void {
        // ElevenLabs uses message_type field
        const msgType = message.message_type || message.type;

        switch (msgType) {
            case 'session_started':
                console.log('[ElevenLabsSTT] Session started:', message.session_id);
                break;

            case 'partial_transcript':
                // Interim result
                const partialText = message.text || '';
                if (partialText) {
                    const interim = this.transcript + (this.transcript ? ' ' : '') + partialText;
                    this.emit('transcript', { text: interim, isFinal: false });
                }
                break;

            case 'committed_transcript':
            case 'committed_transcript_with_timestamps':
                // Final result for this segment
                const finalText = message.text || '';
                if (finalText) {
                    this.transcript += (this.transcript ? ' ' : '') + finalText;
                    console.log('[ElevenLabsSTT] Committed:', finalText);
                    this.emit('transcript', { text: this.transcript, isFinal: true });
                }

                // If we're waiting for finalization, resolve now
                if (this.pendingFinalize) {
                    this.pendingFinalize(this.transcript.trim());
                    this.pendingFinalize = null;
                }
                break;

            case 'error':
            case 'auth_error':
            case 'quota_exceeded':
                console.error('[ElevenLabsSTT] Error message:', message);
                this.emit('error', new Error(message.message || message.error || 'Unknown error'));
                break;

            default:
                console.log('[ElevenLabsSTT] Unknown message type:', msgType, message);
        }
    }

    sendAudio(audioBuffer: Buffer): void {
        if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: audioBuffer.toString('base64'),
                commit: false,
                sample_rate: this.config.sampleRate || 16000,
            });
            this.ws.send(message);
        }
    }

    async finalize(): Promise<string> {
        if (!this.ws || !this.isConnected) {
            return this.transcript.trim();
        }

        // Send commit signal to get final transcript
        const commitMessage = JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: '',
            commit: true,
            sample_rate: this.config.sampleRate || 16000,
        });
        this.ws.send(commitMessage);

        // Wait for committed_transcript response (with timeout)
        return new Promise((resolve) => {
            this.pendingFinalize = resolve;

            // Timeout fallback - don't wait forever
            setTimeout(() => {
                if (this.pendingFinalize) {
                    console.log('[ElevenLabsSTT] Finalize timeout, returning current transcript');
                    this.pendingFinalize = null;
                    resolve(this.transcript.trim());
                }
            }, 500);
        });
    }

    async stop(): Promise<void> {
        this.pendingFinalize = null;
        this.isConnecting = false;

        if (this.ws) {
            // Remove all listeners first to prevent error events during close
            this.ws.removeAllListeners();

            // Only close if the WebSocket is in a closeable state
            if (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING) {
                try {
                    this.ws.close(1000, 'Client closing');
                } catch (e) {
                    // Ignore close errors
                }
            }
            this.ws = null;
        }

        this.isConnected = false;
        this.transcript = '';
    }
}
