import { OrderStatus, PrismaClient, SeatStatus } from "@prisma/client"
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError"
import { Queue } from "bullmq"
import Redis from "ioredis";

export class WebhooksService {
    private readonly test_reservation_queue: Queue;
    constructor(private readonly prisma: PrismaClient, private readonly redis: Redis) {
        this.test_reservation_queue = new Queue('reservations', {
            connection: this.redis
        });
    }

    async handleSuccess(user_uuid: string | undefined, idempotency_key: string | undefined): Promise<void> {
        // validate parameters
        console.log('[handleSuccess] Validating input.')
        if (!user_uuid) {
            throw new ResourceNotFoundError("Invalid user UUID provided.")
        }
        if (!idempotency_key) {
            throw new ResourceNotFoundError("Invalid idempotency key provided.")
        }
        console.log('[handleSuccess] Validation successful for parameters.')

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
        console.log('[handleSuccess] Updated Seats to:', sold_seats)

        // TEST SECTION
        console.log("[handleSuccess] TEST: adding reset successful order job")
        await this.test_reservation_queue.add(
            'reset_successful_orders',
            { order_id: completed_order.id },
            {
                delay: 15 * 1000, //delay in milliseconds
            }
        );
        console.log("[handleSuccess] TEST: Job enqueued.")
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
        console.log(user_uuid)
        console.log(idempotency_key)
        console.log('[handleFailure] Validation successful for parameters.')

        // update order_status in Order
        console.log('[handleFailure] Updating Order to Expired.')
        const expired_order = await this.prisma.order.update({
            where: {
                user_id: user_uuid,
                idempotency_key: idempotency_key,
                order_status: OrderStatus.PENDING
            },
            data: {
                order_status: OrderStatus.EXPIRED
            }
        })
        console.log(expired_order)
        console.log('[handleFailure] Updated order to:', expired_order)

        // update seat_status in Seat
        console.log('[handleFailure] Updating Seats to Available.')
        const connected_seats = await this.prisma.orderSeats.findMany({
            where: {
                order_id: expired_order.id
            }
        });
        console.log('[handleFailure] Connected seats:', connected_seats)

        const connected_seat_ids: string[] = connected_seats.map((order_seats) => order_seats.seat_id)
        console.log('[handleFailure] Connected seat ids:', connected_seat_ids)

        const available_seats = await this.prisma.seat.updateMany({
            where: {
                id: {
                    in: connected_seat_ids
                },
                seat_status: SeatStatus.RESERVED
            },
            data: {
                seat_status: SeatStatus.AVAILABLE
            }
        })
        console.log('[handleFailure] Updated Seats to:', available_seats)

        // TODO: enqueue follow-up job (e.g. notify user, cleanup)
    }
}