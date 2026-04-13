import { FastifyInstance } from "fastify";
import { TicketService } from "./tickets.service";
import { reserveTicketSchema, createPaymentIntentSchema, getIdempotencyKeyForDemo } from "./tickets.schema";
import { PaymentMethod } from "../../lib/payment-method";
import SeatConflictError from "../../lib/custom_errors/SeatConflictError";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError";
import ConflictError from "../../lib/custom_errors/ConflictError";

type ReserveTicketRequestBody = {
    seat_ids: string[],
    user_uuid: string
}
type PaymentIntentRequestBody = {
    reservation_token: string,
    user_uuid: string,
    idempotency_key: string,
    payment_method: PaymentMethod
}

// MAX_RETRIES > 0 (otherwise /reserve will auto return 500)
const MAX_RETRIES = 3;
export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new TicketService(fastify.redis, fastify.prisma);

    fastify.post('/reserve', { schema: reserveTicketSchema }, async (request, reply) => {
        try {
            const request_body = request.body as ReserveTicketRequestBody;
            const seat_ids = request_body.seat_ids;
            const user_uuid = request_body.user_uuid;

            // add retry jitter -> catch case where multiple requests come in at same time for same seats, and all get through redis lock check before locks are set
            let attempt_error: Error | undefined;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    console.log(`[tickets.routes /reserve]: Running attempt #${attempt}`);
                    const result = await service.reserveSeats(seat_ids, user_uuid);

                    return reply.status(200).send(result);
                } catch (error) {
                    attempt_error = error as Error;

                    if (attempt_error instanceof SeatConflictError) {
                        console.log("[tickets.routes /reserve]: Caught 409 Error. Retrying after random time.")

                        // avoids pointlessly sleeping before return
                        if (attempt < MAX_RETRIES - 1) {
                            // random_time is in 100s of milliseconds
                            const random_time = 50 + (Math.random() * 100);
                            console.log("[tickets.routes /reserve]: random_time is:", random_time);
                            await new Promise(r => setTimeout(r, random_time));
                        }

                        continue;
                    } else if (attempt_error instanceof ResourceNotFoundError) {
                        console.log("[tickets.routes /reserve]: Caught 404 Error. Returning.")
                        // ResourceNotFoundError will not be fixed in retry. Should be returned immediately.
                        return reply.status(404).send({ message: attempt_error.message });
                    }
                }
            }

            if (attempt_error instanceof SeatConflictError) {
                console.log("[[tickets.routes /reserve]: Caught 409 Error")
                return reply.status(409).send({ message: attempt_error.message, conflict_seat_ids: attempt_error.conflict_seat_ids });
            }

            // Unexpcted error after retries
            return reply.status(500).send({ message: 'Internal server error.' });
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log("[tickets.routes /reserve]: Unplanned error: ", printable_error);
            fastify.log.error(error, '[GET /reserve] Failed to reserve seats');
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    });

    fastify.get('/demo/idempotency_key', { schema: getIdempotencyKeyForDemo }, async (request, reply) => {
        try {
            const new_idempotency_key = crypto.randomUUID();
            return reply.status(200).send({ idempotency_key: new_idempotency_key });
        } catch (error) {
            return reply.status(500).send({ message: 'Internal server error.' });
        }
    });

    fastify.post('/payment/intent', { schema: createPaymentIntentSchema }, async (request, reply) => {
        try {
            const request_body = request.body as PaymentIntentRequestBody;
            const reservation_token = request_body.reservation_token;
            const user_uuid = request_body.user_uuid;
            const idempotency_key = request_body.idempotency_key;
            const payment_method = request_body.payment_method;

            const response = await service.createPaymentIntent(reservation_token, user_uuid, idempotency_key, payment_method);

            return reply.status(200).send(response);
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log("[tickets.routes /payment/intent]: Caught error:", printable_error);

            if (error instanceof ForbiddenError) {
                console.log("[tickets.routes /payment/intent]: Caught 403 Error. Returning.")
                return reply.status(403).send({ message: error.message });
            } else if (error instanceof ResourceNotFoundError) {
                console.log("[tickets.routes /payment/intent]: Caught 404 Error. Returning.")
                return reply.status(404).send({ message: error.message });
            } else if (error instanceof SeatConflictError) {
                console.log("[tickets.routes /payment/intent]: Caught 409 Error for Seats. Returning.")
                return reply.status(409).send({ message: error.message, conflict_seat_ids: error.conflict_seat_ids });
            } else if (error instanceof ConflictError) {
                console.log("[tickets.routes /payment/intent]: Caught 409 Error on other Resource. Returning.")
                return reply.status(409).send({ message: error.message });
            } else {
                console.log("[tickets.routes /payment/intent]: Unplanned error. Returning.")
                return reply.status(500).send({ message: 'Internal server error' });
            }
        }
    });

    // fastify.post('/payment/confirm', async (request, reply) => {
    //     console.log("headers:", request.headers)
    //     const body_event = request.body;
    //     console.log("body_event:", body_event);

    //     const endpoint_secret = ""
    //     const signature = request.headers['stripe-signature'];
    //     console.log("endpoint_secret:", endpoint_secret)
    //     console.log("signature:", signature)

    //     try {
    //         const stripe = Stripe(process.env.STRIPE_SECRET_KEY!);
    //         const event = stripe.webhooks.constructEvent(
    //             body_event,
    //             signature,
    //             endpoint_secret
    //         );

    //         console.log("constructed event:", event);
    //     } catch(error) {
    //         console.log("caught error:", error)
    //         return reply.status(400).send({message: error})
    //     }

    //     return reply.status(200).send({recieved: true})
    //     console.log("need to update db");
    // });
}