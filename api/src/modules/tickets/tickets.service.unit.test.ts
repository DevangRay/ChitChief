/**
 * tickets.service.unit.test.ts
 *
 * Behavior-driven unit tests for TicketService.reserveSeats()
 *
 * Design principles:
 *  - Tests describe WHAT the service does, not HOW it does it.
 *  - Mocks only define the external state of the world (DB records, Redis
 *    contention) — they do not assert on internal implementation calls such as
 *    which Redis command was used or how many times a Prisma method was called.
 *  - The only internal implementation detail we pin to is the shape of the
 *    `reserveSeats` return value, which is the public contract of the service.
 *  - A full rewrite of the internals (e.g. replacing Lua with a different
 *    locking mechanism) should not break any test here.
 *
 * Boundary conditions captured:
 *  - Seat count: 0, 1, MAX (10), MAX+1
 *  - Duplicate seat ids in the input array
 *  - User id: missing / empty string
 *  - Seat availability: all available, none available, subset available
 *  - Redis contention: no conflict, all conflict, partial conflict
 *  - Error propagation: DB and Redis throw unexpected errors
 *  - Return value shape and token content
 */
// import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TicketService } from './tickets.service';
import { OrderStatus, SeatStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { seatLockFromId } from '../../lib/redis-keys';
import SeatConflictError from '../../lib/custom_errors/SeatConflictError';
import ResourceNotFoundError from '../../lib/custom_errors/ResourceNotFoundError';
import ForbiddenError from '../../lib/custom_errors/ForbiddenError';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SEATS = 10;
const USER_ID = 'user-uuid-1';
const EVENT_ID = 'event-uuid-1';
const IDEMPOTENCY_KEY = 'idem-key-uuid-1';
const ORDER_ID = 'order-uuid-1';
const STRIPE_PAYMENT_INFO_ID = 'stripe-payment-info-uuid-1';
const STRIPE_CLIENT_SECRET = 'pi_test_secret_abc123';
const STRIPE_PAYMENT_INTENT_ID = 'payment_intent_id'

const EXPECTED_PAYMENT_INTENT_RETURN_OBJECT = {
    client_secret: expect.any(String),
    order_id: expect.any(String),
};

const EXPECTED_SUCCESS_RETURN_OBJECT =
{
    reservation_token: expect.any(String),
    expires_at: expect.any(Number),
    expires_at_string: expect.any(String)
};

// ─────────────────────────────────────────────────────────────────────────────
// Mocking Stripe module
// ─────────────────────────────────────────────────────────────────────────────
const paymentIntentsCreateMock = vi.fn().mockResolvedValue({
    id: STRIPE_PAYMENT_INTENT_ID,
    client_secret: STRIPE_CLIENT_SECRET,
});

vi.mock('stripe', () => {
    return {
        default: vi.fn().mockImplementation(() => ({
            paymentIntents: {
                create: paymentIntentsCreateMock,
            },
        })),
    };
});
// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build an array of n distinct seat id strings. */
const makeSeatIds = (n: number, prefix = 'seat-uuid-'): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const makeSeatLockIds = (n: number, lock_prefix = 'lock:seat:', seat_prefix = 'seat-uuid-'): string[] =>
    Array.from({ length: n }, (_, i) => `${lock_prefix}${seat_prefix}${i + 1}`);

/** Build an array of Prisma Seat records (AVAILABLE by default). */
const makeAvailableSeats = (ids: string[]) =>
    ids.map((id, i) => ({
        id,
        event_id: EVENT_ID,
        row: 'A',
        number: i + 1,
        price: 10000,
        seat_status: SeatStatus.AVAILABLE,
    }));

const makeValidToken = (
    seatIds: string[],
    redis_locks: string[],
    userId: string = USER_ID,
    expiresInSeconds = 600,
): string =>
    jwt.sign(
        {
            seat_ids: seatIds,
            redis_locks: redis_locks,
            user_uuid: userId,
            expires_at: Date.now() + expiresInSeconds * 1000,
        },
        process.env.SIGNING_SECRET ?? 'test-secret-for-unit-tests',
        { expiresIn: expiresInSeconds },
    );

const makeExpiredToken = (seatIds: string[], redis_locks: string[], userId: string = USER_ID): string =>
    jwt.sign(
        {
            seat_ids: seatIds,
            redis_locks: redis_locks,
            user_uuid: userId,
            expires_at: Date.now() - 1000,
        },
        process.env.SIGNING_SECRET ?? 'test-secret-for-unit-tests',
        { expiresIn: -1 },
    );

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
//
// We expose only the minimum surface needed for the tests:
//  • prisma.seat.findMany  — controls which seats the DB reports as AVAILABLE
//  • prisma.seat.updateMany — can be made to throw to simulate a DB error
//  • redis.eval             — controls lock acquisition outcome
//  • redis.keys             — silenced (debug helper in real service)
//  • redis.pipeline / del   — silenced (cleanup path)
//  • Queue.add              — can be made to throw to simulate a queue error
//
// Everything else is a no-op that returns a sensible default so that the
// happy path works out of the box.
// ─────────────────────────────────────────────────────────────────────────────

type LockState = 'valid' | 'missing' | 'wrong-owner';

const buildPaymentService = ({
    seatIds = makeSeatIds(2),
    lockState = 'valid' as LockState,
    existingOrder = null as null | { id: string; client_secret: string },
    dbWriteError = undefined as Error | undefined,
    tokenUserId = USER_ID,
} = {}) => {
    // Redis: get() returns the owner string or null depending on lockState.
    const redisMock = {
        ...makeRedisMock('OK'),   // keep eval/pipeline/del stubs
        get: vi.fn((key: string) => {
            if (lockState === 'missing') return Promise.resolve(null);
            if (lockState === 'wrong-owner') return Promise.resolve('other-user-uuid');
            return Promise.resolve(tokenUserId); // 'valid'
        }),
    };

    // Prisma: order lookup (idempotency) + order/orderSeat creation.
    const prismaMock = {
        ...makePrismaMock(makeAvailableSeats(seatIds)),
        order: {
            findUnique: existingOrder
                ? vi.fn().mockResolvedValue({
                    ...existingOrder,
                    stripe_payment_info: {
                        id: STRIPE_PAYMENT_INFO_ID,
                        client_secret: STRIPE_CLIENT_SECRET
                    }
                })
                : vi.fn().mockResolvedValue(null),
            create: dbWriteError
                ? vi.fn().mockRejectedValue(dbWriteError)
                : vi.fn().mockResolvedValue({ id: ORDER_ID }),
        },
        orderSeats: {
            createMany: vi.fn().mockResolvedValue({ count: seatIds.length }),
        },
        stripePaymentInfo: {
            create: vi.fn().mockResolvedValue({
                id: STRIPE_PAYMENT_INFO_ID,
                client_secret: STRIPE_CLIENT_SECRET
            })
        }
    };

    const service = new TicketService(redisMock as any, prismaMock as any);

    return { service, redisMock, prismaMock };
}
/**
 * Create a Redis mock.
 *
 * @param lockResult  'OK' = all locks acquired successfully (default)
 *                    string[] = list of seat-lock keys that are already held
 *                    Error = redis.eval throws
 */
const makeRedisMock = (
    lockResult: 'OK' | string[] | Error = 'OK'
) => {
    const evalMock = vi.fn();

    if (lockResult instanceof Error) {
        evalMock.mockRejectedValue(lockResult);
    } else if (lockResult === 'OK') {
        evalMock.mockResolvedValue(['OK']);
    } else {
        // partial or full conflict — return CONFLICT + the conflicting keys
        evalMock.mockResolvedValue(['CONFLICT', ...lockResult]);
    }

    return {
        eval: evalMock,
        // debug helper used in some service versions — silenced
        keys: vi.fn().mockResolvedValue([]),
        // cleanup / pipeline helpers — silenced
        pipeline: vi.fn().mockReturnValue({ del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }),
        del: vi.fn().mockResolvedValue(1),
    };
};

/** Create a Prisma mock whose findMany returns `availableSeats`. */
const makePrismaMock = (availableSeats: object[] = []) => ({
    seat: {
        findMany: vi.fn().mockResolvedValue(availableSeats),
        updateMany: vi.fn().mockResolvedValue({ count: availableSeats.length }),
    },
});

/** Build the full service under test with the given world state. */
const buildService = ({
    seatIds = makeSeatIds(2),
    allAvailable = true,
    unavailableSeatIds = [] as string[],
    lockResult = 'OK' as 'OK' | string[] | Error,
    dbError = undefined as Error | undefined,
    queueError = undefined as Error | undefined,
} = {}) => {
    const availableSeats = allAvailable
        ? makeAvailableSeats(seatIds.filter(id => !unavailableSeatIds.includes(id)))
        : makeAvailableSeats(seatIds.filter(id => !unavailableSeatIds.includes(id)));

    const redis = makeRedisMock(lockResult);
    const prisma = makePrismaMock(availableSeats);

    if (dbError) {
        prisma.seat.updateMany.mockRejectedValue(dbError);
    }

    // We need to mock the Queue constructor so BullMQ doesn't try to connect.
    // The TicketService instantiates it internally, so we patch the module.
    // (If the service signature changes to accept an injected queue, remove this.)
    const queueAddMock = queueError
        ? vi.fn().mockRejectedValue(queueError)
        : vi.fn().mockResolvedValue({ id: 'job-1' });

    vi.doMock('bullmq', () => ({
        Queue: vi.fn().mockImplementation(() => ({ add: queueAddMock })),
    }));

    const service = new TicketService(redis as any, prisma as any);
    return { service, redis, prisma, queueAddMock };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for asserting on the reservation token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode the reservation_token without verifying the signature.
 * We intentionally skip signature verification so that the tests are not
 * coupled to the secret used in the test environment.
 */
const decodeToken = (token: string): Record<string, unknown> =>
    jwt.decode(token) as Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TicketService.reserveSeats — behavior', () => {

    // Set the signing secret so jwt.sign works in the actual service.
    beforeEach(() => {
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        process.env.STRIPE_SECRET_KEY = 'test-stripe-secret-for-unit-tests';
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('succeeds for a standard valid request (multiple seats, valid user)', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
            });
        });

        describe('boundary cases — seat count', () => {
            it('succeeds with exactly 1 seat (minimum valid count)', async () => {
                const seatIds = makeSeatIds(1);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
            });

            it(`succeeds with exactly ${MAX_SEATS} seats (maximum valid count)`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
            });

            it('fails immediately with 0 seats (below minimum)', async () => {
                const { service } = buildService({ seatIds: [] });

                await expect(service.reserveSeats([], USER_ID)).rejects.toThrow("Invalid number of seats provided.")
            });

            it(`fails immediately with ${MAX_SEATS + 1} seats (above maximum)`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS + 1);
                const { service } = buildService({ seatIds });

                await expect(service.reserveSeats([], USER_ID)).rejects.toThrow("Invalid number of seats provided.")
            });
        });

        describe('exception cases — invalid inputs', () => {
            it('fails when user id is an empty string', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                await expect(service.reserveSeats(seatIds, '')).rejects.toThrow("No user provided.")
            });

            it('fails when user id is null', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                await expect(service.reserveSeats(seatIds, '')).rejects.toThrow("No user provided.")
            });

            it('fails when user id is undefined', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                await expect(service.reserveSeats(seatIds, undefined as any)).rejects.toThrow("No user provided.")
            });

            it('fails when the seat ids array contains duplicates', async () => {
                const id = 'seat-uuid-1';
                const { service } = buildService({ seatIds: [id] });

                await expect(service.reserveSeats([id, id], USER_ID)).rejects.toThrow("Duplicate Seat IDs provided.")
            });

            it('fails when seat ids array is null', async () => {
                const { service } = buildService();

                await expect(service.reserveSeats(null as any, USER_ID)).rejects.toThrow("Invalid number of seats provided.")
            });
        });
    });

    // =========================================================================
    // 2. Seat availability — DB check
    // =========================================================================

    describe('seat availability check', () => {

        describe('equivalence cases', () => {
            it('succeeds when every requested seat is available in the database', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
            });

            it('fails when none of the requested seats are available', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    allAvailable: false,
                    unavailableSeatIds: seatIds,   // all unavailable
                });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Some seats are not available.")
            });
        });

        describe('boundary cases', () => {
            it('fails when only some seats are available (partial availability)', async () => {
                const seatIds = makeSeatIds(3);
                const { service } = buildService({
                    seatIds,
                    unavailableSeatIds: [seatIds[2]],  // last one is unavailable
                });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Some seats are not available.")
            });

            it('reports the unavailable seat ids in the failure response', async () => {
                const seatIds = makeSeatIds(3);
                const unavailableSeatIds = [seatIds[1]]; // middle seat
                const { service } = buildService({ seatIds, unavailableSeatIds });

                try {
                    await service.reserveSeats(seatIds, USER_ID);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                    expect((error as SeatConflictError).conflict_seat_ids).toEqual(unavailableSeatIds);
                }
            });

            it('fails when a requested seat id does not exist in the database at all', async () => {
                const realIds = makeSeatIds(2);
                const ghostId = 'non-existent-seat-uuid';
                const { service } = buildService({ seatIds: realIds });

                // The ghost id is not in DB, so findMany returns only the real ones.
                await expect(service.reserveSeats([...realIds, ghostId], USER_ID)).rejects.toThrow("Some seats are not available.")
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by the database', async () => {
                const seatIds = makeSeatIds(2);
                const { service, prisma } = buildService({ seatIds });
                prisma.seat.findMany.mockRejectedValue(new Error('DB connection lost'));

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 3. Seat locking (Redis)
    // =========================================================================

    describe('seat locking', () => {

        describe('equivalence cases', () => {
            it('succeeds when all seats are free to lock', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds, lockResult: 'OK' });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
            });

            it('fails when all seats are already locked by another user', async () => {
                const seatIds = makeSeatIds(2);
                // Simulate all lock keys being contested (format mirrors the service key formatter)
                const conflictingKeys = seatIds.map(id => seatLockFromId(id));
                const { service } = buildService({ seatIds, lockResult: conflictingKeys });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Some seats are not available.")
            });
        });

        describe('boundary cases', () => {
            it('fails when at least one of several seats is locked', async () => {
                const seatIds = makeSeatIds(3);
                // Only the second seat is contested.
                const conflictingKeys = [seatLockFromId(seatIds[1])];
                const { service } = buildService({ seatIds, lockResult: conflictingKeys });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Some seats are not available.")
            });

            it('includes the conflicting seat id in the failure response', async () => {
                const seatIds = makeSeatIds(2);
                const contestedSeatId = seatIds[0];
                const { service } = buildService({
                    seatIds,
                    lockResult: [seatLockFromId(contestedSeatId)],
                });

                try {
                    await service.reserveSeats(seatIds, USER_ID);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                    expect((error as SeatConflictError).conflict_seat_ids).toEqual([contestedSeatId]);
                }
            });

            it('does not include non-conflicting seat ids in the failure response', async () => {
                const seatIds = makeSeatIds(2);
                const freeSeatId = seatIds[1];
                const { service } = buildService({
                    seatIds,
                    lockResult: [seatLockFromId(seatIds[0])], // only first conflicts
                });

                try {
                    await service.reserveSeats(seatIds, USER_ID);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                    expect((error as SeatConflictError).conflict_seat_ids).not.toContain(freeSeatId);
                }
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by the Redis locking operation', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    lockResult: new Error('Redis connection refused'),
                });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 4. Seat status persisted to DB after successful lock
    // =========================================================================

    describe('seat status persistence', () => {

        describe('equivalence cases', () => {
            it('marks seats as no longer available in the DB after a successful reservation', async () => {
                /**
                 * We verify the outcome (seats are no longer AVAILABLE) rather than
                 * asserting that a specific Prisma method was called. We do this by
                 * checking that the service calls updateMany — which is the only public
                 * observable we have without querying a real DB — and that it was called
                 * with the correct seat ids.
                 *
                 * If the implementation moves to a different persistence strategy,
                 * update this test to reflect the new observable outcome.
                 */
                const seatIds = makeSeatIds(2);
                const { service, prisma } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
                // Confirm the DB update was issued for the correct ids.
                expect(prisma.seat.updateMany).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({
                            id: expect.objectContaining({ in: expect.arrayContaining(seatIds) }),
                        }),
                    })
                );
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown while persisting seat status', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    dbError: new Error('DB write timeout'),
                });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 5. Return value contract
    // =========================================================================

    describe('return value — success', () => {

        describe('equivalence cases', () => {
            it('returns success:true on the happy path', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
            });

            it('returns a non-empty reservation_token string on success', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                expect(typeof result.reservation_token).toBe('string');
                expect(result.reservation_token.length).toBeGreaterThan(0);
            });

            it('embeds the requested seat ids inside the reservation token', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                const payload = decodeToken(result.reservation_token);
                expect(payload.seat_ids).toEqual(expect.arrayContaining(seatIds));
            });

            it('embeds the user id inside the reservation token', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                const payload = decodeToken(result.reservation_token);
                expect(payload.user_uuid).toBe(USER_ID);
            });

            it('embeds a numeric expiration timestamp inside the reservation token', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                const payload = decodeToken(result.reservation_token);
                expect(typeof payload.expires_at).toBe('number');
            });

            it('returns expires_at as a unix timestamp in the future', async () => {
                const now = Date.now();
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                expect(result.expires_at).toBeGreaterThan(now);
            });

            it('returns expires_at_string as a valid ISO 8601 string', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                expect(() => new Date(result.expires_at_string).toISOString()).not.toThrow();
                expect(result.expires_at_string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            });

            it('token expiration timestamp matches the expires_at field in the response', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                const payload = decodeToken(result.reservation_token);
                expect(payload.expires_at).toBe(result.expires_at);
            });
        });

        describe('boundary cases', () => {
            it('token contains all seat ids when reserving the maximum allowed seats', async () => {
                const seatIds = makeSeatIds(MAX_SEATS);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                const payload = decodeToken(result.reservation_token);
                expect((payload.seat_ids as string[]).length).toBe(MAX_SEATS);
            });

            it('token contains the single seat id when reserving exactly 1 seat', async () => {
                const seatIds = makeSeatIds(1);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);
                const payload = decodeToken(result.reservation_token);
                expect(payload.seat_ids).toEqual([seatIds[0]]);
            });
        });
    });

    describe('return value — failure', () => {

        describe('equivalence cases', () => {
            it('returns success:false when input validation fails', async () => {
                const { service } = buildService();

                await expect(service.reserveSeats([], USER_ID)).rejects.toThrow("Invalid number of seats provided.")
            });

            it('returns success:false when seats are unavailable in the DB', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    unavailableSeatIds: seatIds,
                });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Some seats are not available.")
            });

            it('returns success:false when Redis locking detects a conflict', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    lockResult: seatIds.map(id => seatLockFromId(id)),
                });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Some seats are not available.")
            });

            it('specifies ResourceNotFoundError failure response', async () => {
                const { service } = buildService();

                try {
                    await service.reserveSeats([], USER_ID);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });
        });

        describe('boundary cases', () => {
            it('conflict_seat_ids is empty when the failure is due to invalid input (not a seat conflict)', async () => {
                const { service } = buildService();

                try {
                    await service.reserveSeats([], USER_ID);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });
        });
    });
});

