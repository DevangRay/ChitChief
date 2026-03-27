import { buildApp } from "./app";

async function start() {
    let app;
    try {
        app = await buildApp();
        await app.listen({ port: 3000 });
    } catch (error) {
        app?.log?.error(error);
        process.exit(1);
    }
}

start()