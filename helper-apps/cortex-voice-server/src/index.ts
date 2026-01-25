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

    // Socket server reference (set after creation)
    let socketServer: SocketServer;

    // Create HTTP server with request handler for health/info endpoints
    // Socket.io intercepts its own paths via the 'upgrade' event
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url || '/';

        // CORS headers for all responses
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
