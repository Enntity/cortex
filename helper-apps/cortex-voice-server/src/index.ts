/**
 * Cortex Voice Server
 *
 * Pluggable voice server for Cortex entities.
 * Supports OpenAI Realtime, OpenAI TTS/STT, and ElevenLabs providers.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { loadConfig, validateConfig } from './config.js';
import { SocketServer } from './SocketServer.js';
import { getAvailableProviders } from './providers/index.js';
import { VoiceRegistry } from './services/VoiceRegistry.js';

async function main(): Promise<void> {
    console.log('┌─────────────────────────────────────────────┐');
    console.log('│       Cortex Voice Server v1.0.0            │');
    console.log('└─────────────────────────────────────────────┘');

    // Load and validate configuration
    const config = loadConfig();

    try {
        validateConfig(config);
    } catch (error) {
        console.error('\n❌ Configuration Error:');
        console.error((error as Error).message);
        process.exit(1);
    }

    // Voice registry for unified voice listing
    const voiceRegistry = new VoiceRegistry(config);

    // Socket server reference (set after creation)
    let socketServer: SocketServer;

    // Create HTTP server with request handler for health/info endpoints
    // Socket.io intercepts its own paths via the 'upgrade' event
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url || '/';

        // CORS headers - validate origin against configured origins
        const allowedOrigins = config.corsOrigins;
        const origin = req.headers.origin;
        if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Health check endpoint
        if (url === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({
                status: 'ok',
                timestamp: new Date().toISOString(),
                sessions: socketServer?.getSessionCount() || 0,
            }));
            return;
        }

        // Server info endpoint
        if (url === '/info') {
            res.writeHead(200);
            res.end(JSON.stringify({
                name: 'cortex-voice-server',
                version: '1.0.0',
                providers: getAvailableProviders(config),
                defaultProvider: config.defaultProvider,
            }));
            return;
        }

        // Sessions endpoint (for monitoring, debug mode only)
        if (url === '/sessions') {
            if (!config.debug) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Debug mode disabled' }));
                return;
            }

            res.writeHead(200);
            res.end(JSON.stringify({
                count: socketServer?.getSessionCount() || 0,
                sessions: socketServer?.getSessions() || [],
            }));
            return;
        }

        // Auth check for voice endpoints — require shared AUTH_SECRET
        const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
            const authHeader = req.headers['x-auth-secret'] || req.headers['authorization']?.replace('Bearer ', '');
            if (!config.authSecret || authHeader !== config.authSecret) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return false;
            }
            return true;
        };

        // Voice preview endpoint (TTS on demand)
        if (url.startsWith('/voices/preview')) {
            if (!requireAuth(req, res)) return;

            const params = new URL(url, 'http://localhost').searchParams;
            const provider = params.get('provider') as import('./types.js').VoiceProviderType;
            const voiceId = params.get('voiceId');
            const text = params.get('text');

            if (!provider || !voiceId || !text) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'provider, voiceId, and text are required' }));
                return;
            }

            if (text.length > 500) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'text must be 500 characters or fewer' }));
                return;
            }

            voiceRegistry.generatePreview(provider, voiceId, text).then(({ audio, contentType }) => {
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Length': audio.length,
                    'Cache-Control': 'public, max-age=86400',
                });
                res.end(audio);
            }).catch(err => {
                console.error('[VoiceRegistry] Preview error:', err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to generate preview' }));
            });
            return;
        }

        // Unified voice listing endpoint
        if (url === '/voices') {
            if (!requireAuth(req, res)) return;

            voiceRegistry.getVoices().then(voices => {
                res.writeHead(200);
                res.end(JSON.stringify(voices));
            }).catch(err => {
                console.error('[VoiceRegistry] Error fetching voices:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to fetch voices' }));
            });
            return;
        }

        // Socket.io handles /socket.io/* paths via upgrade event
        // Return 404 for any other paths
        if (!url.startsWith('/socket.io')) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });

    // Create Socket.io server
    try {
        socketServer = new SocketServer(httpServer, config);
    } catch (error) {
        console.error('❌ Failed to create Socket server:', error);
        process.exit(1);
    }

    // Start server
    httpServer.listen(config.port, () => {
        console.log(`\n✅ Server running on port ${config.port}`);
        console.log(`\n📋 Configuration:`);
        console.log(`   • Default Provider: ${config.defaultProvider}`);
        console.log(`   • Available Providers: ${getAvailableProviders(config).join(', ')}`);
        console.log(`   • Cortex API: ${config.cortexApiUrl}`);
        console.log(`   • CORS Origins: ${Array.isArray(config.corsOrigins) ? config.corsOrigins.join(', ') : config.corsOrigins}`);
        console.log(`   • Debug Mode: ${config.debug ? 'enabled' : 'disabled'}`);
        console.log(`\n🔗 Endpoints:`);
        console.log(`   • Health: http://localhost:${config.port}/health`);
        console.log(`   • Info: http://localhost:${config.port}/info`);
        if (config.debug) {
            console.log(`   • Sessions: http://localhost:${config.port}/sessions`);
        }
        console.log(`\n🎤 Ready for voice connections via Socket.io`);
    });

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n\n👋 Shutting down...');

        // Clean up all active sessions
        if (socketServer) {
            const sessions = socketServer.getSessionsMap();
            for (const [socketId] of sessions) {
                try {
                    socketServer.handleSessionEnd(socketId);
                } catch (err) {
                    console.error(`[Shutdown] Error cleaning up session ${socketId}:`, err);
                }
            }
            socketServer.getIO().close();
        }

        httpServer.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });

        // Force close after 5 seconds
        setTimeout(() => {
            console.log('⚠️ Forcing shutdown');
            process.exit(1);
        }, 5000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
