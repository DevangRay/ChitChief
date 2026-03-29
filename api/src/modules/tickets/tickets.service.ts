import { Seat } from "@prisma/client"

type SuccessfulReservation = {
    success: true,
    reservation_token: string,
    expires_at: string
}

type FailedReservation = {
    success: false,
    conflict_seat_ids: Seat[]
}

type ReservationObject = SuccessfulReservation | FailedReservation

export class TicketService {
    constructor(private readonly redis: any, private readonly prisma: any) { }

    async reserveSeats(seats: Seat[], user: string): Promise<ReservationObject> {
        // 1. Get Order from DB for user. If no pending order exists, create one.
        let pending_order = await this.prisma.order.findMany({
            where: {
                user_id: user,
                order_status: 'PENDING'
            }
        });

        if (pending_order.length === 0) {
            console.log("No pending orders for user:", user);
            console.log("Creating a user order");

            pending_order = [await this.prisma.order.create({
                data: {
                    user_id: user,
                    order_status: 'PENDING',
                    idempotency_key: crypto.randomUUID()
                }
            })];

            console.log("Inserted order:");
            console.dir(pending_order);
        } else {
            console.log("Pending order already exists for user:", user);
            console.dir(pending_order);
        }

        // 2. Create OrderSeats for Order
        const order_seats_delete_status = await this.prisma.orderSeats.deleteMany({
            where: {
                order_id: pending_order[0].id
            }
        });
        console.log("OrderSeats delete status:");
        console.dir(order_seats_delete_status);

        const order_seats_create_status = await this.prisma.orderSeats.createMany({
            data: seats.map((seat) => ({
                order_id: pending_order[0].id,
                seat_id: seat.id,
                price_at_purchase: seat.price
            }))
        });
        console.log("OrderSeats create status:");
        console.dir(order_seats_create_status);

        let success = false;
        console.log("success: " + success)
        return success ? {
            success: true,
            reservation_token: 'reply === null. mykey | myvalue',
            expires_at: new Date(Date.now() + 60000).toISOString()
        } : {
            success: false,
            conflict_seat_ids: seats,
        }
    }

    async releaseReservation(seats: string[]) {
        throw new Error('Not implemented');
    }
}