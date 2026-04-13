// app.ts
import Fastify from 'fastify';
import prismaPlugin from './plugins/prisma';
import redisPlugin from './plugins/redis'
import eventsRoutes from "./modules/events/events.routes";
import ticketsRoutes from "./modules/tickets/tickets.routes";
import webhookRoutes from "./modules/webhooks/webhooks.routes";

export async function buildApp() {
    const app = Fastify({ logger: true });

    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(eventsRoutes, { prefix: "/events" });
    await app.register(ticketsRoutes, { prefix: "/tickets" });
    await app.register(webhookRoutes, { prefix: "/webhooks" })
    // routes will be registered here later

    return app
}