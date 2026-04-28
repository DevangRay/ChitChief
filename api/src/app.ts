// app.ts
import Fastify from 'fastify';
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

    return app
}