/**
 * StreamingTTSProvider - Abstract base class for streaming TTS providers
 *
 * Extracts shared streaming TTS logic (STT management, progressive batching,
 * track management, conversation history, streaming bridge setup) so that
 * ElevenLabs, Deepgram, and future TTS providers only implement the
 * provider-specific synthesis call.
 *
 * Subclasses implement:
 *   synthesizeSpeech(text, trackId) - call TTS API and emit 'audio' events
 *   configureVoice(config)          - apply voice settings from VoiceConfig
 *   disconnectTTS()                 - tear down any TTS-specific resources
 */

import { BaseVoiceProvider } from './BaseProvider.js';
import {
    VoiceConfig,
    AudioData,
    ConversationMessage,
    ICortexBridge,
    ToolStatusEvent,
    MediaEvent,
} from '../types.js';
import { StreamingCortexBridge } from '../cortex/StreamingCortexBridge.js';
import { StreamingSTT, createStreamingSTT, STTProvider } from '../stt/index.js';

export abstract class StreamingTTSProvider extends BaseVoiceProvider {
    protected conversationHistory: ConversationMessage[] = [];
    protected isProcessing: boolean = false;

    // Streaming STT
    private streamingSTT: StreamingSTT | null = null;
    protected sttProvider: STTProvider;
    protected deepgramApiKey: string | null;

    // Streaming bridge
    protected streamingBridge: StreamingCortexBridge | null = null;
    private sentenceQueue: string[] = [];
    private isSpeaking: boolean = false;
    private currentTrackId: number = 0;

    // Progressive batching
    private isFirstChunk: boolean = true;
    private pendingBatch: string[] = [];
    private readonly SENTENCE_PAUSE_MS = 400;

    // Track playback completion
    private pendingTrackCompletions: Map<string, () => void> = new Map();

    // Interim transcript gating
    private isFinalizingTranscript: boolean = false;

    // STT reconnection backoff
    private sttReconnectAttempts: number = 0;
    private static readonly MAX_STT_RECONNECT_ATTEMPTS = 3;

    /** API key used by subclass for STT init (e.g. ElevenLabs key) */
    protected abstract readonly sttApiKeyName: string;

    constructor(
        cortexBridge: ICortexBridge,
        deepgramApiKey: string | null,
        sttProvider: STTProvider,
    ) {
        super(cortexBridge);
        this.deepgramApiKey = deepgramApiKey;
        this.sttProvider = sttProvider;

        if (cortexBridge instanceof StreamingCortexBridge) {
            this.streamingBridge = cortexBridge;
            this.setupStreamingListeners();
        }
    }

    // ── Abstract methods for subclasses ────────────────────────────

    /**
     * Synthesize speech for the given text.
     * Called inside textToSpeechChunk() which handles track-start/track-complete.
     * The subclass should call the TTS API and emit 'audio' events as chunks arrive.
     */
    protected abstract synthesizeSpeech(text: string, trackId: string): Promise<void>;

    /** Apply voice settings from VoiceConfig (voiceId, voiceSettings, etc.) */
    protected abstract configureVoice(config: VoiceConfig): void;

    /** Tear down any TTS-specific resources (no-op for REST-based providers) */
    protected abstract disconnectTTS(): Promise<void>;

    /**
     * Return the STT API key for the configured sttProvider.
     * ElevenLabs returns its own key; Deepgram returns deepgramApiKey.
     */
    protected abstract getSTTApiKey(): string | undefined;

    // ── Streaming bridge listeners (shared) ───────────────────────

