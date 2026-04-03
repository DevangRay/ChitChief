import { PrismaClient, Seat, SeatStatus } from "@prisma/client"
import { Queue } from "bullmq"
import * as jwt from 'jsonwebtoken';
import Redis from "ioredis";
import { seatIdFromLock, seatLockFromId } from "../../lib/redis-keys";

type SuccessfulReservation = {
    success: true,
    reservation_token: string,
    expires_at: number,
    expires_at_string: string
}

type FailedReservation = {
    success: false,
    conflict_seat_ids: string[]
}

type ReservationObject = SuccessfulReservation | FailedReservation

/*
TODO:
    * Extract steps to helper functions
    * Add support for return code: 500/404/409
*/


const TTL_TIME_IN_SECONDS = 10;

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

    async reserveSeats(seats: string[], user: string): Promise<ReservationObject> {
        // 1. Validate seats and user
        console.log("[reserveSeats] Validating seats and user parameters.");
        if (!seats || seats.length === 0 || seats.length > 10) {
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

        const unique_seat_ids = [...new Set(seats)];
        if (unique_seat_ids.length !== seats.length) {
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
                    in: unique_seat_ids
                },
                seat_status: SeatStatus.AVAILABLE
            }
        });

        if (seat_statuses.length !== seats.length) {
            console.log("[reserveSeats] Some seats are not available.");

            const available_seat_ids = new Set(seat_statuses.map((s: Seat) => s.id));
            const unavailable_seats = seats.filter(seat => !available_seat_ids.has(seat));
            return {
                success: false,
                conflict_seat_ids: unavailable_seats
            }
        }
        console.log("[reserveSeats] Seats are available.")

        // 3. Attempt to acquire locks for all seats. If any lock fails, release all locks and return failure response with conflicting seat ids.
        const array = Array.from(unique_seat_ids).map((id) => seatLockFromId(id));
        const expiration_timestamp = Date.now() + (TTL_TIME_IN_SECONDS * 1000); // current time in seconds + TTL_TIME_IN_SECONDS seconds
        console.log("[reserveSeats] Attempting to acquire locks for seats:", array);

        const lua_result: string[] = await this.redis.eval(
            REDIS_LOCK_LUA_SCRIPT,
            unique_seat_ids.length,
            ...array,
            user,
            String(expiration_timestamp)
        ) as string[];

        if (lua_result[0] === 'CONFLICT') {
            console.log('[reserveSeats] Failed to acquire locks for all seats.');
            const conflicting_seat_ids = lua_result.slice(1).map((key: string) => seatIdFromLock(key));

            return {
                success: false,
                conflict_seat_ids: conflicting_seat_ids
            }
        }

        console.log("DEBUG: [reserveSeats] Checking current keys in Redis:");
        await this.redis.keys('*').then((keys: string[]) => {
            console.log('All keys:', keys);
        }).catch((err: any) => {
            console.error(err);
        });

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
        await this.reservation_queue.add(
            'expire_seat_reservation',
            { seat_ids: seats },
            {
                delay: TTL_TIME_IN_SECONDS * 1000, // delay in milliseconds
            }
        );
        console.log("[reserveSeats] Job enqueued.");

        // 6. Return reserved_seat_ids, expires_at, and reservation_token (NOT idempotency key, signed payload containing seat_ids and expiry)
        console.log("[reserveSeats] Generating reservation token to return.");

        const signable_payload = {
            seat_ids: seats,
            expires_at: expiration_timestamp,
            user_uuid: user
        }
        const signed_token = jwt.sign(
            signable_payload,
            process.env.SIGNING_SECRET!,
            {
                // expires in TTL_TIME_IN_SECONDS seconds
                expiresIn: TTL_TIME_IN_SECONDS
            }
        );

        return {
            success: true,
            reservation_token: signed_token,
            expires_at: expiration_timestamp,
            expires_at_string: new Date(expiration_timestamp).toISOString()
        }
    }
}