import { FastifyInstance } from "fastify";
import { TicketService } from "./tickets.service";
import { Seat, SeatStatus } from "@prisma/client";
import SeatConflictError from "../../lib/custom_errors/SeatConflictError";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError";

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new TicketService(fastify.redis, fastify.prisma);

    fastify.get('/reserve', async (request, reply) => {
        try {
            const seats_array: Seat[] = [
                {
                    id: "1aaff027-dd70-4932-a00f-b4f4afb4a36e",
                    event_id: "50b4f4cf-77f1-4d75-a662-8ed9b58090d3",
                    row: "A",
                    number: 1,
                    price: 10000,
                    seat_status: SeatStatus.AVAILABLE
                },
                {
                    id: "58ad014c-0bde-4c15-9c28-d202584937cd",
                    event_id: "50b4f4cf-77f1-4d75-a662-8ed9b58090d3",
                    row: "A",
                    number: 2,
                    price: 10000,
                    seat_status: SeatStatus.AVAILABLE
                }
            ]

            const seat_ids = seats_array.map(seat => seat.id);

            // add retry jitter -> catch case where multiple requests come in at same time for same seats, and all get through redis lock check before locks are set
            const result = await service.reserveSeats(seat_ids, '2d62c96e-0078-4653-98ba-595644b67b82');
            console.dir(result)
            return reply.status(200).send(result);

        } catch (error) {
            console.log("error: " + error)
            fastify.log.error(error, '[GET /reserve] Failed to reserve seats');

            if (error instanceof SeatConflictError) {
                return reply.status(409).send({ message: error.message, conflict_seat_ids: error.conflict_seat_ids });
            } else if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    })
}