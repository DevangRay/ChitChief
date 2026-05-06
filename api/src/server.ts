import 'dotenv/config';
import { buildApp } from "./app.js";

const REQUIRED_ENV_VARS = [
    'NODE_ENV',
    'DATABASE_URL',
    'REDIS_URL',
    'SIGNING_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_ENDPOINT_SECRET',
    'RESEND_SECRET_KEY',
] as const;

function validateEnv() {
    const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`[server] Missing required environment variables:\n  ${missing.join('\n  ')}`);
        process.exit(1);
    }
}

async function start() {
    validateEnv();
    let app;
    try {
        app = await buildApp();
        const port = Number(process.env.PORT ?? 3000);
        const host = '0.0.0.0'; // Listen on all interfaces for production compatibility
        await app.listen({ port, host });
    } catch (error) {
        console.error("[server] Startup error:", error);
        app?.log?.error(error);
        process.exit(1);
    }

    const shutdown = async (signal: string) => {
        app!.log.info(`[server] Received ${signal}, shutting down gracefully...`);
        // Waits 10 seconsd for force-exiting
        setTimeout(() => {
            app!.log.error('[server] Shutdown timed out, forcing exit');
            process.exit(1);
        }, 10000).unref();
        try {
            await app!.close();
            process.exit(0);
        } catch (error) {
            app!.log.error(error, '[server] Error during shutdown');
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

start()