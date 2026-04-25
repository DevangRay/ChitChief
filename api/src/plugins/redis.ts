import { type FastifyInstance } from "fastify";
import fp from 'fastify-plugin';
import { Redis } from "ioredis";

declare module 'fastify' {
    interface FastifyInstance {
        redis: Redis
    }
}

async function redisPlugin(fastify: FastifyInstance) {
    const redis = new Redis(process.env.REDIS_URL!,
        {
            maxRetriesPerRequest: null
        }
    );

    redis.on('error', (error) => {
        console.error('Redis connection error:', error);
    })

    fastify.decorate('redis', redis);
    fastify.addHook('onClose', async () => await redis.quit());
}

export default fp(redisPlugin);