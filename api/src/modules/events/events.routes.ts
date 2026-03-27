import { FastifyInstance } from "fastify";

export default async function routes(fastify: FastifyInstance, options: Object) {
    fastify.get('/', async (request, reply) => {
        try {
            const events = await fastify.prisma.event.findMany();
            return events;
        } catch (error) {
            fastify.log.error({ error }, '[GET /events/] Failed to query events')
            return reply.status(500).send({ message: 'Internal server error' })
        }
    }),
    fastify.get('/:id', async(request, reply) => {

    })
}