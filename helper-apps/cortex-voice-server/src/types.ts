/**
 * Core types for the Cortex Voice Server
 */

export type VoiceProviderType = 'openai-realtime' | 'openai-tts' | 'elevenlabs';

export interface VoiceSettings {
    stability?: number;      // 0.0 - 1.0
    similarity?: number;     // 0.0 - 1.0
    style?: number;          // 0.0 - 1.0
    speakerBoost?: boolean;
}

export interface VoiceConfig {
    provider: VoiceProviderType;
    entityId: string;
    chatId?: string;
    userId?: string;
    contextId?: string;      // For continuity memory (user's context ID)
    contextKey?: string;     // For continuity memory (user's context key)
    aiName?: string;         // Entity display name
    userName?: string;       // User display name
    userInfo?: string;       // User info for time zone, location context (e.g., "User is in EST timezone")
    voiceSample?: string;
    voiceId?: string;
    voiceSettings?: VoiceSettings;  // TTS voice settings (stability, similarity, style, speakerBoost)
    model?: string;
}

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

export interface TranscriptEvent {
    type: 'user' | 'assistant';
    content: string;
    isFinal: boolean;
    timestamp: number;
}

export interface ToolStatusEvent {
    name: string;
    status: 'running' | 'completed' | 'error';
    message: string;
    timestamp: number;
}

export interface OverlayItem {
    type: 'text' | 'image' | 'video';
    url?: string;
    content?: string;
    duration?: number;
    label?: string;
}

export interface MediaEvent {
    type: 'image' | 'video' | 'slideshow' | 'overlay';
    urls?: string[];
    items?: OverlayItem[];
    title?: string;
}

export interface AudioData {
    data: string; // Base64 encoded PCM16
    sampleRate: number;
    trackId?: string; // For tracking sentence audio streams
}

export interface SessionState {
    id: string;
    entityId: string;
    chatId?: string;
    provider: VoiceProviderType;
    state: VoiceState;
    isConnected: boolean;
    isMuted: boolean;
    conversationHistory: ConversationMessage[];
    createdAt: number;
    lastActivityAt: number;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export interface CortexAgentResponse {
    result: string;
    tool?: string;
    errors?: string[];
    warnings?: string[];
}

export interface TrackCompleteEvent {
    trackId: string;
}

export interface TrackStartEvent {
    trackId: string;
    text: string;
}

export interface VoiceProviderEvents {
    'state-change': (state: VoiceState) => void;
    'transcript': (event: TranscriptEvent) => void;
    'audio': (data: AudioData) => void;
    'tool-status': (event: ToolStatusEvent) => void;
    'media': (event: MediaEvent) => void;
    'track-start': (event: TrackStartEvent) => void;
    'track-complete': (event: TrackCompleteEvent) => void;
    'error': (error: Error) => void;
    'connected': () => void;
    'disconnected': () => void;
}

/**
 * Abstract voice provider interface
 * All voice providers must implement this interface
 */
export interface IVoiceProvider {
    readonly type: VoiceProviderType;
    readonly isConnected: boolean;
    readonly state: VoiceState;

    /**
     * Connect to the voice service
     */
    connect(config: VoiceConfig): Promise<void>;

    /**
     * Disconnect from the voice service
     */
    disconnect(): Promise<void>;

    /**
     * Send audio data from the user's microphone
     */
    sendAudio(data: AudioData): void;

    /**
     * Send a text message (for hybrid voice/text modes)
     */
    sendText(text: string): Promise<void>;

    /**
     * Interrupt the current response
     */
    interrupt(): void;

    /**
     * Set mute state
     */
    setMuted(muted: boolean): void;

    /**
     * Register event listener
     */
    on<K extends keyof VoiceProviderEvents>(
        event: K,
        listener: VoiceProviderEvents[K]
    ): void;

    /**
     * Remove event listener
     */
    off<K extends keyof VoiceProviderEvents>(
        event: K,
        listener: VoiceProviderEvents[K]
    ): void;
}

/**
 * Factory function signature for creating voice providers
 */
export type VoiceProviderFactory = (
    cortexBridge: ICortexBridge
) => IVoiceProvider;

/**
 * Cortex bridge interface for sys_entity_agent integration
 */
export interface ICortexBridge {
    /**
     * Set session context for sys_entity_agent calls
     */
    setSessionContext(config: VoiceConfig): void;

    /**
     * Send a message to the entity agent and get a response
     */
    query(
        text: string,
        entityId: string,
        chatHistory?: ConversationMessage[]
    ): Promise<CortexAgentResponse>;

    /**
     * Get voice sample for an entity (optional for streaming bridges)
     */
    getVoiceSample?(entityId: string): Promise<string | null>;

    /**
     * Report tool execution status
     */
    onToolStatus?(callback: (event: ToolStatusEvent) => void): void;

    /**
     * Report media events
     */
    onMedia?(callback: (event: MediaEvent) => void): void;
}

/**
 * Server configuration
 */
export interface ServerConfig {
    port: number;
    corsOrigins: string | string[];
    defaultProvider: VoiceProviderType;
    openaiApiKey?: string;
    elevenlabsApiKey?: string;
    deepgramApiKey?: string;
    sttProvider?: 'elevenlabs' | 'deepgram' | 'whisper';
    cortexApiUrl: string;
    maxAudioMessages: number;
    idleTimeoutBaseMs: number;
    idleTimeoutMaxMs: number;
    audioBlockTimeoutMs: number;
    debug: boolean;
}
