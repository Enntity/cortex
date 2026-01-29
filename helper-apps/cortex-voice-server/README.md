# Cortex Voice Server

Pluggable voice server for Cortex entities with support for multiple voice providers.

## Features

- **Pluggable Architecture**: Supports multiple voice providers (OpenAI Realtime, OpenAI TTS/STT, ElevenLabs)
- **Full Cortex Integration**: Uses `sys_entity_agent` for intelligent responses with continuity memory, context stuffing, and 33+ entity tools
- **Real-time Communication**: Socket.io for low-latency bidirectional audio streaming
- **Session Management**: Idle detection, connection monitoring, and graceful disconnection
- **Voice Cloning Support**: ElevenLabs provider supports voice cloning for entity-specific voices

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Concierge Client                         │
│         (VoiceModeOverlay, AudioVisualizer, Controls)           │
└─────────────────────────────────────────────────────────────────┘
                              │
                         Socket.io
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Cortex Voice Server                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     Session Manager                          ││
│  │  • Per-client sessions                                       ││
│  │  • Idle timeout with exponential backoff                     ││
│  │  • Conversation history (last 8 messages)                    ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Voice Provider Layer                       ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐││
│  │  │  OpenAI     │ │  OpenAI     │ │      ElevenLabs         │││
│  │  │  Realtime   │ │  TTS/STT    │ │  (Voice Cloning)        │││
│  │  │  (Native)   │ │  Pipeline   │ │                         │││
│  │  └─────────────┘ └─────────────┘ └─────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Cortex Bridge                           ││
│  │  • sys_entity_agent queries (voiceResponse: true)            ││
│  │  • Voice sample fetching                                     ││
│  │  • Media event detection                                     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                         GraphQL
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Cortex API                               │
│              (sys_entity_agent, entity tools)                    │
└─────────────────────────────────────────────────────────────────┘
```

## Voice Providers

### OpenAI Realtime (Default)

Uses OpenAI's native Realtime API for lowest latency voice-to-voice interaction.

- **Pros**: Lowest latency, native interruption handling, server-side VAD
- **Cons**: Less control over individual components, OpenAI voices only

### OpenAI TTS/STT

Traditional pipeline: Whisper STT → Cortex Agent → OpenAI TTS

- **Pros**: More predictable, works with any text LLM, controllable pipeline
- **Cons**: Higher latency, requires client-side VAD

### ElevenLabs

High-quality TTS with voice cloning: Whisper STT → Cortex Agent → ElevenLabs TTS

- **Pros**: Best voice quality, voice cloning for custom entity voices
- **Cons**: Higher latency, additional API costs

## Quick Start

### 1. Install Dependencies

```bash
cd cortex/helper-apps/cortex-voice-server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

Required environment variables:
- `OPENAI_API_KEY`: Required for all providers
- `ELEVENLABS_API_KEY`: Required for ElevenLabs provider
- `CORTEX_API_URL`: URL to Cortex GraphQL API

### 3. Run Development Server

```bash
npm run dev
```

### 4. Run Production Server

```bash
npm run build
npm start
```

## Docker Deployment

```bash
docker-compose up -d
```

Or build and run manually:

```bash
docker build -t cortex-voice-server .
docker run -d \
  -p 3001:3001 \
  -e OPENAI_API_KEY=sk-xxx \
  -e CORTEX_API_URL=http://host.docker.internal:4000/graphql \
  cortex-voice-server
```

## API Endpoints

### HTTP

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check with session count |
| `GET /info` | Server info and available providers |
| `GET /sessions` | Active sessions (debug mode only) |

### Socket.io Events

#### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `session:start` | `VoiceConfig` | Start a voice session |
| `session:end` | - | End the current session |
| `audio:input` | `AudioData` | Send microphone audio |
| `text:input` | `string` | Send text message |
| `audio:mute` | `boolean` | Toggle mute state |
| `audio:interrupt` | - | Interrupt current response |
| `audio:speechEnd` | - | Signal end of speech (TTS providers) |
| `providers:list` | - | Get available providers |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `session:started` | `{sessionId, provider, entityId}` | Session created |
| `session:ended` | `{sessionId, history}` | Session ended with history |
| `session:error` | `{message}` | Error occurred |
| `session:idle` | `{count, timeout}` | Idle timeout warning |
| `state:change` | `VoiceState` | State changed |
| `transcript` | `TranscriptEvent` | User or assistant transcript |
| `audio:output` | `AudioData` | Audio to play |
| `tool:status` | `ToolStatusEvent` | Tool execution status |
| `media` | `MediaEvent` | Media to display |
| `providers:available` | `VoiceProviderType[]` | Available providers |

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `DEFAULT_VOICE_PROVIDER` | `openai-realtime` | Default provider |
| `OPENAI_API_KEY` | - | OpenAI API key |
| `ELEVENLABS_API_KEY` | - | ElevenLabs API key |
| `CORTEX_API_URL` | `http://localhost:4000/graphql` | Cortex GraphQL URL |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `MAX_AUDIO_MESSAGES` | `8` | Max conversation history |
| `IDLE_TIMEOUT_BASE_MS` | `2500` | Base idle timeout |
| `IDLE_TIMEOUT_MAX_MS` | `60000` | Max idle timeout |
| `AUDIO_BLOCK_TIMEOUT_MS` | `180000` | Audio block timeout |
| `DEBUG` | `false` | Enable debug mode |

## Client Integration

The Concierge client connects using the `useVoiceSession` hook:

```javascript
import { io } from 'socket.io-client';

const socket = io(voiceServerUrl, {
  transports: ['websocket'],
});

// Start session
socket.emit('session:start', {
  provider: 'openai-realtime',
  entityId: 'my-entity-id',
  chatId: 'optional-chat-id',
});

// Send audio (PCM16 @ 24kHz, base64 encoded)
socket.emit('audio:input', { data: base64Audio, sampleRate: 24000 });

// Receive audio
socket.on('audio:output', (data) => {
  // Play audio through WavStreamPlayer
});
```

## License

MIT
