import { OrderStatus, PrismaClient, Seat, SeatStatus } from "@prisma/client"
import { Queue } from "bullmq"
import * as jwt from 'jsonwebtoken';
import Redis from "ioredis";
import Stripe from 'stripe';
import { seatIdFromLock, seatLockFromId } from "../../lib/redis-keys";
import { getStripePaymentMethodFromEnum, PaymentMethodKey } from "../../lib/payment-method";
import SeatConflictError from "../../lib/custom_errors/SeatConflictError";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError";
import ConflictError from "../../lib/custom_errors/ConflictError";

type PaymentIntent = {
    id: string | undefined,
    client_secret: string | undefined,
    latest_charge: string | undefined
} | StripePaymentIntent;

type StripePaymentIntent = Awaited<ReturnType<typeof Stripe.prototype.paymentIntents.create>>;

type SigningObject = {
    redis_locks: string[],
    seat_ids: string[],
    expires_at: number,
    user_uuid: string,
    expire_seat_job_id: string
} | null

type ReservationObject = {
    reservation_token: string,
    expires_at: number,
    expires_at_string: string
}

/*
TODO:
    * Extract steps to helper functions
    * Need to check if user exists in the DB
*/
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const TTL_TIME_IN_SECONDS = 60;

// Can improve performance with SCRIPT LOAD and using EVALSHA
const REDIS_LOCK_LUA_SCRIPT = `
    local keys = KEYS
    local user_id = ARGV[1]
    local expiration_timestamp = ARGV[2]

    local conflicts = {}

    -- Check if some seats are locked
    for i = 1, #KEYS do
        if redis.call("EXISTS", KEYS[i]) == 1 then
            table.insert(conflicts, KEYS[i])
        end
    end

    -- Return conflicting seat ids if there are any conflicts
    if #conflicts > 0 then
        local result = {'CONFLICT'}
        for _, key in ipairs(conflicts) do
            table.insert(result, key)
        end
        return result
    end 

    for i = 1, #KEYS do
        redis.call("SET", KEYS[i], user_id, "PXAT", expiration_timestamp, "NX")
    end

    return {'OK'}
`

export class TicketService {
    private readonly reservation_queue: Queue;

    constructor(private readonly redis: Redis, private readonly prisma: PrismaClient) {
        this.reservation_queue = new Queue('reservations', {
            connection: this.redis
        });
    }

    async reserveSeats(seats: string[], user_uuid: string): Promise<ReservationObject> {
        // 1. Validate seats and user
        console.log("[reserveSeats] Validating seats and user parameters.");
        if (!seats || seats.length === 0 || seats.length > 10) {
            console.log("[reserveSeats] Invalid number of seats provided for reservation.");
            throw new ResourceNotFoundError("Invalid number of seats provided.")
        }
        if (!user_uuid) {
            console.log("[reserveSeats] No user provided for reservation.");
            throw new ResourceNotFoundError("No user provided.")
        }

        const unique_seat_ids = [...new Set(seats)];
        if (unique_seat_ids.length !== seats.length) {
            console.log("[reserveSeats] Duplicate Seat IDs provided in reservation request.");
            throw new ResourceNotFoundError("Duplicate Seat IDs provided.")
        }
        console.log("[reserveSeats] Validation successful for seats and user.");

        // 2. Check seats are available and not sold in DB
        console.log("[reserveSeats] Checking seat availability in database for seat ids:");
        const seat_statuses = await this.prisma.seat.findMany({
            where: {
                id: {
                    in: unique_seat_ids
                },
                seat_status: SeatStatus.AVAILABLE
            }
        });

        if (seat_statuses.length !== seats.length) {
            console.log("[reserveSeats] Some seats are not available.");

            const available_seat_ids = new Set(seat_statuses.map((s: Seat) => s.id));
            const unavailable_seats = unique_seat_ids.filter(seat => !available_seat_ids.has(seat));

            throw new SeatConflictError("Some seats are not available.", unavailable_seats);
        }
        console.log("[reserveSeats] Seats are available.")

        // 3. Attempt to acquire locks for all seats. If any lock fails, release all locks and return failure response with conflicting seat ids.
        const redis_array = Array.from(unique_seat_ids).map((id) => seatLockFromId(id));
        const expiration_timestamp = Date.now() + (TTL_TIME_IN_SECONDS * 1000); // current time in seconds + TTL_TIME_IN_SECONDS seconds
        console.log("[reserveSeats] Attempting to acquire locks:", redis_array);

        const lua_result: string[] = await this.redis.eval(
            REDIS_LOCK_LUA_SCRIPT,
            unique_seat_ids.length,
            ...redis_array,
            user_uuid,
            String(expiration_timestamp)
        ) as string[];

        if (lua_result[0] === 'CONFLICT') {
            console.log('[reserveSeats] Failed to acquire locks for all seats.');
            const conflicting_seat_ids = lua_result.slice(1).map((key: string) => seatIdFromLock(key));

            throw new SeatConflictError("Some seats are not available.", conflicting_seat_ids);
        }

        // console.log("DEBUG: [reserveSeats] Checking current keys in Redis:");
        // await this.redis.keys('*').then((keys: string[]) => {
        //     console.log('All keys:', keys);
        // }).catch((err: any) => {
        //     console.error(err);
        // });

        // 4. Update all seats to RESERVED in DB
        console.log("[reserveSeats] Updating seat statuses to RESERVED in database.");
        const update_result = await this.prisma.seat.updateMany({
            where: {
                id: {
                    in: unique_seat_ids
                }
            },
            data: {
                seat_status: SeatStatus.RESERVED
            }
        })

        console.log("[reserveSeats] Database update result:", update_result);
        console.log("[reserveSeats] Seats are reserved");

        // 5. Enqueue BullMQ job to release locks and set seats back to AVAILABLE after expiration time
        console.log("[reserveSeats] Enqueuing job to release locks and reset seat statuses after expiration time.");
        const expire_seat_reservation_job = await this.reservation_queue.add(
            'expire_seat_reservation',
            { seat_ids: unique_seat_ids },
            {
                delay: TTL_TIME_IN_SECONDS * 1000, // delay in milliseconds
            }
        );
        console.log("[reserveSeats] Job enqueued.");

        // 6. Return reserved_seat_ids, expires_at, and reservation_token (NOT idempotency key, signed payload containing seat_ids and expiry)
        console.log("[reserveSeats] Generating reservation token to return.");

        const signable_payload = {
            redis_locks: redis_array,
            seat_ids: unique_seat_ids,
            expires_at: expiration_timestamp,
            user_uuid: user_uuid,
            expire_seat_job_id: expire_seat_reservation_job.id
        }
        const signed_token = jwt.sign(
            signable_payload,
            process.env.SIGNING_SECRET!,
            {
                expiresIn: TTL_TIME_IN_SECONDS
            }
        );

        return {
            reservation_token: signed_token,
            expires_at: expiration_timestamp,
            expires_at_string: new Date(expiration_timestamp).toISOString()
        }
    }

