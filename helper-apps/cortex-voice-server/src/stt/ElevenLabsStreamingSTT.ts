/**
 * ElevenLabs Streaming Speech-to-Text
 *
 * Uses ElevenLabs' realtime WebSocket API for low-latency transcription.
 * Their Scribe v2 model provides excellent accuracy across 90+ languages.
 */

import WebSocket from 'ws';
import * as fs from 'fs';
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
    private _fatalError: boolean = false;
    private audioChunkCount: number = 0;
    private audioDropCount: number = 0;
    private debugBuffers: Buffer[] = [];
    private debugSaved: boolean = false;

    constructor(config: ElevenLabsSTTConfig) {
        super(config);
        this.model = config.model || 'scribe_v2_realtime';
        this.region = config.region || 'default';
    }

    override get fatal(): boolean {
        return this._fatalError;
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

        // Log ALL messages for debugging
        if (msgType !== 'session_started') {
            console.log(`[ElevenLabsSTT] Message: type=${msgType}, text="${(message.text || '').substring(0, 80)}", keys=${Object.keys(message).join(',')}`);
        }

        switch (msgType) {
            case 'session_started':
                console.log('[ElevenLabsSTT] Session started:', message.session_id);
                this.audioChunkCount = 0;
                this.audioDropCount = 0;
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
                if (msgType === 'auth_error' || msgType === 'quota_exceeded') {
                    this._fatalError = true;
                }
                this.emit('error', new Error(message.message || message.error || 'Unknown error'));
                break;

            default:
                console.log('[ElevenLabsSTT] Unknown message type:', msgType, message);
        }
    }

    sendAudio(audioBuffer: Buffer): void {
        if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
            this.audioChunkCount++;
            if (this.audioChunkCount <= 3 || this.audioChunkCount % 50 === 0) {
                // Calculate RMS of PCM16 audio to check if it has signal
                let sumSq = 0;
                let maxAbs = 0;
                const sampleCount = audioBuffer.length / 2;
                for (let i = 0; i < audioBuffer.length - 1; i += 2) {
                    const sample = audioBuffer.readInt16LE(i);
                    sumSq += sample * sample;
                    maxAbs = Math.max(maxAbs, Math.abs(sample));
                }
                const rms = Math.sqrt(sumSq / sampleCount);
                console.log(`[ElevenLabsSTT] Chunk #${this.audioChunkCount}: ${audioBuffer.length} bytes, RMS=${rms.toFixed(1)}, peak=${maxAbs}, samples=${sampleCount}`);
            }
            // Capture first 100 chunks for debug WAV
            if (!this.debugSaved && this.debugBuffers.length < 100) {
                this.debugBuffers.push(Buffer.from(audioBuffer));
            }
            if (!this.debugSaved && this.debugBuffers.length === 100) {
                this.debugSaved = true;
                this.saveDebugWav();
            }

            const message = JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: audioBuffer.toString('base64'),
                commit: false,
                sample_rate: this.config.sampleRate || 16000,
            });
            this.ws.send(message);
        } else {
            this.audioDropCount++;
            if (this.audioDropCount <= 5) {
                console.log(`[ElevenLabsSTT] Dropping chunk #${this.audioDropCount}: ws=${!!this.ws}, connected=${this.isConnected}, readyState=${this.ws?.readyState}`);
            }
        }
    }

    private saveDebugWav(): void {
        const data = Buffer.concat(this.debugBuffers);
        const sampleRate = this.config.sampleRate || 16000;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + data.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM
        header.writeUInt16LE(1, 22); // mono
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * 2, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(data.length, 40);
        fs.writeFileSync('/tmp/ios_audio_debug.wav', Buffer.concat([header, data]));
        console.log(`[ElevenLabsSTT] Debug WAV saved: /tmp/ios_audio_debug.wav (${data.length} bytes, ${(data.length / 2 / sampleRate).toFixed(1)}s)`);
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
