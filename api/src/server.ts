import 'dotenv/config';
import { buildApp } from "./app.js";

async function start() {
    let app;
    try {
        app = await buildApp();
        await app.listen({ port: Number(process.env.BACKEND_SERVER_PORT), host: `${process.env.BACKEND_SERVER_HOST}` });
    } catch (error) {
        console.log("[server.ts] Fastify API error:", error)
        app?.log?.error(error);
        process.exit(1);
    }
}

start()