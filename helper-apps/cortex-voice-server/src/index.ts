/**
 * Cortex Voice Server
 *
 * Pluggable voice server for Cortex entities.
 * Supports OpenAI Realtime, OpenAI TTS/STT, and ElevenLabs providers.
 */

import { createServer } from 'http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
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

    // Create Hono app for HTTP endpoints
    const app = new Hono();

    // Health check endpoint
    app.get('/health', (c) => {
        return c.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            sessions: socketServer?.getSessionCount() || 0,
        });
    });

    // Server info endpoint
    app.get('/info', (c) => {
        return c.json({
            name: 'cortex-voice-server',
            version: '1.0.0',
            providers: getAvailableProviders(config),
            defaultProvider: config.defaultProvider,
        });
    });

    // Sessions endpoint (for monitoring)
    app.get('/sessions', (c) => {
        if (!config.debug) {
            return c.json({ error: 'Debug mode disabled' }, 403);
        }

        return c.json({
            count: socketServer?.getSessionCount() || 0,
            sessions: socketServer?.getSessions() || [],
        });
    });

    // Create HTTP server
    const httpServer = createServer(app.fetch as any);

    // Create Socket.io server
    let socketServer: SocketServer;

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
