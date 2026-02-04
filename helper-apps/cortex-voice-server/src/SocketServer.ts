/**
 * Socket.io Server
 *
 * Handles WebSocket connections from clients, manages voice sessions,
 * and coordinates with voice providers.
 */

import { createHmac, timingSafeEqual } from 'crypto';
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
import { createVoiceProvider, getAvailableProviders, resolveVoiceProvider, VOICE_PROVIDER_INSTRUCTIONS } from './providers/index.js';
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

const MAX_SESSIONS = 100;
const MAX_SESSIONS_PER_IP = 5;
const MAX_AUDIO_MESSAGE_SIZE = 100 * 1024; // 100KB base64
const MAX_TEXT_LENGTH = 10000;

export class SocketServer {
    private io: SocketIOServer;
    private sessions: Map<string, SessionData> = new Map();
    private config: ServerConfig;
    // Tracks active+pending sessions by userId:entityId → socketId for dedup.
    // Updated synchronously BEFORE any async work to prevent concurrent session races.
    private activeSessions: Map<string, string> = new Map();

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
            maxHttpBufferSize: 200 * 1024, // 200KB
        });

        // Authentication middleware
        this.io.use((socket, next) => {
            const token = socket.handshake.auth?.token;
            if (!token || typeof token !== 'string') {
                return next(new Error('Authentication required'));
            }
            
            if (!config.authSecret) {
                console.warn('[SocketServer] AUTH_SECRET not configured - rejecting connection');
                return next(new Error('Server authentication not configured'));
            }
            
            try {
                // Verify token format: base64(JSON payload).HMAC signature
                const parts = token.split('.');
                if (parts.length !== 2) {
                    return next(new Error('Invalid token format'));
                }
                
                const [payloadB64, signature] = parts;
                const expectedSig = createHmac('sha256', config.authSecret)
                    .update(payloadB64)
                    .digest('hex');
                
                const sigBuf = Buffer.from(signature, 'hex');
                const expectedBuf = Buffer.from(expectedSig, 'hex');
                if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
                    return next(new Error('Invalid token'));
                }
                
                const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
                
                // Check expiration
                if (payload.exp && Date.now() > payload.exp) {
                    return next(new Error('Token expired'));
                }
                
                // Store authenticated user info on socket
                socket.data.userId = payload.userId;
                socket.data.contextId = payload.contextId;
                socket.data.contextKey = payload.contextKey;
                
                next();
            } catch (err) {
                return next(new Error('Invalid token'));
            }
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
                this.handleSessionEndForSocket(socket);
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
                this.handleSessionEndForSocket(socket);
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

        // Check global session limit
        if (this.sessions.size >= MAX_SESSIONS) {
            socket.emit('session:error', { message: 'Server at maximum capacity' });
            return;
        }

        // Check per-IP session limit
        const clientIP = socket.handshake.address;
        const allSockets = await this.io.fetchSockets();
        const ipSessionCount = allSockets.filter(s => s.handshake.address === clientIP && this.sessions.has(s.id)).length;
        if (ipSessionCount >= MAX_SESSIONS_PER_IP) {
            socket.emit('session:error', { message: 'Too many sessions from this address' });
            return;
        }

        // Override identity from authenticated session - never trust client
        config.userId = socket.data.userId;
        config.contextId = socket.data.contextId;
        config.contextKey = socket.data.contextKey;

        // De-duplicate: if this user already has a session for this entity, close the old one.
        // Uses activeSessions map (set synchronously) to catch concurrent handleSessionStart calls
        // from React StrictMode double-mounts and tab refreshes.
        const dedupKey = `${config.userId}:${config.entityId}`;
        const existingSocketId = this.activeSessions.get(dedupKey);
        if (existingSocketId && existingSocketId !== sessionId) {
            console.log(`[SocketServer] Closing duplicate session ${existingSocketId} for ${dedupKey}`);
            this.handleSessionEnd(existingSocketId);
            const existingSocket = this.io.sockets.sockets.get(existingSocketId);
            if (existingSocket) {
                existingSocket.disconnect(true);
            }
        }
        // Register this session synchronously BEFORE any async work
        this.activeSessions.set(dedupKey, sessionId);

        // Validate required fields
        if (!config.entityId || typeof config.entityId !== 'string') {
            socket.emit('error', { message: 'Invalid entityId' });
            return;
        }
        if (config.entityId.length > 100) {
            socket.emit('error', { message: 'entityId too long' });
            return;
        }
        if (config.userInfo && typeof config.userInfo === 'string' && config.userInfo.length > 5000) {
            socket.emit('error', { message: 'userInfo too long' });
            return;
        }

        // Resolve provider from voice preferences array (falls back to flat provider or server default)
        let resolved;
        if (config.voicePreferences && config.voicePreferences.length > 0) {
            resolved = resolveVoiceProvider(config.voicePreferences, this.config);
        } else {
            // Legacy: flat provider/voiceId from client
            resolved = {
                type: config.provider || this.config.defaultProvider,
                voiceId: config.voiceId,
                voiceSettings: config.voiceSettings,
            };
        }

        const providerType = resolved.type;

        // Validate provider availability
        const availableProviders = getAvailableProviders(this.config);
        if (!availableProviders.includes(providerType)) {
            socket.emit('session:error', {
                message: `Provider ${providerType} is not available`,
                availableProviders,
            });
            return;
        }

        // Apply resolved voice to config
        if (resolved.voiceId) {
            config.voiceId = resolved.voiceId;
        }
        if (resolved.voiceSettings) {
            config.voiceSettings = resolved.voiceSettings;
        }

        // Inject provider-specific voice instructions for the LLM
        config.voiceProviderInstructions = VOICE_PROVIDER_INSTRUCTIONS[providerType] || '';

        try {
            // Create Cortex bridge for this session
            // Use streaming bridge for TTS providers (ElevenLabs, OpenAI TTS)
            // Use regular bridge for OpenAI Realtime (which has native streaming)
            const useStreaming = providerType === 'elevenlabs' || providerType === 'openai-tts' || providerType === 'deepgram' || providerType === 'inworld';
            const cortexBridge = useStreaming
                ? new StreamingCortexBridge(this.config.cortexApiUrl)
                : new CortexBridge(this.config.cortexApiUrl);

            // Set session context for proper sys_entity_agent calls
            cortexBridge.setSessionContext(config);

            // Get voice sample URL for non-realtime providers that need it for TTS voice cloning
            // OpenAI Realtime fetches its own voice sample text during connect()
            let voiceSample: string | null = null;
            if (!useStreaming && providerType !== 'openai-realtime') {
                voiceSample = await (cortexBridge as CortexBridge).getVoiceSample(config.entityId);
            }

            // Create voice provider (with fallback through preferences on failure)
            let provider;
            try {
                provider = createVoiceProvider(providerType, cortexBridge, this.config);
            } catch (primaryError) {
                // If we have preferences, try the next available one
                if (config.voicePreferences && config.voicePreferences.length > 1) {
                    const remaining = config.voicePreferences.filter(p => p.provider !== providerType);
                    const fallback = resolveVoiceProvider(remaining, this.config);
                    if (fallback.type !== providerType) {
                        console.warn(`[SocketServer] Primary provider ${providerType} failed, falling back to ${fallback.type}`);
                        provider = createVoiceProvider(fallback.type, cortexBridge, this.config);
                        if (fallback.voiceId) config.voiceId = fallback.voiceId;
                        if (fallback.voiceSettings) config.voiceSettings = fallback.voiceSettings;
                        // Update voice instructions for the fallback provider
                        config.voiceProviderInstructions = VOICE_PROVIDER_INSTRUCTIONS[fallback.type] || '';
                        cortexBridge.setSessionContext(config);
                    } else {
                        throw primaryError;
                    }
                } else {
                    throw primaryError;
                }
            }

            const actualProviderType = provider.type;

            // Create session state
            const sessionState: SessionState = {
                id: sessionId,
                entityId: config.entityId,
                chatId: config.chatId,
                provider: actualProviderType,
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
                provider: actualProviderType,
                voiceSample: voiceSample || undefined,
            });

            // Store session
            this.sessions.set(sessionId, sessionData);

            // Emit success
            socket.emit('session:started', {
                sessionId,
                provider: actualProviderType,
                entityId: config.entityId,
            });

            console.log(`[SocketServer] Session started: ${sessionId}, provider: ${actualProviderType}, entity: ${config.entityId}`);

            // Start idle monitoring
            this.resetIdleTimeout(sessionData, socket);
        } catch (error) {
            console.error(`[SocketServer] Failed to start session:`, error);
            // Clean up the activeSession entry since this session failed to start
            this.removeActiveSession(sessionId);
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

                // Cap conversation history to prevent unbounded memory growth
                if (state.conversationHistory.length > 100) {
                    state.conversationHistory = state.conversationHistory.slice(-100);
                }
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

    private handleSessionEndForSocket(socket: Socket): void {
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

            // Remove session and dedup tracking
            this.sessions.delete(sessionId);
            this.removeActiveSession(sessionId);

            socket.emit('session:ended', {
                sessionId,
                history: sessionData.state.conversationHistory,
            });

            console.log(`[SocketServer] Session ended: ${sessionId}`);
        } else {
            // Session may not have been stored yet (failed during setup), but dedup key was set
            this.removeActiveSession(sessionId);
        }
    }

    /**
     * Public session end handler (for shutdown cleanup by socket ID)
     */
    handleSessionEnd(socketId: string): void {
        const sessionData = this.sessions.get(socketId);

        if (sessionData) {
            if (sessionData.idleTimeout) {
                clearTimeout(sessionData.idleTimeout);
            }
            if (sessionData.audioBlockTimeout) {
                clearTimeout(sessionData.audioBlockTimeout);
            }

            sessionData.provider.disconnect().catch(err => {
                console.error(`[SocketServer] Error disconnecting provider:`, err);
            });

            this.sessions.delete(socketId);
            this.removeActiveSession(socketId);
            console.log(`[SocketServer] Session ended: ${socketId}`);
        } else {
            this.removeActiveSession(socketId);
        }
    }

    private removeActiveSession(socketId: string): void {
        for (const [key, id] of this.activeSessions) {
            if (id === socketId) {
                this.activeSessions.delete(key);
                break;
            }
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

        if (data.data.length > MAX_AUDIO_MESSAGE_SIZE) {
            console.warn(`[SocketServer] Audio message too large: ${data.data.length} bytes`);
            return;
        }

        sessionData.state.lastActivityAt = Date.now();
        sessionData.provider.sendAudio(data);

        // Reset idle and audio block timeouts
        this.resetIdleTimeout(sessionData, socket);
        this.resetAudioBlockTimeout(sessionData, socket);
    }

    private async handleTextInput(socket: Socket, text: string): Promise<void> {
        if (typeof text !== 'string' || text.length === 0) {
            console.warn('[SocketServer] Invalid text input');
            return;
        }
        if (text.length > MAX_TEXT_LENGTH) {
            console.warn(`[SocketServer] Text input too long: ${text.length}`);
            return;
        }

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

        // Tell the realtime provider when client finishes playing audio (echo gate release)
        if (!isPlaying) {
            const provider = sessionData.provider as any;
            if (typeof provider.onAudioPlaybackComplete === 'function') {
                provider.onAudioPlaybackComplete();
            }
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

    getSessionsMap(): Map<string, SessionData> {
        return this.sessions;
    }

    getIO(): SocketIOServer {
        return this.io;
    }
}