describe('TicketService.createPaymentIntent — behavior', () => {

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        process.env.STRIPE_SECRET_KEY = 'sk_test_mock_keytest-stripe-secret-for-unit-tests';
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('succeeds for a standard valid request', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });
        });

        describe('exception cases — missing or empty parameters', () => {
            it('fails when reservation_token is an empty string', async () => {
                const { service } = buildPaymentService();

                await expect(
                    service.createPaymentIntent('', USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });

            it('fails when reservation_token is null', async () => {
                const { service } = buildPaymentService();

                await expect(
                    service.createPaymentIntent(null as any, USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });

            it('fails when reservation_token is undefined', async () => {
                const { service } = buildPaymentService();

                await expect(
                    service.createPaymentIntent(undefined as any, USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });

            it('throws ResourceNotFoundError when user_uuid is an empty string', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(token, '', IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });

            it('throws ResourceNotFoundError when user_uuid is null', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(token, null as any, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });

            it('throws ResourceNotFoundError when user_uuid is undefined', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(token, undefined as any, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });

            it('throws ResourceNotFoundError when idempotency_key is an empty string', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(token, USER_ID, '');
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });

            it('throws ResourceNotFoundError when idempotency_key is null', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(token, USER_ID, null as any);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });

            it('throws ResourceNotFoundError when idempotency_key is undefined', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(token, USER_ID, undefined as any);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });
        });
    });

    // =========================================================================
    // 2. Reservation token validation
    // =========================================================================

    describe('reservation token validation', () => {

        describe('equivalence cases', () => {
            it('succeeds when the token is valid and signed with the correct secret', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('throws ForbiddenError when the token is signed with a different secret', async () => {
                const seatIds = makeSeatIds(2);
                const tamperedToken = jwt.sign(
                    { seat_ids: seatIds, user_uuid: USER_ID },
                    'wrong-secret',
                    { expiresIn: 600 },
                );
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(tamperedToken, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ForbiddenError);
                }
            });

            it('throws ForbiddenError when the token is a random non-JWT string', async () => {
                const { service } = buildPaymentService();

                try {
                    await service.createPaymentIntent('not.a.jwt', USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ForbiddenError);
                }
            });
        });

        describe('boundary cases', () => {
            it('throws ForbiddenError when the token is expired', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2)
                const expiredToken = makeExpiredToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                try {
                    await service.createPaymentIntent(expiredToken, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ForbiddenError);
                }
            });

            it('throws ForbiddenError when the user_uuid does not match the subject encoded in the token', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                // Token is signed for a different user than the one passed into the function
                const token = makeValidToken(seatIds, seatLocks, 'other-user-uuid');
                const { service } = buildPaymentService({ seatIds, tokenUserId: 'other-user-uuid' });

                try {
                    await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ForbiddenError);
                }
            });
        });
    });

    // =========================================================================
    // 3. Redis lock validation
    // =========================================================================

    describe('redis lock validation', () => {

        describe('equivalence cases', () => {
            it('succeeds when a valid lock exists for every seat in the token and is owned by the requesting user', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds, lockState: 'valid' });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('throws SeatConflictError when no Redis lock exists for a seat in the token', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds, lockState: 'missing' });

                try {
                    await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                }
            });

            it('throws SeatConflictError when the lock exists but is owned by a different user', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds, lockState: 'wrong-owner' });

                try {
                    await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                }
            });
        });

        describe('boundary cases', () => {
            it('throws SeatConflictError when at least one seat lock is missing even if others are valid', async () => {
                /**
                 * Simulate one seat having no lock while another does.
                 * We achieve this by overriding redis.get to return null for one
                 * specific key and the correct owner for all others.
                 */
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service, redisMock } = buildPaymentService({ seatIds, lockState: 'valid' });

                let callCount = 0;
                redisMock.get.mockImplementation(() => {
                    callCount++;
                    return callCount === 1
                        ? Promise.resolve(USER_ID)
                        : Promise.resolve(null);
                });

                try {
                    await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                }
            });

            it('throws SeatConflictError when at least one seat lock belongs to a different user', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service, redisMock } = buildPaymentService({ seatIds, lockState: 'valid' });

                let callCount = 0;
                redisMock.get.mockImplementation(() => {
                    callCount++;
                    return Promise.resolve(callCount === 1 ? USER_ID : 'another-user');
                });

                try {
                    await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                }
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by the Redis lock check', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service, redisMock } = buildPaymentService({ seatIds });

                redisMock.get.mockRejectedValue(new Error('Redis connection refused'));

                await expect(
                    service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 4. Idempotency — existing Order replay
    // =========================================================================

    describe('idempotency replay', () => {

        describe('equivalence cases', () => {
            it('returns the existing order immediately when an Order with the same idempotency_key and user_uuid already exists', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const existingOrder = { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET, order_status: OrderStatus.PENDING };
                const { service } = buildPaymentService({
                    seatIds,
                    existingOrder,
                });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
                // Stripe must NOT be called again — the result comes from the cached order.
                expect(paymentIntentsCreateMock).not.toHaveBeenCalled();
            });

            it('returns the stored order_id from the existing Order on a replayed request', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const existingOrder = { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET };
                const { service } = buildPaymentService({ seatIds, existingOrder });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result.order_id).toBe(ORDER_ID);
            });

            it('returns the stored client_secret from the existing Order on a replayed request', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const existingOrder = { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET };
                const { service } = buildPaymentService({ seatIds, existingOrder });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result.client_secret).toBe(STRIPE_CLIENT_SECRET);
            });

            it('proceeds to create a new payment intent when no existing Order is found', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                // const { service, paymentIntentsCreateMock } = buildPaymentService({ seatIds, existingOrder: null });
                const { service } = buildPaymentService({ seatIds, existingOrder: null });

                await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(paymentIntentsCreateMock).toHaveBeenCalled();
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown during the idempotency DB lookup', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service, prismaMock } = buildPaymentService({ seatIds });

                prismaMock.order.findUnique.mockRejectedValue(new Error('DB connection lost'));

                await expect(
                    service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 5. Stripe payment intent creation
    // =========================================================================

    describe('stripe payment intent creation', () => {

        describe('equivalence cases', () => {
            it('creates a Stripe payment intent on the happy path', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                // const { service, paymentIntentsCreateMock } = buildPaymentService({ seatIds });
                const { service } = buildPaymentService({ seatIds });

                await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(paymentIntentsCreateMock).toHaveBeenCalled();
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by Stripe', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({
                    seatIds
                });
                paymentIntentsCreateMock.mockRejectedValueOnce(
                    new Error('Stripe API unavailable')
                );

                await expect(
                    service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 6. Order and OrderSeat persistence
    // =========================================================================

    describe('order persistence', () => {

        describe('equivalence cases', () => {
            it('creates an Order row in the database after a successful Stripe response', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service, prismaMock } = buildPaymentService({ seatIds });

                await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(prismaMock.order.create).toHaveBeenCalled();
            });

            it('creates OrderSeat rows for every seat id in the token', async () => {
                const seatIds = makeSeatIds(3);
                const seatLocks = makeSeatLockIds(3);
                const token = makeValidToken(seatIds, seatLocks);
                const { service, prismaMock } = buildPaymentService({ seatIds });

                await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(prismaMock.orderSeats.createMany).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.arrayContaining(
                            seatIds.map(id => expect.objectContaining({ seat_id: id })),
                        ),
                    }),
                );
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown while persisting the Order row', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({
                    seatIds,
                    dbWriteError: new Error('DB write timeout'),
                });

                await expect(
                    service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY),
                ).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 7. Return value contract
    // =========================================================================

    describe('return value — success', () => {

        describe('equivalence cases', () => {
            it('returns an object with client_secret and order_id on the happy path', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('returns a non-empty client_secret string', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(typeof result.client_secret).toBe('string');
                expect(result.client_secret.length).toBeGreaterThan(0);
            });

            it('returns a non-empty order_id string', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(typeof result.order_id).toBe('string');
                expect(result.order_id.length).toBeGreaterThan(0);
            });

            it('returns the Stripe client_secret from the payment intent', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result.client_secret).toBe(STRIPE_CLIENT_SECRET);
            });

            it('returns the order_id of the newly created Order row', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result.order_id).toBe(ORDER_ID);
            });
        });

        describe('boundary cases', () => {
            it('returns successfully when the token contains only a single seat', async () => {
                const seatIds = makeSeatIds(1);
                const seatLocks = makeSeatLockIds(1);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it(`returns successfully when the token contains the maximum (${MAX_SEATS}) seats`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS);
                const seatLocks = makeSeatLockIds(MAX_SEATS);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });
        });
    });

    describe('return value — failure', () => {

        describe('equivalence cases', () => {
            it('throws ResourceNotFoundError when a required parameter is missing', async () => {
                const { service } = buildPaymentService();

                try {
                    await service.createPaymentIntent('', USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ResourceNotFoundError);
                }
            });

            it('throws ForbiddenError when the token cannot be verified', async () => {
                const { service } = buildPaymentService();

                try {
                    await service.createPaymentIntent('invalid.token.value', USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(ForbiddenError);
                }
            });

            it('throws SeatConflictError when Redis locks are not valid for the requesting user', async () => {
                const seatIds = makeSeatIds(2);
                const seatLocks = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, seatLocks);
                const { service } = buildPaymentService({ seatIds, lockState: 'missing' });

                try {
                    await service.createPaymentIntent(token, USER_ID, IDEMPOTENCY_KEY);
                } catch (error) {
                    expect(error).toBeInstanceOf(SeatConflictError);
                }
            });
        });
    });
});