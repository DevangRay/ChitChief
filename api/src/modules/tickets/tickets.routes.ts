import { FastifyInstance } from "fastify";
import { TicketService } from "./tickets.service";
import { Seat, SeatStatus } from "@prisma/client";
import SeatConflictError from "../../lib/custom_errors/SeatConflictError";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError";

// MAX_RETRIES > 0 (otherwise /reserve will auto return 500)
const MAX_RETRIES = 3;
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
            const user_id = '2d62c96e-0078-4653-98ba-595644b67b82';

            // add retry jitter -> catch case where multiple requests come in at same time for same seats, and all get through redis lock check before locks are set
            let attempt_error: Error | undefined;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    console.log(`Running attempt #${attempt}`);
                    const result = await service.reserveSeats(seat_ids, user_id);

                    return reply.status(200).send(result);
                } catch (error) {
                    attempt_error = error as Error;

                    if (attempt_error instanceof SeatConflictError) {
                        console.log("[tickets.routes]: Caught 409 Error. Retrying after random time.")

                        // avoids pointlessly sleeping before return
                        if (attempt < MAX_RETRIES - 1) {
                            // random_time is in 100s of milliseconds
                            const random_time = 50 + (Math.random() * 100);
                            console.log("random_time is:", random_time);
                            await new Promise(r => setTimeout(r, random_time));
                        }

                        continue;
                    } else if (attempt_error instanceof ResourceNotFoundError) {
                        console.log("[tickets.routes]: Caught 404 Error. Returning.")
                        // ResourceNotFoundError will not be fixed in retry. Should be returned immediately.
                        return reply.status(404).send({ message: attempt_error.message });
                    }
                }
            }

            if (attempt_error instanceof SeatConflictError) {
                console.log("[tickets.routes]: Caught 409 Error")
                return reply.status(409).send({ message: attempt_error.message, conflict_seat_ids: attempt_error.conflict_seat_ids });
            }
            
            // Unexpcted error after retries
            return reply.status(500).send({ message: 'Internal server error.' });
        } catch (error) {
            console.log("error: " + error);
            fastify.log.error(error, '[GET /reserve] Failed to reserve seats');
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    })
}