    private setupStreamingListeners(): void {
        if (!this.streamingBridge) return;

        this.streamingBridge.on('sentence', (sentence: string) => {
            console.log(`[${this.type}] Received sentence:`, sentence.substring(0, 50) + '...');
            this.queueSentence(sentence);
        });

        this.streamingBridge.on('filler', (text: string) => {
            console.log(`[${this.type}] Received filler:`, text);
            this.queueFiller(text);
        });

        this.streamingBridge.on('tool-status', (event: ToolStatusEvent) => {
            this.emit('tool-status', { ...event, timestamp: Date.now() });
        });

        this.streamingBridge.on('thinking', (isThinking: boolean) => {
            if (isThinking && this._state === 'processing') {
                this.emit('tool-status', {
                    name: 'thinking',
                    status: 'running',
                    message: 'Thinking...',
                    timestamp: Date.now(),
                });
            }
        });

        this.streamingBridge.on('complete', (fullText: string) => {
            console.log(`[${this.type}] Stream complete, full response length:`, fullText.length);
            this.flushBatch();

            if (fullText && fullText.trim().length > 0) {
                this.conversationHistory.push({
                    role: 'assistant',
                    content: fullText,
                    timestamp: Date.now(),
                });
                this.capHistory();

                this.emit('transcript', {
                    type: 'assistant',
                    content: fullText,
                    isFinal: true,
                    timestamp: Date.now(),
                });
            } else {
                console.warn(`[${this.type}] Stream completed with empty response`);
            }

            if (this.sentenceQueue.length === 0 && this.pendingBatch.length === 0 && !this.isSpeaking) {
                this.isProcessing = false;
                this.setState('idle');
            }
        });

        this.streamingBridge.on('error', (error: Error) => {
            console.error(`[${this.type}] Stream error:`, error);
            this.emitError(error);
            this.isProcessing = false;
            this.setState('idle');
        });

        this.streamingBridge.on('media', (event: MediaEvent) => {
            console.log(`[${this.type}] Media event:`, event.type, event.items?.length || 0, 'items');
            this.emit('media', event);
        });
    }

    // ── connect / disconnect (shared) ─────────────────────────────

    async connect(config: VoiceConfig): Promise<void> {
        this._config = config;

        // Let subclass apply voice config
        this.configureVoice(config);

        // Initialize streaming STT
        this.streamingSTT = createStreamingSTT({
            provider: this.sttProvider,
            elevenlabsApiKey: this.sttProvider === 'elevenlabs' ? this.getSTTApiKey() : undefined,
            deepgramApiKey: this.sttProvider === 'deepgram' ? (this.deepgramApiKey || undefined) : undefined,
            sampleRate: 16000,
            language: 'en',
            apiKey: '',
        });

        if (this.streamingSTT) {
            this.streamingSTT.on('transcript', (data) => {
                if (!data.isFinal && !this.isFinalizingTranscript) {
                    this.emit('transcript', {
                        type: 'user',
                        content: data.text,
                        isFinal: false,
                        timestamp: Date.now(),
                    });
                }
            });
            this.streamingSTT.on('error', (err) => {
                console.error(`[${this.type}] STT error:`, err.message);
            });
            await this.streamingSTT.start();
            console.log(`[${this.type}] Streaming STT initialized (${this.sttProvider})`);
        } else {
            console.log(`[${this.type}] No streaming STT - falling back to batch Whisper`);
        }

        this.setConnected(true);
        this.setState('idle');
    }

    async disconnect(): Promise<void> {
        if (this.streamingBridge) {
            this.streamingBridge.cancel();
        }

        if (this.streamingSTT) {
            await this.streamingSTT.stop();
            this.streamingSTT = null;
        }

        this.resetBatchingState();
        await this.disconnectTTS();

        this.setConnected(false);
        this.setState('idle');
        this.conversationHistory = [];
        this.isSpeaking = false;
    }

    // ── sendAudio (shared STT forwarding) ─────────────────────────

    sendAudio(data: AudioData): void {
        if (!this._isConnected || this._isMuted || this.isProcessing) {
            return;
        }

        const buffer = Buffer.from(data.data, 'base64');

        if (this.streamingSTT) {
            if (!this.streamingSTT.connected) {
                if (this.streamingSTT.fatal) {
                    // Auth or quota error — retrying won't help
                    return;
                }
                if (this.sttReconnectAttempts >= StreamingTTSProvider.MAX_STT_RECONNECT_ATTEMPTS) {
                    if (this.sttReconnectAttempts === StreamingTTSProvider.MAX_STT_RECONNECT_ATTEMPTS) {
                        console.error(`[${this.type}] Max STT reconnection attempts reached`);
                        this.sttReconnectAttempts++; // Increment past max to suppress further logs
                    }
                    return;
                }
                this.sttReconnectAttempts++;
                console.log(`[${this.type}] STT disconnected, reconnecting... (attempt ${this.sttReconnectAttempts})`);
                this.streamingSTT.start().then(() => {
                    this.sttReconnectAttempts = 0;
                }).catch(err => {
                    console.error(`[${this.type}] Failed to reconnect STT:`, err);
                });
            }
            this.streamingSTT.sendAudio(buffer);
        }

        if (this._state === 'idle') {
            this.setState('listening');
        }
    }