    async createPaymentIntent(reservation_token: string, user_uuid: string, idempotency_key: string, payment_method: PaymentMethodKey) {
        // validate input
        console.log('[createPaymentIntent] Validating input.')
        if (!reservation_token) {
            throw new ResourceNotFoundError("Invalid reservation token provided.")
        }
        if (!user_uuid) {
            throw new ResourceNotFoundError("Invalid user UUID provided.")
        }
        if (!idempotency_key) {
            throw new ResourceNotFoundError("Invalid idempotency key provided.")
        }
        if (!payment_method) {
            throw new ResourceNotFoundError("Invalid payment method provided.")
        }
        console.log('[createPaymentIntent] Validation successful for parameters.')

        // check if idempotency key exists (meaning order already created)
        // the same idempotency key is used in case of network error/5xx meaning the use-case is to be added to immediately subsequent requests
        // if idempotency key of EXPIRED/FAILED order is passed, this is a bug warranting an error
        // if PENDING/CONFIRMED the user can get the normal 200 response
        console.log(`[createPaymentIntent] Querying for existing idempotency key.`)
        const potential_order_status = await this.prisma.order.findUnique({
            where: {
                user_id: user_uuid,
                idempotency_key: idempotency_key
            },
            include: {
                stripe_payment_info: true
            }
        })
        console.log(`[createPaymentIntent] Found result:`, potential_order_status)

        if (potential_order_status?.order_status === OrderStatus.PENDING || potential_order_status?.order_status === OrderStatus.CONFIRMED) {
            return {
                client_secret: potential_order_status.stripe_payment_info.client_secret,
                order_id: potential_order_status.id
            }
        } else if (potential_order_status?.order_status === OrderStatus.EXPIRED) {
            // order expired/TTL passed. Lock exists but order failed.
            throw new ConflictError("New idempotency key is required.");
        } else if (potential_order_status?.order_status === OrderStatus.FAILED) {
            // order failed from failed payment. Allow check for new valid payment
            // THIS FLOW EXPECTS THAT A NEW IDEMPOTENCY KEY IS GENERATED
            // IN A FRONT-END THE IDEMPOTENCY KEY WOULD BE MADE BEFORE A NEW PAYMENT ATTEMPT, SO THIS IS A REASONABLE EXPECTATION
            console.log(`[createPaymentIntent] Order created, but payment failed. User still has lock. Need to create. Continuing...`);
        }
        else {
            console.log(`[createPaymentIntent] No Order exists. Need to create. Continuing...`);
        }

        // unsign reservation_token
        console.log('[createPaymentIntent] Retrieving payload from JWT reservation token.')
        let payload = null as SigningObject;
        try {
            payload = jwt.verify(reservation_token, process.env.SIGNING_SECRET!) as SigningObject;
            if (!payload || payload.user_uuid !== user_uuid) {
                throw new ForbiddenError("Reservation token is not associated with this User.");
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'TokenExpiredError') {
                console.log("Token has expired");
                throw new ForbiddenError("Token has expired.")
            } else {
                throw new ForbiddenError("Invalid Reservation Token.");
            }
        }
        console.log(`[createPaymentIntent] Retrieved payload:`, payload)

        // verify the redis locks on seat are owned by user
        console.log(`[createPaymentIntent] Verifying Redis locks on all seats tied to calling User`)
        const conflict_seat_ids = []
        for (const lock of payload.redis_locks) {
            const redis_key = await this.redis.get(lock);
            if (!redis_key || redis_key !== user_uuid) {
                conflict_seat_ids.push(seatIdFromLock(lock));
            }
        }
        if (conflict_seat_ids.length > 0) {
            throw new SeatConflictError("Temporary lock on some Seats have expired.", conflict_seat_ids)
        }
        console.log(`[createPaymentIntent] All Redis keys are valid`)

        // get total price from keys
        console.log(`[createPaymentIntent] Building billable price`)
        const requested_seats = await this.prisma.seat.findMany({
            where: {
                id: {
                    in: payload.seat_ids
                }
            }
        }) as Seat[];

        const total_price = requested_seats.reduce((sum, seat) => {
            return sum + seat.price;
        }, 0);

        // create payment intent
        //      call needs private key, price, currency, 
        //      optional: description, receipt email, statement description, 
        console.log(`[createPaymentIntent] Creating Payment Intent with payment method: ${getStripePaymentMethodFromEnum(payment_method)}`)

        let payment_intent: PaymentIntent;
        let payment_failed: Boolean = false;
        try {
            payment_intent = await stripe.paymentIntents.create({
                amount: total_price,
                currency: 'usd',
                // @TODO: make this description user-readable
                description: `seats: ${payload.seat_ids}`,
                metadata: {
                    // could just send reservation_token. Expiration is a problem howerver.
                    idempotency_key: idempotency_key,
                    user_uuid: user_uuid
                },
                statement_descriptor: 'ChitChief Seat Order',
                statement_descriptor_suffix: 'ChitChief',
                payment_method: getStripePaymentMethodFromEnum(payment_method),
                confirm: true,
                return_url: "https://devangray.dev/"
            }, {
                idempotencyKey: idempotency_key
            })
            console.log(`[createPaymentIntent] Payment Intent created:`, payment_intent);
        } catch (error) {
            console.log(`[createPaymentIntent] Payment failed.`);
            payment_failed = true;

            if (error instanceof Stripe.errors.StripeCardError) {
                // Catch StripeCardError to retrieve Payment Intent ID and Client Secret to create Order and StripePaymentInfo objects
                const raw = error.raw as { payment_intent?: { id?: string, client_secret?: string, latest_charge?: string } };
                
                payment_intent = {
                    id: raw.payment_intent?.id,
                    client_secret: raw.payment_intent?.client_secret,
                    latest_charge: raw.payment_intent?.latest_charge
                }
            } else {
                throw error;
            }
        }

        // create StripePaymentInfo
        if (!payment_intent.id || !payment_intent.client_secret) {
            throw new Error("Invalid payment intent.")
        }

        console.log(`[createPaymentIntent] Creating StripePaymentInfo object for PaymentIntent`);
        const create_stripe_payment_status = await this.prisma.stripePaymentInfo.create({
            data: {
                payment_intent_id: payment_intent.id,
                client_secret: payment_intent.client_secret ? payment_intent.client_secret : "No secret"
            }
        })
        console.log(`[createPaymentIntent] Created StripePaymentInfo:`, create_stripe_payment_status);

        // create Order
        console.log(`[createPaymentIntent] Creating Order object associated with tickets`);
        const create_order_status = await this.prisma.order.create({
            data: {
                user_id: user_uuid,
                order_status: OrderStatus.PENDING,
                idempotency_key: idempotency_key,
                stripe_payment_id: create_stripe_payment_status.id
            }
        });
        console.log(`[createPaymentIntent] Created order:`, create_order_status);

        // create OrderSeats
        console.log(`[createPaymentIntent] Creating OrderSeats objects for each Seat`);
        const created_order_id = create_order_status.id;
        const order_seats_data = requested_seats.map((seat) => {
            return {
                order_id: created_order_id,
                seat_id: seat.id,
                price_at_purchase: seat.price
            }
        });
        const create_order_seats_status = await this.prisma.orderSeats.createMany({
            data: order_seats_data
        })
        console.log(`[createPaymentIntent] Created OrderSeats:`, create_order_seats_status);

        // return client secret and order ID
        if (payment_failed) {
            // Realistically, this job would removed in case of successful confirmation from /ticekts/purchase/confirm connected to frontend
            // Set worker to update Order
            await this.reservation_queue.add(
                'expire_pending_order',
                { order_id: created_order_id },
                {
                    delay: TTL_TIME_IN_SECONDS * 1000 // delay in milliseconds
                }
            )

            console.log(`[createPaymentIntent] Payment failed. Throwing error.`);
            throw new Stripe.errors.StripeCardError({
                message: "Your card was declined.",
                type: "card_error",
                code: "card_declined",
                decline_code: "generic_decline",
                charge: payment_intent.latest_charge as string
            })
        }

        try {
            // upon successful job, the expire_seat_job no longer has to run
            await this.reservation_queue.remove(payload.expire_seat_job_id)
        } catch (error) {
            // if the job is not removed, the error will be caught in handleSuccess with a refund

            console.log(`[createPaymentIntent] Could not remove expire_seat_rservation job from queue.`);
        }
        return {
            client_secret: payment_intent.client_secret,
            order_id: created_order_id
        }
    }

