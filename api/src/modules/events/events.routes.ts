import { type FastifyInstance } from "fastify";
import { getEventsSchema, getEventByIdSchema, getSeatsOfEventByIdSchema } from "./events.schema.js";
import EventsService from "./events.service.js";

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new EventsService(fastify.prisma);

    fastify.get('', { schema: getEventsSchema }, async (request, reply) => {
        try {
            const events = await service.getEvents();

            return reply.status(200).send(events);
        } catch (error) {
            fastify.log.error(error, '[GET /events/] Failed to query events');
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    }),

        fastify.get<{ Params: { id: string } }>('/:id', { schema: getEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            try {
                const event = await service.getEventById(id);

                if (!event) {
                    return reply.status(404).send({ message: "Event not found." });
                }

                return reply.status(200).send(event);
            } catch (error) {
                fastify.log.error(error, '[GET /events/:id] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }),

        fastify.get<{ Params: { id: string }, Querystring: { status: "AVAILABLE" | "RESERVED" | "SOLD" } }>('/:id/seats', { schema: getSeatsOfEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            const status = request.query.status;
            try {
                const event_seats = await service.getSeatsForEventById(id, status);

                if (event_seats.length === 0) {
                    return reply.status(404).send({ message: 'Seats not found.' });
                }

                return reply.status(200).send(event_seats);
            } catch (error) {
                fastify.log.error(error, '[GET /events/:id/seats] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        })
}