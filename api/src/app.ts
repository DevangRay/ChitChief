// app.ts
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';

import swaggerPlugin from './plugins/swagger.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js'
import authRoutes from "./modules/auth/auth.routes.js"
import eventsRoutes from "./modules/events/events.routes.js";
import ticketsRoutes from "./modules/tickets/tickets.routes.js";
import webhookRoutes from "./modules/webhooks/webhooks.routes.js";
import usersRoutes from "./modules/users/users.routes.js";
import testCleanupRoutes from "./modules/test/test-cleanup.routes.js";

export async function buildApp() {
    const app = Fastify({ logger: true });

    await app.register(fastifyCors, {
        origin: [`https://${process.env.BACKEND_SERVER_HOST}:${process.env.BACKEND_SERVER_PORT}`],
        methods: ['GET', 'POST'],
        credentials: true
    })
    await app.register(fastifyRateLimit, {
        max: 500,
        timeWindow: '1 minute',
        ban: 10,
        // by default allow localhost for testing/with option to configure more IPs for staging/testing in CI/CD pipeline
        allowList: (process.env.RATE_LIMIT_ALLOWLIST ?? '127.0.0.1,::1')
            .split(',')
            .map(ip => ip.trim())
    })
    await app.register(fastifyHelmet);

    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(swaggerPlugin);

    await app.register(authRoutes, { prefix: "/auth" })
    await app.register(usersRoutes, { prefix: "/users" })
    await app.register(eventsRoutes, { prefix: "/events" });
    await app.register(ticketsRoutes, { prefix: "/tickets" });
    await app.register(webhookRoutes, { prefix: "/webhooks" })

    if (process.env.NODE_ENV !== 'production') {
        await app.register(testCleanupRoutes, { prefix: "/test" });
    }

    // simple help check
    app.get('/health', async () => ({ status: 'ok' }));

    return app
}