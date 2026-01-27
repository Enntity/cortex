/**
 * Socket.io Server
 *
 * Handles WebSocket connections from clients, manages voice sessions,
 * and coordinates with voice providers.
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import {
    IVoiceProvider,
    VoiceConfig,
    SessionState,
    ServerConfig,
    AudioData,
    TranscriptEvent,
    ToolStatusEvent,
    MediaEvent,
    TrackStartEvent,
    TrackCompleteEvent,
    VoiceState,
} from './types.js';
import { createVoiceProvider, getAvailableProviders } from './providers/index.js';
import { CortexBridge } from './cortex/CortexBridge.js';
import { StreamingCortexBridge } from './cortex/StreamingCortexBridge.js';

interface SessionData {
    state: SessionState;
    provider: IVoiceProvider;
    cortexBridge: CortexBridge | StreamingCortexBridge;
    idleTimeout: NodeJS.Timeout | null;
    idleCount: number;
    audioBlockTimeout: NodeJS.Timeout | null;
}

export class SocketServer {
    private io: SocketIOServer;
    private sessions: Map<string, SessionData> = new Map();
    private config: ServerConfig;

    constructor(httpServer: HTTPServer, config: ServerConfig) {
        this.config = config;

        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: config.corsOrigins,
                methods: ['GET', 'POST'],
                credentials: true,
            },
            pingTimeout: 60000,
            pingInterval: 25000,
        });

        this.setupEventHandlers();
    }

    private setupEventHandlers(): void {
        this.io.on('connection', (socket: Socket) => {
            console.log(`[SocketServer] Client connected: ${socket.id}`);

            // Start session
            socket.on('session:start', async (config: VoiceConfig) => {
                await this.handleSessionStart(socket, config);
            });

            // End session
            socket.on('session:end', () => {
                this.handleSessionEnd(socket);
            });

            // Receive audio from client
            socket.on('audio:input', (data: AudioData) => {
                this.handleAudioInput(socket, data);
            });

            // Send text message
            socket.on('text:input', async (text: string) => {
                await this.handleTextInput(socket, text);
            });

            // Toggle mute
            socket.on('audio:mute', (muted: boolean) => {
                this.handleMute(socket, muted);
            });

            // Interrupt response (manual)
            socket.on('audio:interrupt', () => {
                this.handleInterrupt(socket);
            });

            // Client-side VAD speech start - auto-interrupt if AI is speaking
            socket.on('audio:speechStart', () => {
                this.handleSpeechStart(socket);
            });

            // Client-side VAD speech end (for TTS providers)
            socket.on('audio:speechEnd', async () => {
                await this.handleSpeechEnd(socket);
            });

            // Client audio playback state - used to skip fillers when audio is playing
            socket.on('audio:clientPlaying', () => {
                this.handleClientAudioState(socket, true);
            });

            socket.on('audio:clientStopped', () => {
                this.handleClientAudioState(socket, false);
            });

            // Client finished playing a track - for chunk pacing
            socket.on('audio:trackPlaybackComplete', (data: { trackId: string }) => {
                this.handleTrackPlaybackComplete(socket, data.trackId);
            });

            // Get available providers
            socket.on('providers:list', () => {
                const providers = getAvailableProviders(this.config);
                socket.emit('providers:available', providers);
            });

            // Handle disconnection
            socket.on('disconnect', (reason) => {
                console.log(`[SocketServer] Client disconnected: ${socket.id}, reason: ${reason}`);
                this.handleSessionEnd(socket);
            });
        });
    }

    private async handleSessionStart(socket: Socket, config: VoiceConfig): Promise<void> {
        const sessionId = socket.id;

        // Check if session already exists
        if (this.sessions.has(sessionId)) {
            socket.emit('session:error', { message: 'Session already active' });
            return;
        }

        // Use default provider if not specified
        const providerType = config.provider || this.config.defaultProvider;

        // Validate provider availability
        const availableProviders = getAvailableProviders(this.config);
        if (!availableProviders.includes(providerType)) {
            socket.emit('session:error', {
                message: `Provider ${providerType} is not available`,
                availableProviders,
            });
            return;
        }

        try {
            // Create Cortex bridge for this session
            // Use streaming bridge for TTS providers (ElevenLabs, OpenAI TTS)
            // Use regular bridge for OpenAI Realtime (which has native streaming)
            const useStreaming = providerType === 'elevenlabs' || providerType === 'openai-tts';
            const cortexBridge = useStreaming
                ? new StreamingCortexBridge(this.config.cortexApiUrl)
                : new CortexBridge(this.config.cortexApiUrl);

            // Set session context for proper sys_entity_agent calls
            cortexBridge.setSessionContext(config);

            // Get voice sample for entity if available (only CortexBridge has this method)
            let voiceSample: string | null = null;
            if (!useStreaming) {
                voiceSample = await (cortexBridge as CortexBridge).getVoiceSample(config.entityId);
            }

            // Create voice provider
            const provider = createVoiceProvider(providerType, cortexBridge, this.config);

            // Create session state
            const sessionState: SessionState = {
                id: sessionId,
                entityId: config.entityId,
                chatId: config.chatId,
                provider: providerType,
                state: 'idle',
                isConnected: false,
                isMuted: false,
                conversationHistory: [],
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
            };

            // Create session data
            const sessionData: SessionData = {
                state: sessionState,
                provider,
                cortexBridge,
                idleTimeout: null,
                idleCount: 0,
                audioBlockTimeout: null,
            };

            // Setup provider event handlers
            this.setupProviderEvents(socket, sessionData);

            // Connect provider
            await provider.connect({
                ...config,
                voiceSample: voiceSample || undefined,
            });

            // Store session
            this.sessions.set(sessionId, sessionData);

            // Emit success
            socket.emit('session:started', {
                sessionId,
                provider: providerType,
                entityId: config.entityId,
            });

            console.log(`[SocketServer] Session started: ${sessionId}, provider: ${providerType}, entity: ${config.entityId}`);

            // Start idle monitoring
            this.resetIdleTimeout(sessionData, socket);
        } catch (error) {
            console.error(`[SocketServer] Failed to start session:`, error);
            socket.emit('session:error', {
                message: (error as Error).message,
            });
        }
    }

    private setupProviderEvents(socket: Socket, sessionData: SessionData): void {
        const { provider, state } = sessionData;

        // State changes
        provider.on('state-change', (newState: VoiceState) => {
            state.state = newState;
            state.lastActivityAt = Date.now();
            socket.emit('state:change', newState);

            // Reset idle on activity
            if (newState !== 'idle') {
                this.resetIdleTimeout(sessionData, socket);
            }
        });

        // Transcripts
        provider.on('transcript', (event: TranscriptEvent) => {
            socket.emit('transcript', event);

            if (event.isFinal) {
                state.conversationHistory.push({
                    role: event.type,
                    content: event.content,
                    timestamp: event.timestamp,
                });
            }
        });

        // Audio output
        provider.on('audio', (data: AudioData) => {
            socket.emit('audio:output', data);
            this.resetAudioBlockTimeout(sessionData, socket);
        });

        // Track start (send text for transcript sync)
        provider.on('track-start', (event: TrackStartEvent) => {
            socket.emit('audio:trackStart', event);
        });

        // Track complete (signal client to flush audio buffer)
        provider.on('track-complete', (event: TrackCompleteEvent) => {
            socket.emit('audio:trackComplete', event);
        });

        // Tool status
        provider.on('tool-status', (event: ToolStatusEvent) => {
            socket.emit('tool:status', event);
        });

        // Media events
        provider.on('media', (event: MediaEvent) => {
            socket.emit('media', event);
        });

        // Errors
        provider.on('error', (error: Error) => {
            socket.emit('session:error', { message: error.message });
        });

        // Connection state
        provider.on('connected', () => {
            state.isConnected = true;
            socket.emit('provider:connected');
        });

        provider.on('disconnected', () => {
            state.isConnected = false;
            socket.emit('provider:disconnected');
        });
    }

    private handleSessionEnd(socket: Socket): void {
        const sessionId = socket.id;
        const sessionData = this.sessions.get(sessionId);

        if (sessionData) {
            // Clear timeouts
            if (sessionData.idleTimeout) {
                clearTimeout(sessionData.idleTimeout);
            }
            if (sessionData.audioBlockTimeout) {
                clearTimeout(sessionData.audioBlockTimeout);
            }

            // Disconnect provider
            sessionData.provider.disconnect().catch(err => {
                console.error(`[SocketServer] Error disconnecting provider:`, err);
            });

            // Remove session
            this.sessions.delete(sessionId);

            socket.emit('session:ended', {
                sessionId,
                history: sessionData.state.conversationHistory,
            });

            console.log(`[SocketServer] Session ended: ${sessionId}`);
        }
    }

    private handleAudioInput(socket: Socket, data: AudioData): void {
        const sessionData = this.sessions.get(socket.id);

        if (!sessionData) {
            return;
        }

        // Validate audio data to prevent crashes from malformed input
        if (!data || typeof data.data !== 'string') {
            return;
        }

        sessionData.state.lastActivityAt = Date.now();
        sessionData.provider.sendAudio(data);

        // Reset idle and audio block timeouts
        this.resetIdleTimeout(sessionData, socket);
        this.resetAudioBlockTimeout(sessionData, socket);
    }

    private async handleTextInput(socket: Socket, text: string): Promise<void> {
        const sessionData = this.sessions.get(socket.id);

        if (!sessionData) {
            socket.emit('session:error', { message: 'No active session' });
            return;
        }

        try {
            sessionData.state.lastActivityAt = Date.now();
            await sessionData.provider.sendText(text);
            this.resetIdleTimeout(sessionData, socket);
        } catch (error) {
            socket.emit('session:error', { message: (error as Error).message });
        }
    }

    private handleMute(socket: Socket, muted: boolean): void {
        const sessionData = this.sessions.get(socket.id);

        if (sessionData) {
            sessionData.state.isMuted = muted;
            sessionData.provider.setMuted(muted);
            socket.emit('audio:muted', muted);
        }
    }

    private handleInterrupt(socket: Socket): void {
        const sessionData = this.sessions.get(socket.id);

        if (sessionData) {
            console.log('[SocketServer] Manual interrupt requested');
            sessionData.provider.interrupt();
            // Tell client to stop playing audio
            socket.emit('audio:stop');
        }
    }

    private handleSpeechStart(socket: Socket): void {
        const sessionData = this.sessions.get(socket.id);

        if (!sessionData) {
            return;
        }

        // If AI is currently speaking or processing, interrupt it
        const state = sessionData.provider.state;
        if (state === 'speaking' || state === 'processing') {
            console.log('[SocketServer] User started speaking - interrupting AI');
            sessionData.provider.interrupt();
            // Tell client to stop playing audio immediately
            socket.emit('audio:stop');
        }
    }

    private async handleSpeechEnd(socket: Socket): Promise<void> {
        const sessionData = this.sessions.get(socket.id);

        if (!sessionData) {
            return;
        }

        // For TTS providers, trigger processing of buffered audio
        const provider = sessionData.provider as any;
        if (typeof provider.processBufferedAudio === 'function') {
            await provider.processBufferedAudio();
        }
    }

    private handleClientAudioState(socket: Socket, isPlaying: boolean): void {
        const sessionData = this.sessions.get(socket.id);

        if (!sessionData) {
            return;
        }

        // Tell the cortex bridge about client audio state so it can skip fillers
        if (sessionData.cortexBridge && 'setClientAudioPlaying' in sessionData.cortexBridge) {
            (sessionData.cortexBridge as any).setClientAudioPlaying(isPlaying);
        }
    }

    private handleTrackPlaybackComplete(socket: Socket, trackId: string): void {
        const sessionData = this.sessions.get(socket.id);

        if (!sessionData) {
            return;
        }

        // Notify the provider that client finished playing this track
        const provider = sessionData.provider as any;
        if (typeof provider.onTrackPlaybackComplete === 'function') {
            provider.onTrackPlaybackComplete(trackId);
        }
    }

    private resetIdleTimeout(sessionData: SessionData, socket: Socket): void {
        if (sessionData.idleTimeout) {
            clearTimeout(sessionData.idleTimeout);
        }

        // Calculate timeout with exponential backoff
        const timeout = Math.min(
            this.config.idleTimeoutBaseMs * Math.pow(2, sessionData.idleCount),
            this.config.idleTimeoutMaxMs
        );

        sessionData.idleTimeout = setTimeout(() => {
            this.handleIdleTimeout(sessionData, socket);
        }, timeout);
    }

    private handleIdleTimeout(sessionData: SessionData, socket: Socket): void {
        sessionData.idleCount++;

        // Emit idle event
        socket.emit('session:idle', {
            count: sessionData.idleCount,
            timeout: Math.min(
                this.config.idleTimeoutBaseMs * Math.pow(2, sessionData.idleCount),
                this.config.idleTimeoutMaxMs
            ),
        });

        // Continue monitoring
        this.resetIdleTimeout(sessionData, socket);
    }

    private resetAudioBlockTimeout(sessionData: SessionData, socket: Socket): void {
        if (sessionData.audioBlockTimeout) {
            clearTimeout(sessionData.audioBlockTimeout);
        }

        sessionData.audioBlockTimeout = setTimeout(() => {
            socket.emit('session:warning', {
                type: 'audio_block_timeout',
                message: 'Audio block timeout - no audio activity',
            });
        }, this.config.audioBlockTimeoutMs);
    }

    /**
     * Get active session count
     */
    getSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Get all active sessions
     */
    getSessions(): SessionState[] {
        return Array.from(this.sessions.values()).map(s => s.state);
    }
}
