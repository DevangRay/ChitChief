import { GenericContainer, StartedTestContainer } from "testcontainers";
import { Redis } from 'ioredis';

let container: StartedTestContainer;
let redis: Redis;

export async function startRedis() {
    container = await new GenericContainer('redis:7-alpha')
        .withExposedPorts(6379)
        .start();

    const port = container.getMappedPort(6379);
    const url = `redis://localhost:${port}`;
    process.env.REDIS_URL = url;

    redis = new Redis(url);
    return redis;
}

export async function stopRedis() {
    await redis.quit();
    await container.stop();
}

export async function clearRedis() {
    await redis.flushall();
}

export { redis }