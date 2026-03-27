// app.ts
import Fastify from 'fastify';
import prismaPlugin from './plugins/prisma';
// import { redisPlugin } from './plugins/redis'
import eventsRoutes from "./modules/events/events.routes";

export async function buildApp() {
    const app = Fastify({ logger: true });

    await app.register(prismaPlugin);
    await app.register(eventsRoutes, { prefix: "/events" });
    // routes will be registered here later

    return app
}