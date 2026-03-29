import { FastifyInstance } from "fastify";
import fp from 'fastify-plugin';
import Redis from "ioredis";

declare module 'fastify' {
    interface FastifyInstance {
        redis: Redis
    }
}

async function redis(fastify: FastifyInstance) {
    const redis = new Redis({ host: 'localhost', port: 6379 });

    fastify.decorate('redis', redis);
    fastify.addHook('onClose', async () => await redis.quit());
}

export default fp(redis);