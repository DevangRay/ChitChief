import { FastifyInstance } from "fastify";
import { getEventsSchema, getEventByIdSchema, getSeatsOfEventByIdSchema } from "../events/events.schema";
import EventsService from "../events/events.service";
import { TicketService } from "./tickets.service";

export default async function routes(fastify: FastifyInstance, options: Object) {
    const eventService = new EventsService(fastify.prisma);
    const service = new TicketService(fastify.redis, fastify.prisma);

    fastify.get('/reserve', async (request, reply) => {
        try {
            const seats_array: { number: number; id: string; event_id: string; row: string; price: number; seat_status: 'AVAILABLE' | 'RESERVED' | 'SOLD' }[] = [
                {
                    id: '4d17bf3c-248f-463c-8ae0-bc1de4ee519c',
                    event_id: 'b4840051-8571-4391-be32-b94142db7c3c',
                    row: 'A',
                    number: 1,
                    price: 100,
                    seat_status: 'AVAILABLE'
                },
                {
                    id: 'dbd63efe-19c5-4ff2-b0be-97e8b3ae1dc9',
                    event_id: 'b4840051-8571-4391-be32-b94142db7c3c',
                    row: 'A',
                    number: 2,
                    price: 200,
                    seat_status: 'AVAILABLE'
                }
            ]
            const result = await service.reserveSeats(seats_array, 'b661eea8-4717-4f93-9324-a571ef8adc73');
            console.dir(result)

            if (result.success) {
                return reply.status(200).send(result);
            } else {
                return reply.status(409).send(result);
            }

        } catch (error) {
            console.log("error: " + error)
            fastify.log.error({ error }, '[GET /reserve] Failed to reserve seats');
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    })

    fastify.get('/', { schema: getEventsSchema }, async (request, reply) => {
        try {
            const events = await eventService.getEvents();

            return reply.status(200).send(events);
        } catch (error) {
            fastify.log.error({ error }, '[GET /events/] Failed to query events');
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    }),

        fastify.get<{ Params: { id: string } }>('/:id', { schema: getEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            try {
                const event = await eventService.getEventById(id);

                if (!event) {
                    return reply.status(404).send({ message: "Event not found." });
                }

                return reply.status(200).send(event);
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/:id] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }),

        fastify.get<{ Params: { id: string }, Querystring: { status: "AVAILABLE" | "RESERVED" | "SOLD" } }>('/:id/seats', { schema: getSeatsOfEventByIdSchema }, async (request, reply) => {
            const { id } = request.params;
            const status = request.query.status;
            try {
                const event_seats = await eventService.getSeatsForEventById(id, status);

                if (event_seats.length === 0) {
                    return reply.status(404).send({ message: 'Seats not found.' });
                }

                return reply.status(200).send(event_seats);
            } catch (error) {
                fastify.log.error({ error }, '[GET /events/:id/seats] Failed to query events for id:', id);
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        })

    // fastify.get('/streams', async (request, reply) => {
    //     // We write an event to the stream 'my awesome fastify stream name', setting 'key' to 'value'
    //     await fastify.redis.xadd(['my awesome fastify stream name', '*', 'hello', 'fastify is awesome'])

    //     // We read events from the beginning of the stream called 'my awesome fastify stream name'
    //     let redisStream = await fastify.redis.xread(['STREAMS', 'my awesome fastify stream name', 0])

    //     // We parse the results
    //     let response = []
    //     let events = redisStream![0]![1]

    //     for (let i = 0; i < events.length; i++) {
    //         const e = events[i]
    //         response.push(`#LOG: id is ${e[0].toString()}`)

    //         // We log each key
    //         for (const key in e![1]) {
    //             response.push(e![1][key]!.toString())
    //         }
    //     }

    //     reply.status(200)
    //     return { output: response }
    //     // Will return something like this :
    //     // { "output": ["#LOG: id is 1559985742035-0", "hello", "fastify is awesome"] }
    // })
}