import { FastifyInstance } from "fastify";
import { TicketService } from "./tickets.service";
import SeatConflictError from "../../lib/custom_errors/SeatConflictError";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError";
import { reserveTicketSchema } from "./tickets.schema";

type ReserveTicketRequestBody = {
    seat_ids: string[],
    user_uuid: string
}
type PaymentIntentRequestBody = {
    reservation_token: string,
    user_uuid: string,
    idempotency_key: string
}

// MAX_RETRIES > 0 (otherwise /reserve will auto return 500)
const MAX_RETRIES = 3;
export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new TicketService(fastify.redis, fastify.prisma);

    fastify.post('/reserve', { schema: reserveTicketSchema }, async (request, reply) => {
        const request_body = request.body as ReserveTicketRequestBody;
        const seat_ids = request_body.seat_ids;
        const user_uuid = request_body.user_uuid;

        try {
            // add retry jitter -> catch case where multiple requests come in at same time for same seats, and all get through redis lock check before locks are set
            let attempt_error: Error | undefined;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    console.log(`Running attempt #${attempt}`);
                    const result = await service.reserveSeats(seat_ids, user_uuid);

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

    fastify.post('/payment/intent', async (request, reply) => {
        const request_body = request.body as PaymentIntentRequestBody;
        const reservation_token = request_body.reservation_token;
        const user_uuid = request_body.user_uuid;
        const idempotency_key = request_body.idempotency_key;

        const response = await service.createPaymentIntent(reservation_token, user_uuid, idempotency_key);

        return reply.status(200).send(response);
    })

    fastify.get('/idempotency_key', async (request, reply) => {
        try {
            const new_idempotency_key = crypto.randomUUID();
            return reply.status(200).send({ idempotency_key: new_idempotency_key });
        } catch (error) {
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    })
}