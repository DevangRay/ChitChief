import { OrderStatus, PrismaClient, SeatStatus } from "@prisma/client"
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js"
import { formatSeats } from "../../lib/send-email.js";
import { Queue } from "bullmq"
import { type Redis } from "ioredis";
import Stripe from 'stripe';

export class WebhooksService {
    private readonly reservation_queue: Queue;
    constructor(private readonly prisma: PrismaClient, private readonly redis: Redis) {
        this.reservation_queue = new Queue('reservations', {
            connection: this.redis
        });
    }

    async handleSuccess(user_uuid: string | undefined, user_email: string | undefined, idempotency_key: string | undefined, payment_intent: string | undefined): Promise<void> {
        // validate parameters
        console.log('[handleSuccess] Validating input.')
        if (!user_uuid) {
            throw new ResourceNotFoundError("Invalid user UUID provided.")
        }
        if (!user_email) {
            throw new ResourceNotFoundError("Invalid user email provided.")
        }
        if (!idempotency_key) {
            throw new ResourceNotFoundError("Invalid idempotency key provided.")
        }
        if (!payment_intent) {
            throw new ResourceNotFoundError("Invalid payment intent provided.")
        }
        console.log('[handleSuccess] Validation successful for parameters.')

        // idempotent check
        const existing = await this.prisma.order.findUnique({
            where: {
                user_id: user_uuid,
                idempotency_key: idempotency_key
            }
        })
        if (existing?.order_status === OrderStatus.CONFIRMED || existing?.order_status === OrderStatus.FAILED) return; // already processed/reverted and refunded


        // update order_status in Order
        // idempotency key is unique
        console.log('[handleSuccess] Updating Order to Confirmed.')
        const completed_order = await this.prisma.order.update({
            where: {
                user_id: user_uuid,
                idempotency_key: idempotency_key,
                order_status: OrderStatus.PENDING
            },
            data: {
                order_status: OrderStatus.CONFIRMED
            }
        })
        console.log('[handleSuccess] Updated order to:', completed_order)

        // update seat-status in Seat
        console.log('[handleSuccess] Updating Seats to Sold.')
        const connected_seats = await this.prisma.orderSeats.findMany({
            where: {
                order_id: completed_order.id
            }
        });
        console.log('[handleSuccess] Connected seats:', connected_seats)

        const connected_seat_ids: string[] = connected_seats.map((order_seats) => order_seats.seat_id)
        console.log('[handleSuccess] Connected seat ids:', connected_seat_ids)

        const sold_seats = await this.prisma.seat.updateManyAndReturn({
            where: {
                id: {
                    in: connected_seat_ids
                },
                seat_status: SeatStatus.RESERVED
            },
            data: {
                seat_status: SeatStatus.SOLD
            }
        })

        if (sold_seats.length !== connected_seat_ids.length || (connected_seat_ids.length > 0 && !sold_seats[0]?.event_id)) {
            console.log('[handleSuccess] ERROR: Seats are in an invalid state. Reverting Order process.');
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
            const order_refund = await stripe.refunds.create({
                payment_intent: payment_intent
            })
            console.log('[handleSuccess] Refunded user payment:', order_refund);

            const order_revert = await this.prisma.order.update({
                where: {
                    id: completed_order.id
                },
                data: {
                    order_status: OrderStatus.FAILED
                }
            })
            console.log('[handleSuccess] Reverted order to:', order_revert);

            const seat_revert = await this.prisma.seat.updateMany({
                where: {
                    id: {
                        in: connected_seat_ids
                    }
                },
                data: {
                    seat_status: SeatStatus.AVAILABLE
                }
            })
            console.log('[handleSuccess] Reverted seats to:', seat_revert);

            console.log('[handleSuccess] Reverts completed.')
            return;
        }

        console.log('[handleSuccess] Updated Seats to:', sold_seats)
        const ordered_seats = sold_seats.map((seat) => formatSeats(seat.row, seat.number))

        // // TEST SECTION
        // console.log("[handleSuccess] TEST: adding reset successful order job")
        // await this.reservation_queue.add(
        //     'reset_successful_orders',
        //     { order_id: completed_order.id },
        //     {
        //         delay: 15 * 1000, //delay in milliseconds
        //     }
        // );
        // console.log("[handleSuccess] TEST: Job enqueued.")

        console.log("[handleSuccess] Adding job to send status email")
        const associated_event = await this.prisma.event.findUnique({
            where: {
                id: sold_seats[0]?.event_id!
            }
        })
        console.log("[handleSuccess] Retrieved associated_event:", associated_event);


        await this.reservation_queue.add(
            'send_success_message',
            {
                email_target: user_email,
                order_id: completed_order.id,
                event_name: `"${associated_event?.name}: ${associated_event?.description}"`,
                seats: ordered_seats
            },
            {
                delay: 0, //delay in milliseconds
            }
        );
        console.log("[handleSuccess] Job enqueued.")
    }

    async handleFailure(user_uuid: string | undefined, user_email: string | undefined, idempotency_key: string | undefined): Promise<void> {
        // validate parameters
        console.log('[handleFailure] Validating input.')
        if (!user_uuid) {
            throw new ResourceNotFoundError("Invalid user UUID provided.")
        }
        if (!user_email) {
            throw new ResourceNotFoundError("Invalid user email provided.")
        }
        if (!idempotency_key) {
            throw new ResourceNotFoundError("Invalid idempotency key provided.")
        }
        console.log('[handleFailure] Validation successful for parameters.')

        // idempotent check  
        const existing = await this.prisma.order.findUnique({
            where: { user_id: user_uuid, idempotency_key: idempotency_key }
        })
        if (existing?.order_status === OrderStatus.FAILED) return; // already processed


        // update order_status in Order
        console.log('[handleFailure] Updating Order to Failed.')
        const expired_order = await this.prisma.order.update({
            where: {
                user_id: user_uuid,
                idempotency_key: idempotency_key,
            },
            data: {
                order_status: OrderStatus.FAILED
            }
        })
        console.log('[handleFailure] Updated order to:', expired_order)
        // Only the update needs to be updated. The BullMQ job will update seats once the TTL expires, or the user has a chance to resubmit a payment

        // Enqueue job to notify user
        console.log("[handleFailure] Adding job to send status email")
        const order_seats_join_object = await this.prisma.orderSeats.findMany({
            where: {
                order_id: expired_order.id
            },
            include: {
                seat: {
                    include: {
                        event: true
                    }
                }
            }
        })
        console.log("[handleFailure] Retrieved orderSeats:", order_seats_join_object)
        const ordered_seats = order_seats_join_object.map((seat_order) => formatSeats(seat_order.seat.row, seat_order.seat.number))

        await this.reservation_queue.add(
            'send_failure_message',
            {
                email_target: user_email,
                order_id: expired_order.id,
                event_name: `"${order_seats_join_object[0]?.seat.event.name}: ${order_seats_join_object[0]?.seat.event.description}"`,
                seats: ordered_seats
            },
            {
                delay: 0, //delay in milliseconds
            }
        );
        console.log("[handleFailure] Job enqueued.")
    }
}