    // ── Progressive batching (shared) ─────────────────────────────

    private queueSentence(sentence: string): void {
        if (this.isFirstChunk) {
            console.log(`[${this.type}] First chunk - sending immediately for low latency`);
            this.isFirstChunk = false;
            this.sentenceQueue.push(sentence);
            this.processNextBatch();
        } else {
            this.pendingBatch.push(sentence);
            console.log(`[${this.type}] Buffering sentence (${this.pendingBatch.length} pending)`);
            if (!this.isSpeaking) {
                this.flushBatch();
            }
        }
    }

    private async queueFiller(text: string): Promise<void> {
        if (this.isSpeaking || this.sentenceQueue.length > 0 || this.pendingBatch.length > 0) {
            console.log(`[${this.type}] Skipping filler - already speaking or content queued`);
            return;
        }

        this.isSpeaking = true;
        this.currentTrackId++;
        const trackId = `filler-${this.currentTrackId}`;

        try {
            this.setState('speaking');
            await this.textToSpeechChunk(text, trackId, true);
        } catch (error) {
            console.error(`[${this.type}] Error speaking filler:`, error);
        } finally {
            this.isSpeaking = false;
            if (this.pendingBatch.length > 0) {
                this.flushBatch();
            } else if (this.sentenceQueue.length > 0) {
                this.processNextBatch();
            } else if (!this.isProcessing) {
                this.setState('idle');
            }
        }
    }

    private flushBatch(): void {
        if (this.pendingBatch.length > 0) {
            const batchedText = this.pendingBatch.join(' ');
            console.log(`[${this.type}] Flushing ${this.pendingBatch.length} sentences as one chunk`);
            this.pendingBatch = [];
            this.sentenceQueue.push(batchedText);
            this.processNextBatch();
        }
    }

    private async processNextBatch(): Promise<void> {
        if (this.isSpeaking || this.sentenceQueue.length === 0) {
            return;
        }

        this.isSpeaking = true;
        const text = this.sentenceQueue.shift()!;
        this.currentTrackId++;
        const trackId = `chunk-${this.currentTrackId}`;

        try {
            this.setState('speaking');
            await this.textToSpeechChunk(text, trackId);
            await this.waitForTrackPlayback(trackId);
            await this.delay(this.SENTENCE_PAUSE_MS);
        } catch (error) {
            console.error(`[${this.type}] Error speaking chunk:`, error);
        } finally {
            this.isSpeaking = false;
            if (this.pendingBatch.length > 0) {
                this.flushBatch();
            } else if (this.sentenceQueue.length > 0) {
                this.processNextBatch();
            } else if (!this.isProcessing) {
                this.setState('idle');
            }
        }
    }

    // ── Track playback sync (shared) ──────────────────────────────

    private waitForTrackPlayback(trackId: string): Promise<void> {
        return new Promise((resolve) => {
            this.pendingTrackCompletions.set(trackId, resolve);
            setTimeout(() => {
                if (this.pendingTrackCompletions.has(trackId)) {
                    console.log(`[${this.type}] Track ${trackId} playback timeout, proceeding`);
                    this.pendingTrackCompletions.delete(trackId);
                    resolve();
                }
            }, 10000);
        });
    }

    onTrackPlaybackComplete(trackId: string): void {
        console.log(`[${this.type}] Track playback complete: ${trackId}`);
        const resolve = this.pendingTrackCompletions.get(trackId);
        if (resolve) {
            this.pendingTrackCompletions.delete(trackId);
            resolve();
        }
    }

