import { Seat, SeatStatus } from "@prisma/client"

type SuccessfulReservation = {
    success: true,
    reservation_token: string,
    expires_at: number,
    expires_at_string: string
}

type FailedReservation = {
    success: false,
    conflict_seat_ids: Seat[]
}

type ReservationObject = SuccessfulReservation | FailedReservation


export class TicketService {
    constructor(private readonly redis: any, private readonly prisma: any, private readonly jwt: any) { }

    async reserveSeats(seats: Seat[], user: string): Promise<ReservationObject> {
        // 1. Validate seats and user
        console.log("[reserveSeats] Validating seats and user parameters.");
        if (seats.length === 0 || seats.length > 10) {
            console.log("[reserveSeats] Invalid number of seats provided for reservation.");
            return {
                success: false,
                conflict_seat_ids: []
            };
        }
        if (!user) {
            console.log("[reserveSeats] No user provided for reservation.");
            return {
                success: false,
                conflict_seat_ids: []
            };
        }

        for (const seat of seats) {
            if (!seat.id || !seat.price) {
                console.log("[reserveSeats] Invalid seat object provided:", seat);
                return {
                    success: false,
                    conflict_seat_ids: []
                };
            }
        }

        const unique_seat_ids = new Set(seats.map(seat => seat.id));
        if (unique_seat_ids.size !== seats.length) {
            console.log("[reserveSeats] Duplicate seat ids provided in reservation request.");
            return {
                success: false,
                conflict_seat_ids: []
            };
        }
        console.log("[reserveSeats] Validation successful for seats and user.");

        // 2. Check seats are available and not sold in DB
        console.log("[reserveSeats] Checking seat availability in database for seat ids:");
        const seat_statuses = await this.prisma.seat.findMany({
            where: {
                id: {
                    in: [...unique_seat_ids]
                },
                seat_status: SeatStatus.AVAILABLE
            }
        });

        if (seat_statuses.length !== seats.length) {
            console.log("[reserveSeats] Some seats are not available.");

            const available_seat_ids = new Set(seat_statuses.map((s: Seat) => s.id));
            const unavailable_seats = seats.filter(seat => !available_seat_ids.has(seat.id));
            return {
                success: false,
                conflict_seat_ids: unavailable_seats
            }
        }
        console.log("[reserveSeats] Seats are available.")

        // 3. Attempt to acquire locks for all seats. If any lock fails, release all locks and return failure response with conflicting seat ids.
        const array = seats.map((seat) => `seat_lock_${seat.id}`);
        const expiration_timestamp = Date.now() + 60000; // current time in seconds + 60 seconds
        console.log("[reserveSeats] Attempting to acquire locks for seats:", array);

        console.log("CALLING WATCH")
        await this.redis.watch(array);
        console.log("CALLED WATCH")
        let multi_chain = this.redis.multi();
        for (const key of array) {
            multi_chain = multi_chain.set(key, user, 'NX', 'PXAT', expiration_timestamp);
        }
        const return_value: [Error | null, string | null][] = await multi_chain.exec();

        // console.log("DEBUG: [reserveSeats] Checking current keys in Redis:");
        // await this.redis.keys('*').then((keys: string[]) => {
        //     console.log('All keys:', keys);
        // }).catch((err: any) => {
        //     console.error(err);
        // });

        console.log("[reserveSeats] Return value from Redis EXEC command:", return_value);
        if (return_value === null) {
            console.log("[reserveSeats] Watched key was externally modified between WATCH and EXEC. Returning failure.");
            return {
                success: false,
                conflict_seat_ids: seats,
            };
        }

        const conflicting_seats: Seat[] = [];
        const accepted_seat_ids: string[] = [];

        for (let i = 0; i < return_value.length; i++) {
            if (return_value[i] === null || return_value[i]![0] !== null || return_value[i]![1] !== 'OK') {
                console.log("[reserveSeats] Failed to acquire lock for key with index:", i, "Result:", return_value[i], "Seat ID:", seats[i]!.id);
                conflicting_seats.push(seats[i]!);
            } else {
                console.log("[reserveSeats] Successfully acquired lock for key with index:", i, "and Seat ID:", seats[i]!.id);
                accepted_seat_ids.push(array[i]!);
            }
        }
        if (conflicting_seats.length > 0) {
            console.log("[reserveSeats] Failed to acquire locks for all keys. Conflicting seat ids:", conflicting_seats.join(', '));
            if (accepted_seat_ids.length > 0) {
                console.log("[reserveSeats] Releasing locks for accepted seat ids:", accepted_seat_ids.join(', '));
                await this.redis.del(accepted_seat_ids);
            } else {
                console.log("[reserveSeats] No locks were acquired, so no locks to release.");
            }

            return {
                success: false,
                conflict_seat_ids: conflicting_seats
            }
        } else {
            console.log("[reserveSeats] Successfully acquired locks for all keys.");
        }

        // 4. Update all seats to RESERVED in DB
        console.log("[reserveSeats] Updating seat statuses to RESERVED in database.");
        const update_result = await this.prisma.seat.updateMany({
            where: {
                id: {
                    in: [...unique_seat_ids]
                }
            },
            data: {
                seat_status: SeatStatus.RESERVED
            }
        })

        console.log("[reserveSeats] Database update result:", update_result);
        console.log("[reserveSeats] Seats are reserved");

        // 5. Enqueue BullMQ job to release locks and set seats back to AVAILABLE after expiration time

        // 6. Return reserved_seat_ids, expires_at, and reservation_token (NOT idempotency key, signed payload containing seat_ids and expiry)
        console.log("[reserveSeats] Generating reservation token to return.");

        const signable_payload = {
            seat_ids: seats.map(seat => seat.id),
            expires_at: expiration_timestamp,
            user_uuid: user
        }
        const signed_token = this.jwt.sign(
            signable_payload,
            "supe#$%#$rwdfas3423oi4uoq3iueoq3u4o2i3u4o23u4oq3iu4o2u3oupoiwaudiasduhfiasuhfi23u4hi23u4h2i3hri23uhdrsecret",
            {
                expiresIn: 60
            }
        );

        return {
            success: true,
            reservation_token: signed_token,
            expires_at: expiration_timestamp,
            expires_at_string: new Date(expiration_timestamp).toString()
        }
    }
}