import { FastifyInstance } from "fastify";
import { getEventsSchema, getEventByIdSchema, getSeatsOfEventByIdSchema } from "./events.schema";

export default async function routes(fastify: FastifyInstance, options: Object) {
        fastify.get('/', { schema: getEventsSchema }, async (request, reply) => {
            try {
                const events = await fastify.prisma.event.findMany({
                    where: {
                        date: {
                            gte: new Date()
                        }
                    }
                });

                if (events.length === 0) {
                    return reply.status(204).send(events);
                }
                return events;
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/] Failed to query events');
                return reply.status(500).send({ message: 'Internal server error.' });
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

                if (!event) {
                    return reply.status(404).send({ message: "Event not found." });
                }

                const return_object = {
                    ...event,
                    seat_count: event._count.seats
                }

                return return_object;
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/:id] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }),

        fastify.get<{ Params: { id: string }, Querystring: { status: "AVAILABLE" | "RESERVED" | "SOLD" } }>('/:id/seats', { schema: getSeatsOfEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            const status = request.query.status;
            try {
                const event_seats = await fastify.prisma.seat.findMany({
                    where: {
                        event_id: id,
                        seat_status: status
                    },
                    orderBy: {
                        price: "asc"
                    }
                })

                if (event_seats.length === 0) {
                    return reply.status(404).send({ message: 'Seats not found.' });
                }

                return event_seats;
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/:id/seats] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        })
}