    // ── Helpers (shared) ──────────────────────────────────────────

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private resetBatchingState(): void {
        this.sentenceQueue = [];
        this.pendingBatch = [];
        this.isFirstChunk = true;
        this.isFinalizingTranscript = false;

        for (const [, resolve] of this.pendingTrackCompletions) {
            resolve();
        }
        this.pendingTrackCompletions.clear();
    }

    private capHistory(): void {
        if (this.conversationHistory.length > 100) {
            this.conversationHistory = this.conversationHistory.slice(-100);
        }
    }

    // ── TTS chunk wrapper (calls subclass synthesizeSpeech) ───────

    private async textToSpeechChunk(text: string, trackId: string, skipTranscript: boolean = false): Promise<void> {
        try {
            if (!skipTranscript) {
                this.emit('track-start', { trackId, text });
            }
            await this.synthesizeSpeech(text, trackId);
            this.emit('track-complete', { trackId });
        } catch (error) {
            console.error(`[${this.type}] Error generating speech for sentence:`, error);
            throw error;
        }
    }

    // ── processBufferedAudio (shared) ─────────────────────────────

    async processBufferedAudio(): Promise<void> {
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        this.setState('processing');
        this.resetBatchingState();

        try {
            let userText: string;

            if (this.streamingSTT) {
                this.isFinalizingTranscript = true;
                userText = await this.streamingSTT.finalize();
                this.streamingSTT.clearTranscript();
                console.log(`[${this.type}] STT transcript (${this.sttProvider}):`, userText.substring(0, 50));
            } else {
                console.warn(`[${this.type}] No streaming STT available`);
                userText = '';
            }

            if (!userText) {
                this.setState('idle');
                this.isProcessing = false;
                return;
            }

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
            this.capHistory();

            if (this.streamingBridge) {
                console.log(`[${this.type}] Using streaming mode for response`);
                await this.streamingBridge.queryStreaming(
                    userText,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8),
                );
            } else {
                console.log(`[${this.type}] Using non-streaming mode (fallback)`);
                await this.processNonStreaming(userText);
            }
        } catch (error) {
            console.error(`[${this.type}] Error processing audio:`, error);
            this.emitError(error as Error);
            this.setState('idle');
        } finally {
            this.isProcessing = false;
        }
    }

    // ── Non-streaming fallback (shared) ───────────────────────────

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
            this.conversationHistory.slice(-8),
        );

        this.emit('tool-status', {
            name: response.tool || 'response',
            status: 'completed',
            message: 'Done',
            timestamp: Date.now(),
        });

        this.conversationHistory.push({
            role: 'assistant',
            content: response.result,
            timestamp: Date.now(),
        });
        this.capHistory();

        this.emit('transcript', {
            type: 'assistant',
            content: response.result,
            isFinal: true,
            timestamp: Date.now(),
        });

        // Full text TTS (non-streaming)
        this.setState('speaking');
        this.emit('track-start', { trackId: 'full-response', text: response.result });
        try {
            await this.synthesizeSpeech(response.result, 'full-response');
            this.emit('track-complete', { trackId: 'default' });
        } finally {
            this.setState('idle');
        }
    }

    // ── sendText / interrupt (shared) ─────────────────────────────

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
            this.capHistory();

            this.setState('processing');

            if (this.streamingBridge) {
                await this.streamingBridge.queryStreaming(
                    text,
                    this._config!.entityId,
                    this.conversationHistory.slice(-8),
                );
            } else {
                await this.processNonStreaming(text);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    interrupt(): void {
        console.log(`[${this.type}] Interrupt requested`);

        if (this.streamingBridge) {
            this.streamingBridge.cancel();
        }

        this.resetBatchingState();
        this.isSpeaking = false;
        this.isProcessing = false;

        if (this.streamingSTT) {
            this.streamingSTT.clearTranscript();
            if (!this.streamingSTT.connected && !this.streamingSTT.fatal) {
                this.sttReconnectAttempts = 0;
                console.log(`[${this.type}] Reconnecting STT after interrupt`);
                this.streamingSTT.start().catch(err => {
                    console.error(`[${this.type}] Failed to reconnect STT:`, err);
                });
            }
        }

        this.setState('idle');
    }
}
