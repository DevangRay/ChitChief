import { FastifyInstance } from "fastify";
import { getEventsSchema, getEventByIdSchema, getSeatsOfEventByIdSchema } from "./events.schema";

export default async function routes(fastify: FastifyInstance, options: Object) {
    fastify.get('/', { schema: getEventsSchema }, async (request, reply) => {
        try {
            const events = await fastify.prisma.event.findMany();
            return events;
        } catch (error) {
            fastify.log.error({ error }, '[GET /events/] Failed to query events');
            return reply.status(500).send({ message: 'Internal server error' });
        }
    }),
        fastify.get<{ Params: { id: string } }>('/:id', { schema: getEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            try {
                const event = await fastify.prisma.event.findUnique({
                    where: {
                        id: id
                    },
                    include: {
                        _count: {
                            select: {
                                seats: {
                                    where: {
                                        seat_status: 'RESERVED'
                                    }
                                }
                            }
                        }
                    }
                });

                return event;
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/:id] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error' });
            }
        }),
        fastify.get<{ Params: { id: string } }>('/:id/seats', { schema: getSeatsOfEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            try {
                const event_seats = await fastify.prisma.seat.findMany({
                    where: {
                        event_id: id
                    },
                    orderBy: {
                        price: "asc"
                    }
                })

                return event_seats;
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/:id/seats] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error' });
            }
        })
}