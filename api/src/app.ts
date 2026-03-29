// app.ts
import Fastify from 'fastify';
import prismaPlugin from './plugins/prisma';
import redisPlugin from './plugins/redis'
import eventsRoutes from "./modules/events/events.routes";
import ticketsRoutes from "./modules/tickets/tickets.routes";

export async function buildApp() {
    const app = Fastify({ logger: true });

    await app.register(prismaPlugin);
    await app.register(redisPlugin, { closeClient: true });
    await app.register(eventsRoutes, { prefix: "/events" });
    await app.register(ticketsRoutes, { prefix: "/tickets" });
    // routes will be registered here later

    return app
}