const fastify = require('fastify')({
    logger: true
})

fastify.register(require('./modules/prisma-connector'));
fastify.register(require('./modules/events/events.routes'), { prefix: "/events" });

const start = async () => {
    try {
        await fastify.listen({ port: 3000 })
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

start()