    async confirmPayment(reservation_token: string, user_uuid: string, order_id: string) {

        // // validate params
        // console.log('[confirmPayment] Validating input.')
        // if (!reservation_token) {
        //     throw new ResourceNotFoundError("Invalid Reservation Token provided.");
        // }
        // if (!user_uuid) {
        //     throw new ResourceNotFoundError("Invalid User UUID provided.");
        // }
        // if (!order_id) {
        //     throw new ResourceNotFoundError("Invalid Order ID provided.");
        // }
        // console.log('[confirmPayment] Validation successful for parameters.')

        // // unsign reservation_token
        // console.log('[confirmPayment] Retrieving payload from JWT reservation token.')
        // let payload = null as SigningObject;
        // try {
        //     payload = jwt.verify(reservation_token, process.env.SIGNING_SECRET!) as SigningObject;
        //     if (!payload || payload.user_uuid !== user_uuid) {
        //         throw new ForbiddenError("Reservation token is not associated with this User.");
        //     }
        // } catch (error) {
        //     if (error instanceof Error && error.name === 'TokenExpiredError') {
        //         console.log("Token has expired");
        //         throw new ForbiddenError("Token has expired.")
        //     } else {
        //         throw new ForbiddenError("Invalid Reservation Token.");
        //     }
        // }
        // console.log(`[confirmPayment] Retrieved payload:`, payload);

        // // check redis lock
        // console.log(`[confirmPayment] Verifying Redis locks on all seats tied to calling User`)
        // const conflict_seat_ids = []
        // for (const lock of payload.redis_locks) {
        //     const redis_key = await this.redis.get(lock);
        //     if (!redis_key || redis_key !== user_uuid) {
        //         conflict_seat_ids.push(seatIdFromLock(lock));
        //     }
        // }
        // if (conflict_seat_ids.length > 0) {
        //     throw new SeatConflictError("Temporary lock on some Seats have expired.", conflict_seat_ids)
        // }
        // console.log(`[confirmPayment] All Redis keys are valid`)

        // // get payment intent id
        // console.log(`[confirmPayment] Finding Stripe Payment Info object associated with Order ID`)
        // // 1-to-1 between Order and StripePaymentInfo
        // const connected_order = await this.prisma.order.findUnique({
        //     where: {
        //         id: order_id
        //     },
        //     include: {
        //         stripe_payment_info: true
        //     }
        // })
        // if (!connected_order) {
        //     throw new ResourceNotFoundError("Order does not exist");
        // }
        // console.log(`[confirmPayment] Found Stripe Payment Info object:`, connected_order)

        // // confirm payment
        // console.log(`[confirmPayment] Confirming payment intent`)
        // // console.log("client_secret: ", connected_order.stripe_payment_info.client_secret);
        // // const stripe = Stripe(process.env.STRIPE_PUBLISHABLE_KEY!);
        // // const retrieved_payment_intent = await stripe.paymentIntents.retrieve(
        // //     connected_order.stripe_payment_info.payment_intent_id,
        // //     {
        // //         client_secret: connected_order.stripe_payment_info.client_secret,
        // //     }
        // // );
        // // console.log("retrieved_payment_intent", retrieved_payment_intent);
        // const stripe = Stripe(process.env.STRIPE_SECRET_KEY!)
        // const confirmed_payment_intent = await stripe.paymentIntents.confirm(
        //     connected_order.stripe_payment_info.payment_intent_id
        // )
        // console.log(`[confirmPayment] Confirmed payment intent:`, confirmed_payment_intent)

        // // update seats
        // // update orders
        // // return
        // return confirmed_payment_intent;
    }
}