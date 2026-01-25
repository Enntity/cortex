/**
 * Base class for voice providers with common event handling
 */

import {
    IVoiceProvider,
    VoiceProviderType,
    VoiceProviderEvents,
    VoiceConfig,
    VoiceState,
    AudioData,
    ICortexBridge,
    MediaEvent,
    ToolStatusEvent,
} from '../types.js';

export abstract class BaseVoiceProvider implements IVoiceProvider {
    abstract readonly type: VoiceProviderType;

    protected _isConnected: boolean = false;
    protected _state: VoiceState = 'idle';
    protected _isMuted: boolean = false;
    protected _config: VoiceConfig | null = null;
    protected cortexBridge: ICortexBridge;

    private listeners: Map<keyof VoiceProviderEvents, Set<Function>> = new Map();

    constructor(cortexBridge: ICortexBridge) {
        this.cortexBridge = cortexBridge;

        // Wire up bridge callbacks to provider events
        if (cortexBridge.onMedia) {
            cortexBridge.onMedia((event: MediaEvent) => {
                console.log('[BaseProvider] Forwarding media event from bridge');
                this.emit('media', event);
            });
        }

        if (cortexBridge.onToolStatus) {
            cortexBridge.onToolStatus((event: ToolStatusEvent) => {
                this.emit('tool-status', event);
            });
        }
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get state(): VoiceState {
        return this._state;
    }

    protected setState(state: VoiceState): void {
        if (this._state !== state) {
            this._state = state;
            this.emit('state-change', state);
        }
    }

    protected setConnected(connected: boolean): void {
        if (this._isConnected !== connected) {
            this._isConnected = connected;
            if (connected) {
                this.emit('connected');
            } else {
                this.emit('disconnected');
            }
        }
    }

    abstract connect(config: VoiceConfig): Promise<void>;
    abstract disconnect(): Promise<void>;
    abstract sendAudio(data: AudioData): void;
    abstract sendText(text: string): Promise<void>;
    abstract interrupt(): void;

    setMuted(muted: boolean): void {
        this._isMuted = muted;
    }

    on<K extends keyof VoiceProviderEvents>(
        event: K,
        listener: VoiceProviderEvents[K]
    ): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(listener);
    }

    off<K extends keyof VoiceProviderEvents>(
        event: K,
        listener: VoiceProviderEvents[K]
    ): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            eventListeners.delete(listener);
        }
    }

    protected emit<K extends keyof VoiceProviderEvents>(
        event: K,
        ...args: Parameters<VoiceProviderEvents[K]>
    ): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            for (const listener of eventListeners) {
                try {
                    (listener as Function)(...args);
                } catch (error) {
                    console.error(`Error in ${event} listener:`, error);
                }
            }
        }
    }

    protected emitError(error: Error): void {
        console.error(`[${this.type}] Error:`, error);
        this.emit('error', error);
    }
}
