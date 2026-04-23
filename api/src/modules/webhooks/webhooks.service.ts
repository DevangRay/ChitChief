import { OrderStatus, PrismaClient, SeatStatus } from "@prisma/client"
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError"
import { Queue } from "bullmq"
import Redis from "ioredis";
import Stripe from 'stripe';

export class WebhooksService {
    private readonly test_reservation_queue: Queue;
    constructor(private readonly prisma: PrismaClient, private readonly redis: Redis) {
        this.test_reservation_queue = new Queue('reservations', {
            connection: this.redis
        });
    }

    async handleSuccess(user_uuid: string | undefined, idempotency_key: string | undefined, payment_intent: string | undefined): Promise<void> {
        // validate parameters
        console.log('[handleSuccess] Validating input.')
        if (!user_uuid) {
            throw new ResourceNotFoundError("Invalid user UUID provided.")
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

        const sold_seats = await this.prisma.seat.updateMany({
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

        if (sold_seats.count !== connected_seat_ids.length) {
            console.log('[handleSuccess] ERROR: Seats are in an invalid state. Reverting Order process.');
            const stripe = Stripe(process.env.STRIPE_SECRET_KEY!)
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
    }

    async handleFailure(user_uuid: string | undefined, idempotency_key: string | undefined): Promise<void> {
        // validate parameters
        console.log('[handleFailure] Validating input.')
        if (!user_uuid) {
            throw new ResourceNotFoundError("Invalid user UUID provided.")
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
        console.log('[handleFailure] Updating Order to Expired.')
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

        // TODO: enqueue follow-up job (e.g. notify user, cleanup)
    }
}