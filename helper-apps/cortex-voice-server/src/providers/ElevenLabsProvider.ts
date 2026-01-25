/**
 * ElevenLabs Voice Provider (Streaming)
 *
 * High-quality TTS with natural voices and voice cloning capability.
 * Supports streaming responses from Cortex - sentences are spoken as they arrive.
 * Pipeline: STT (Deepgram streaming) -> Cortex Agent (streaming) -> TTS (ElevenLabs)
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceProviderType,
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
    ToolStatusEvent,
    MediaEvent,
} from '../types.js';
import { StreamingCortexBridge } from '../cortex/StreamingCortexBridge.js';
import { StreamingSTT, createStreamingSTT, STTProvider } from '../stt/index.js';

export class ElevenLabsProvider extends BaseVoiceProvider {
    readonly type: VoiceProviderType = 'elevenlabs';

    private elevenlabs: ElevenLabsClient;
    private conversationHistory: ConversationMessage[] = [];
    private isProcessing: boolean = false;
    private voiceId: string = 'pNInz6obpgDQGcFmaJgB'; // Default: Adam

    // Streaming STT (replaces batch Whisper for low latency)
    private streamingSTT: StreamingSTT | null = null;
    private sttProvider: STTProvider = 'elevenlabs';
    private deepgramApiKey: string | null = null;

    // Streaming support
    private streamingBridge: StreamingCortexBridge | null = null;
    private sentenceQueue: string[] = [];
    private isSpeaking: boolean = false;
    private currentTrackId: number = 0;

    // Progressive batching for better TTS prosody
    // Strategy: Send first sentence immediately for low latency, then buffer
    // all subsequent sentences while TTS is playing. When TTS finishes,
    // flush the entire buffer as one chunk for maximum prosody context.
    private isFirstChunk: boolean = true;
    private pendingBatch: string[] = [];
    private readonly INTER_CHUNK_DELAY_MS = 120; // Small pause between chunks for natural rhythm

    constructor(
        cortexBridge: ICortexBridge,
        private elevenlabsApiKey: string,
        deepgramApiKey?: string,
        sttProvider?: STTProvider
    ) {
        super(cortexBridge);
        this.elevenlabs = new ElevenLabsClient({ apiKey: elevenlabsApiKey });
        this.deepgramApiKey = deepgramApiKey || null;
        this.sttProvider = sttProvider || 'elevenlabs'; // Default to ElevenLabs STT

        // Check if cortexBridge is a StreamingCortexBridge
        if (cortexBridge instanceof StreamingCortexBridge) {
            this.streamingBridge = cortexBridge;
            this.setupStreamingListeners();
        }
    }

    /**
     * Setup listeners for streaming bridge events
     */
    private setupStreamingListeners(): void {
        if (!this.streamingBridge) return;

        // Handle incoming sentences - queue them for TTS
        this.streamingBridge.on('sentence', (sentence: string) => {
            console.log('[ElevenLabs] Received sentence:', sentence.substring(0, 50) + '...');
            this.queueSentence(sentence);
        });

        // Forward tool status events
        this.streamingBridge.on('tool-status', (event: ToolStatusEvent) => {
            this.emit('tool-status', {
                ...event,
                timestamp: Date.now(),
            });
        });

        // Handle thinking state
        this.streamingBridge.on('thinking', (isThinking: boolean) => {
            if (isThinking && this._state === 'processing') {
                // Emit a thinking tool status
                this.emit('tool-status', {
                    name: 'thinking',
                    status: 'running',
                    message: 'Thinking...',
                    timestamp: Date.now(),
                });
            }
        });

        // Handle completion
        this.streamingBridge.on('complete', (fullText: string) => {
            console.log('[ElevenLabs] Stream complete, full response length:', fullText.length);

            // Flush any remaining batched sentences
            this.flushBatch();

            // Only add to history if we got content
            // Note: transcript display is handled by track-start events for better audio sync
            if (fullText && fullText.trim().length > 0) {
                // Add to conversation history (server-side)
                this.conversationHistory.push({
                    role: 'assistant',
                    content: fullText,
                    timestamp: Date.now(),
                });

                // Emit final transcript for client-side history recording
                // This triggers _addToHistory() on the client when voice mode ends
                this.emit('transcript', {
                    type: 'assistant',
                    content: fullText,
                    isFinal: true,
                    timestamp: Date.now(),
                });
            } else {
                console.warn('[ElevenLabs] Stream completed with empty response');
            }

            // If nothing is queued to speak, go back to idle
            // This handles cases where stream completes with no/empty content
            if (this.sentenceQueue.length === 0 && this.pendingBatch.length === 0 && !this.isSpeaking) {
                this.isProcessing = false;
                this.setState('idle');
            }
        });

        // Handle errors
        this.streamingBridge.on('error', (error: Error) => {
            console.error('[ElevenLabs] Stream error:', error);
            this.emitError(error);
            this.isProcessing = false;
            this.setState('idle');
        });

        // Forward media events (e.g., ShowOverlay)
        this.streamingBridge.on('media', (event: MediaEvent) => {
            console.log('[ElevenLabs] Media event:', event.type, event.items?.length || 0, 'items');
            this.emit('media', event);
        });
    }

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

        // Use custom voice ID if provided
        if (config.voiceId) {
            this.voiceId = config.voiceId;
        }

        // If entity has a voice sample, try to clone it
        if (config.voiceSample) {
            try {
                await this.setupVoiceClone(config.voiceSample, config.entityId);
            } catch (error) {
                console.warn('[ElevenLabs] Failed to setup voice clone, using default:', error);
            }
        }

        // Initialize streaming STT
        this.streamingSTT = createStreamingSTT({
            provider: this.sttProvider,
            elevenlabsApiKey: this.elevenlabsApiKey,
            deepgramApiKey: this.deepgramApiKey || undefined,
            sampleRate: 16000, // Client sends 16kHz from VAD
            language: 'en',
            apiKey: '', // Required by interface but we use specific keys above
        });

        if (this.streamingSTT) {
            this.streamingSTT.on('transcript', (data) => {
                // Emit interim transcripts so client can show live text
                if (!data.isFinal) {
                    this.emit('transcript', {
                        type: 'user',
                        content: data.text,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }
            });

            await this.streamingSTT.start();
            console.log(`[ElevenLabs] Streaming STT initialized (${this.sttProvider})`);
        } else {
            console.log('[ElevenLabs] No streaming STT - falling back to batch Whisper');
        }

        this.setConnected(true);
        this.setState('idle');

        console.log(`[ElevenLabs] Connected for entity: ${config.entityId}, voice: ${this.voiceId}, streaming: ${!!this.streamingBridge}`);
    }

    private async setupVoiceClone(voiceSampleUrl: string, _entityId: string): Promise<void> {
        // Voice cloning requires ElevenLabs Professional plan - placeholder for future implementation
        console.log(`[ElevenLabs] Voice sample available for cloning: ${voiceSampleUrl}`);
    }

    async disconnect(): Promise<void> {
        // Cancel any streaming query
        if (this.streamingBridge) {
            this.streamingBridge.cancel();
        }

        // Stop streaming STT
        if (this.streamingSTT) {
            await this.streamingSTT.stop();
            this.streamingSTT = null;
        }

        // Clean up batching state
        this.resetBatchingState();

        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
        this.isSpeaking = false;
    }

    sendAudio(data: AudioData): void {
        if (!this._isConnected || this._isMuted || this.isProcessing) {
            return;
        }

        const buffer = Buffer.from(data.data, 'base64');

        // Stream to STT for real-time transcription
        // Reconnect if STT was disconnected (e.g., server-side idle timeout)
        if (this.streamingSTT) {
            if (!this.streamingSTT.connected) {
                console.log('[ElevenLabs] STT disconnected, reconnecting...');
                this.streamingSTT.start().catch(err => {
                    console.error('[ElevenLabs] Failed to reconnect STT:', err);
                });
            }
            this.streamingSTT.sendAudio(buffer);
        }

        if (this._state !== 'listening') {
            this.setState('listening');
        }
    }

    /**
     * Queue a sentence for TTS processing with progressive batching
     * First sentence goes immediately for low latency, subsequent sentences
     * are buffered while TTS is playing and flushed as one chunk when ready
     */
    private queueSentence(sentence: string): void {
        if (this.isFirstChunk) {
            // First sentence: send immediately for low latency
            console.log('[ElevenLabs] First chunk - sending immediately for low latency');
            this.isFirstChunk = false;
            this.sentenceQueue.push(sentence);
            this.processNextBatch();
        } else {
            // Buffer while TTS is playing - will be flushed when current chunk finishes
            this.pendingBatch.push(sentence);
            console.log(`[ElevenLabs] Buffering sentence (${this.pendingBatch.length} pending)`);

            // If not currently speaking, flush immediately
            if (!this.isSpeaking) {
                this.flushBatch();
            }
            // Otherwise, batch will be flushed when current TTS finishes
        }
    }

    /**
     * Flush all pending sentences to the queue as a single chunk
     */
    private flushBatch(): void {
        if (this.pendingBatch.length > 0) {
            // Join all sentences into a single TTS chunk for better prosody
            const batchedText = this.pendingBatch.join(' ');
            console.log(`[ElevenLabs] Flushing ${this.pendingBatch.length} sentences as one chunk`);
            this.pendingBatch = [];
            this.sentenceQueue.push(batchedText);
            this.processNextBatch();
        }
    }

    /**
     * Process the next batch/chunk in the queue
     */
    private async processNextBatch(): Promise<void> {
        // Don't start if already speaking or queue is empty
        if (this.isSpeaking || this.sentenceQueue.length === 0) {
            return;
        }

        this.isSpeaking = true;
        const text = this.sentenceQueue.shift()!;
        this.currentTrackId++;
        const trackId = `chunk-${this.currentTrackId}`;

        try {
            this.setState('speaking');

            // Note: transcript is now sent via track-start event in textToSpeechChunk
            // for better synchronization with audio playback

            await this.textToSpeechChunk(text, trackId);
        } catch (error) {
            console.error('[ElevenLabs] Error speaking chunk:', error);
        } finally {
            this.isSpeaking = false;

            // Flush any sentences that accumulated while we were speaking
            if (this.pendingBatch.length > 0) {
                await this.delay(this.INTER_CHUNK_DELAY_MS);
                this.flushBatch();
            } else if (this.sentenceQueue.length > 0) {
                // More chunks waiting in queue
                await this.delay(this.INTER_CHUNK_DELAY_MS);
                this.processNextBatch();
            } else if (!this.isProcessing) {
                // All done, back to idle
                this.setState('idle');
            }
        }
    }

    /**
     * Small delay helper for inter-chunk pauses
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Reset batching state for a new response
     */
    private resetBatchingState(): void {
        this.sentenceQueue = [];
        this.pendingBatch = [];
        this.isFirstChunk = true;
    }

    /**
     * Convert a text chunk to speech (streaming)
     * Can be a single sentence (first chunk) or multiple sentences (batched)
     */
    private async textToSpeechChunk(text: string, trackId: string): Promise<void> {
        try {
            // Emit track-start with text so client can sync transcript with audio
            this.emit('track-start', { trackId, text });

            const audioStream = await this.elevenlabs.textToSpeech.stream(
                this.voiceId,
                {
                    text,
                    modelId: 'eleven_v3',
                    outputFormat: 'pcm_24000',
                    voiceSettings: {
                        stability: 0.5,
                        similarityBoost: 0.75,
                        style: 0.0,
                        useSpeakerBoost: true,
                    },
                }
            );

            let pendingBuffer = Buffer.alloc(0);
            // Use chunk size that aligns with 128-sample AudioWorklet frames
            // 128 samples * 2 bytes = 256 bytes per frame
            // 2560 samples = 256 * 10 = 20 frames = ~107ms at 24kHz
            const minChunkSize = 5120; // 2560 samples, aligned to worklet frames

            for await (const chunk of audioStream) {
                if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
                    pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(chunk)]);

                    while (pendingBuffer.length >= minChunkSize) {
                        // Ensure alignment to 256 bytes (128 samples * 2 bytes)
                        const sendSize = Math.floor(minChunkSize / 256) * 256;
                        const sendChunk = pendingBuffer.subarray(0, sendSize);
                        pendingBuffer = pendingBuffer.subarray(sendSize);

                        this.emit('audio', {
                            data: sendChunk.toString('base64'),
                            sampleRate: 24000,
                            trackId,
                        });
                    }
                }
            }

            // For final chunk, align to 256 bytes for worklet compatibility
            if (pendingBuffer.length >= 256) {
                const alignedLength = Math.floor(pendingBuffer.length / 256) * 256;
                const finalChunk = pendingBuffer.subarray(0, alignedLength);
                this.emit('audio', {
                    data: finalChunk.toString('base64'),
                    sampleRate: 24000,
                    trackId,
                });
            }

            // Add silence padding at end of chunk for natural inter-chunk pause
            // 24kHz * 0.15s = 3600 samples * 2 bytes = 7200 bytes (aligned to 256)
            const silencePadding = Buffer.alloc(7168); // 7168 = 28 * 256, ~149ms of silence
            this.emit('audio', {
                data: silencePadding.toString('base64'),
                sampleRate: 24000,
                trackId,
            });

            // Signal track complete so client can flush audio buffer
            this.emit('track-complete', { trackId });
        } catch (error) {
            console.error('[ElevenLabs] Error generating speech for sentence:', error);
            throw error;
        }
    }

    /**
     * Process speech end - get transcript and send to LLM
     * Uses Deepgram streaming (transcript already available) or Whisper fallback
     */
    async processBufferedAudio(): Promise<void> {
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        this.setState('processing');
        this.resetBatchingState(); // Reset for new response

        try {
            let userText: string;

            if (this.streamingSTT) {
                // Streaming STT - transcript is already available!
                userText = await this.streamingSTT.finalize();
                this.streamingSTT.clearTranscript(); // Ready for next utterance
                console.log(`[ElevenLabs] STT transcript (${this.sttProvider}):`, userText.substring(0, 50));
            } else {
                // Fallback: This path shouldn't be hit if Deepgram is configured
                console.warn('[ElevenLabs] No streaming STT available');
                userText = '';
            }

            if (!userText) {
                this.setState('idle');
                this.isProcessing = false;
                return;
            }

            // Emit user transcript
            this.emit('transcript', {
                type: 'user',
                content: userText,
                isFinal: true,
                timestamp: Date.now(),
            });

            this.conversationHistory.push({
                role: 'user',
                content: userText,
                timestamp: Date.now(),
            });

            // Use streaming or non-streaming based on bridge type
            if (this.streamingBridge) {
                // Streaming mode - sentences will arrive via events
                console.log('[ElevenLabs] Using streaming mode for response');
                await this.streamingBridge.queryStreaming(
                    userText,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8)
                );
            } else {
                // Non-streaming fallback
                console.log('[ElevenLabs] Using non-streaming mode (fallback)');
                await this.processNonStreaming(userText);
            }
        } catch (error) {
            console.error('[ElevenLabs] Error processing audio:', error);
            this.emitError(error as Error);
            this.setState('idle');
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Non-streaming fallback for older CortexBridge
     */
    private async processNonStreaming(userText: string): Promise<void> {
        this.emit('tool-status', {
            name: 'processing',
            status: 'running',
            message: 'Thinking...',
            timestamp: Date.now(),
        });

        const response = await this.cortexBridge.query(
            userText,
            this._config!.entityId,
            this.conversationHistory.slice(-8)
        );

        this.emit('tool-status', {
            name: response.tool || 'response',
            status: 'completed',
            message: 'Done',
            timestamp: Date.now(),
        });

        // Note: transcript display is handled by track-start in textToSpeech

        this.conversationHistory.push({
            role: 'assistant',
            content: response.result,
            timestamp: Date.now(),
        });

        // Emit final transcript for client-side history recording
        this.emit('transcript', {
            type: 'assistant',
            content: response.result,
            isFinal: true,
            timestamp: Date.now(),
        });

        await this.textToSpeech(response.result);
    }

    /**
     * Full text to speech (for non-streaming fallback)
     */
    private async textToSpeech(text: string): Promise<void> {
        this.setState('speaking');

        // Emit track-start for transcript sync
        this.emit('track-start', { trackId: 'full-response', text });

        try {
            const audioStream = await this.elevenlabs.textToSpeech.stream(
                this.voiceId,
                {
                    text,
                    modelId: 'eleven_v3',
                    outputFormat: 'pcm_24000',
                    voiceSettings: {
                        stability: 0.5,
                        similarityBoost: 0.75,
                        style: 0.0,
                        useSpeakerBoost: true,
                    },
                }
            );

            let pendingBuffer = Buffer.alloc(0);
            // Use chunk size that aligns with 128-sample AudioWorklet frames
            const minChunkSize = 5120; // 2560 samples, aligned to worklet frames

            for await (const chunk of audioStream) {
                if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
                    pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(chunk)]);

                    while (pendingBuffer.length >= minChunkSize) {
                        // Ensure alignment to 256 bytes (128 samples * 2 bytes)
                        const sendSize = Math.floor(minChunkSize / 256) * 256;
                        const sendChunk = pendingBuffer.subarray(0, sendSize);
                        pendingBuffer = pendingBuffer.subarray(sendSize);

                        this.emit('audio', {
                            data: sendChunk.toString('base64'),
                            sampleRate: 24000,
                        });
                    }
                }
            }

            // For final chunk, align to 256 bytes for worklet compatibility
            if (pendingBuffer.length >= 256) {
                const alignedLength = Math.floor(pendingBuffer.length / 256) * 256;
                const finalChunk = pendingBuffer.subarray(0, alignedLength);
                this.emit('audio', {
                    data: finalChunk.toString('base64'),
                    sampleRate: 24000,
                });
            }

            // Signal track complete so client can flush audio buffer
            this.emit('track-complete', { trackId: 'default' });
        } catch (error) {
            console.error('[ElevenLabs] Error generating speech:', error);
            throw error;
        } finally {
            this.setState('idle');
        }
    }

    async sendText(text: string): Promise<void> {
        if (!this._isConnected) {
            throw new Error('Not connected');
        }

        this.isProcessing = true;
        this.resetBatchingState();

        try {
            this.emit('transcript', {
                type: 'user',
                content: text,
                isFinal: true,
                timestamp: Date.now(),
            });

            this.conversationHistory.push({
                role: 'user',
                content: text,
                timestamp: Date.now(),
            });

            this.setState('processing');

            if (this.streamingBridge) {
                await this.streamingBridge.queryStreaming(
                    text,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8)
                );
            } else {
                await this.processNonStreaming(text);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    interrupt(): void {
        console.log('[ElevenLabs] Interrupt requested');

        // Cancel streaming if active
        if (this.streamingBridge) {
            this.streamingBridge.cancel();
        }

        // Clear all queues and batching state
        this.resetBatchingState();
        this.isSpeaking = false;
        this.isProcessing = false;

        // Clear STT transcript so new speech starts fresh
        if (this.streamingSTT) {
            this.streamingSTT.clearTranscript();
            // Ensure STT is connected for new input
            if (!this.streamingSTT.connected) {
                console.log('[ElevenLabs] Reconnecting STT after interrupt');
                this.streamingSTT.start().catch(err => {
                    console.error('[ElevenLabs] Failed to reconnect STT:', err);
                });
            }
        }

        this.setState('idle');
    }
}
