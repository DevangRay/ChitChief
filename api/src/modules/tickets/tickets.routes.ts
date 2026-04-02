import { FastifyInstance } from "fastify";
import { TicketService } from "./tickets.service";
import { Seat } from "@prisma/client";
import * as jwt from 'jsonwebtoken';

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new TicketService(fastify.redis, fastify.prisma, jwt);

    fastify.get('/reserve', async (request, reply) => {
        try {
            const seats_array: Seat[] = [
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
            fastify.log.error(error, '[GET /reserve] Failed to reserve seats');
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    })
}