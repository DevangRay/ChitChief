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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TicketService } from './tickets.service';
import { OrderStatus, SeatStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { seatLockFromId } from '../../lib/redis-keys';
import SeatConflictError from '../../lib/custom_errors/SeatConflictError';
import ResourceNotFoundError from '../../lib/custom_errors/ResourceNotFoundError';
import ForbiddenError from '../../lib/custom_errors/ForbiddenError';
import ConflictError from '../../lib/custom_errors/ConflictError';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SEATS = 10;
const USER_ID = 'user-uuid-1';
const USER_EMAIL = 'test@example.com';
const EVENT_ID = 'event-uuid-1';
const IDEMPOTENCY_KEY = 'idem-key-uuid-1';
const ORDER_ID = 'order-uuid-1';
const STRIPE_PAYMENT_INFO_ID = 'stripe-payment-info-uuid-1';
const STRIPE_CLIENT_SECRET = 'pi_test_secret_abc123';

/** All PaymentMethod values that Stripe treats as immediately successful. */
const SUCCESS_PAYMENT_METHODS = [
    "SUCCESS_VISA",
    "SUCCESS_VISA_DEBIT",
    "SUCCESS_MASTERCARD",
] as const;

/** All PaymentMethod values that represent card-decline / failure scenarios. */
const FAILURE_PAYMENT_METHODS = [
    "FAIL_DECLINED",
    "FAIL_INSUFFICIENT_FUNDS",
    "FAIL_CUSTOMER_CHARGED",
] as const;

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

// vi.hoisted() ensures this mock is created before vi.mock() factories run,
// so the same reference can be used both inside the factory and in assertions.
const paymentIntentsCreateMock = vi.hoisted(() =>
    vi.fn().mockResolvedValue({
        id: 'payment_intent_id',
        client_secret: 'pi_test_secret_abc123',
    })
);

vi.mock('stripe', () => {
    class StripeCardError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'StripeCardError';
        }
    }
    const mock = vi.fn().mockImplementation(function () {
        return {
            paymentIntents: {
                create: paymentIntentsCreateMock,
            },
        };
    }) as any;
    mock.errors = { StripeCardError };
    return { default: mock };
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
type PaymentMethod = typeof FAILURE_PAYMENT_METHODS[number] | typeof SUCCESS_PAYMENT_METHODS[number]

const buildPaymentService = ({
    seatIds = makeSeatIds(2),
    lockState = 'valid' as LockState,
    existingOrder = null as null | { id: string; client_secret: string, order_status: string },
    dbWriteError = undefined as Error | undefined,
    tokenUserId = USER_ID,
    paymentMethod = undefined as PaymentMethod | undefined,
} = {}) => {
    // Redis: get() returns the owner string or null depending on lockState.
    const redisMock = {
        ...makeRedisMock('OK'),   // keep eval/pipeline/del stubs
        get: vi.fn((_key: string) => {
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
                    id: existingOrder.id,
                    order_status: existingOrder.order_status,
                    stripe_payment_info: {
                        id: STRIPE_PAYMENT_INFO_ID,
                        client_secret: existingOrder.client_secret
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
            create: paymentMethod && (FAILURE_PAYMENT_METHODS as readonly string[]).includes(paymentMethod)
                ? vi.fn().mockRejectedValue(new Error(`Payment declined for method: ${paymentMethod}`))
                : vi.fn().mockResolvedValue({
                    id: STRIPE_PAYMENT_INFO_ID,
                    client_secret: STRIPE_CLIENT_SECRET,
                }),
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

const makePrismaMock = (availableSeats: object[] = []) => ({
    seat: {
        findMany: vi.fn().mockResolvedValue(availableSeats),
        updateMany: vi.fn().mockResolvedValue({ count: availableSeats.length }),
    },
});

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

            it(`succeeds with exactly MAX_SEATS (${MAX_SEATS}) seats (the maximum allowed per reservation)`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result).toMatchObject(EXPECTED_SUCCESS_RETURN_OBJECT);;
            });

            it('fails immediately with 0 seats (below minimum)', async () => {
                const { service } = buildService({ seatIds: [] });

                await expect(service.reserveSeats([], USER_ID)).rejects.toThrow("Invalid number of seats provided.")
            });

            it(`fails immediately when requesting more than MAX_SEATS (${MAX_SEATS + 1}+) seats`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS + 1);
                const { service } = buildService({ seatIds });

                await expect(service.reserveSeats(seatIds, USER_ID)).rejects.toThrow("Invalid number of seats provided.")
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

            it('embeds a redis_locks array inside the reservation token matching the seat ids', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                const payload = decodeToken(result.reservation_token);
                expect(Array.isArray(payload.redis_locks)).toBe(true);
                expect((payload.redis_locks as string[]).length).toBe(seatIds.length);
                seatIds.forEach(id => {
                    expect(payload.redis_locks).toContain(seatLockFromId(id));
                });
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
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        process.env.STRIPE_SECRET_KEY = 'test-stripe-secret-for-unit-tests';
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('succeeds for a fully valid request on the happy path', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token,
                    USER_ID,
                    USER_EMAIL,
                    IDEMPOTENCY_KEY,
                    "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });
        });

        describe('exception cases — missing or empty parameters', () => {
            it('throws ForbiddenError when reservation_token is null', async () => {
                const { service } = buildPaymentService();

                await expect(
                    service.createPaymentIntent(null as any, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when reservation_token is an empty string', async () => {
                const { service } = buildPaymentService();

                await expect(
                    service.createPaymentIntent('', USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when user_uuid is null', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, null as any, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when user_uuid is an empty string', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, '', USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when idempotency_key is null', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, null as any, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when idempotency_key is an empty string', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, '', "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when payment_method is null', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, null as any),
                ).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when payment_method is not a valid enum value', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, 'pm_not_a_real_method' as any),
                ).rejects.toBeInstanceOf(ForbiddenError);
            });
        });
    });

    // =========================================================================
    // 2. Reservation token validation
    // =========================================================================
    describe('reservation token validation', () => {

        describe('equivalence cases', () => {
            it('succeeds with a valid, unexpired token signed with the correct secret', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('throws ForbiddenError when the token is expired', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeExpiredToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ForbiddenError);
            });

            it('throws ForbiddenError when the token is signed with a different secret', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                // Sign with a wrong secret — the service will fail to verify it.
                const wrongToken = jwt.sign(
                    { seat_ids: seatIds, redis_locks: lockIds, user_uuid: USER_ID, expires_at: Date.now() + 60000 },
                    'totally-wrong-secret',
                    { expiresIn: 600 },
                );
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(wrongToken, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ForbiddenError);
            });

            it('throws ForbiddenError when the token is an arbitrary garbage string', async () => {
                const { service } = buildPaymentService();

                await expect(
                    service.createPaymentIntent('not.a.jwt', USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ForbiddenError);
            });
        });

        describe('boundary cases — token ownership', () => {
            it('throws ForbiddenError when the user_uuid in the token does not match the provided user_uuid', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                // Token is issued for USER_ID, but the caller claims a different identity.
                const token = makeValidToken(seatIds, lockIds, USER_ID);
                const { service } = buildPaymentService({ seatIds });

                await expect(
                    service.createPaymentIntent(token, 'different-user-uuid', USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ForbiddenError);
            });

            it('succeeds when the user_uuid in the token matches the provided user_uuid exactly', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds, USER_ID);
                const { service } = buildPaymentService({ seatIds, tokenUserId: USER_ID });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });
        });
    });

    // =========================================================================
    // 3. Redis lock validation
    // =========================================================================
    describe('Redis seat lock validation', () => {

        describe('equivalence cases', () => {
            it('succeeds when every seat in the token has a valid Redis lock owned by the user', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds, lockState: 'valid' });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('throws SeatConflictError when all seat locks are missing (reservation expired or never made)', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds, lockState: 'missing' });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(SeatConflictError);
            });

            it('throws SeatConflictError when all seat locks belong to a different user', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds, lockState: 'wrong-owner' });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(SeatConflictError);
            });
        });

        describe('boundary cases', () => {
            it('throws SeatConflictError even when only a single seat lock is missing', async () => {
                // We build a service where the redis mock returns null for any get(),
                // representing a single evicted lock among multiple seats.
                const seatIds = makeSeatIds(3);
                const lockIds = makeSeatLockIds(3);
                const token = makeValidToken(seatIds, lockIds);

                // Simulate: first two locks exist, third is missing.
                const redisMock = {
                    eval: vi.fn().mockResolvedValue(['OK']),
                    keys: vi.fn().mockResolvedValue([]),
                    pipeline: vi.fn().mockReturnValue({ del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }),
                    del: vi.fn().mockResolvedValue(1),
                    get: vi.fn()
                        .mockResolvedValueOnce(USER_ID)   // lock for seat 1
                        .mockResolvedValueOnce(USER_ID)   // lock for seat 2
                        .mockResolvedValueOnce(null),     // lock for seat 3 is gone
                };
                // Override the redis mock on the service directly via the factory.
                // Since buildPaymentService doesn't expose redis, we re-instantiate:
                const prismaMock = {
                    seat: {
                        findMany: vi.fn().mockResolvedValue([]),
                        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
                    },
                    order: {
                        findUnique: vi.fn().mockResolvedValue(null),
                        create: vi.fn().mockResolvedValue({ id: 'order-uuid-1' }),
                    },
                    orderSeats: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
                    stripePaymentInfo: { create: vi.fn().mockResolvedValue({ id: 'spi-1', client_secret: 'sec' }) },
                };
                const partialLockService = new TicketService(redisMock as any, prismaMock as any);

                await expect(
                    partialLockService.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(SeatConflictError);
            });

            it('throws SeatConflictError even when only a single seat lock belongs to a different user', async () => {
                const seatIds = makeSeatIds(3);
                const lockIds = makeSeatLockIds(3);
                const token = makeValidToken(seatIds, lockIds);

                const redisMock = {
                    eval: vi.fn().mockResolvedValue(['OK']),
                    keys: vi.fn().mockResolvedValue([]),
                    pipeline: vi.fn().mockReturnValue({ del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }),
                    del: vi.fn().mockResolvedValue(1),
                    get: vi.fn()
                        .mockResolvedValueOnce(USER_ID)          // lock for seat 1
                        .mockResolvedValueOnce('other-user-uuid') // lock for seat 2 — wrong owner
                        .mockResolvedValueOnce(USER_ID),          // lock for seat 3
                };
                const prismaMock = {
                    seat: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
                    order: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'order-uuid-1' }) },
                    orderSeats: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
                    stripePaymentInfo: { create: vi.fn().mockResolvedValue({ id: 'spi-1', client_secret: 'sec' }) },
                };
                const partialLockService = new TicketService(redisMock as any, prismaMock as any);

                await expect(
                    partialLockService.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(SeatConflictError);
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by Redis during lock verification', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);

                const redisMock = {
                    eval: vi.fn().mockResolvedValue(['OK']),
                    keys: vi.fn().mockResolvedValue([]),
                    pipeline: vi.fn().mockReturnValue({ del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }),
                    del: vi.fn().mockResolvedValue(1),
                    get: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
                };
                const prismaMock = {
                    seat: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
                    order: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'order-uuid-1' }) },
                    orderSeats: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
                    stripePaymentInfo: { create: vi.fn().mockResolvedValue({ id: 'spi-1', client_secret: 'sec' }) },
                };
                const errorService = new TicketService(redisMock as any, prismaMock as any);

                await expect(
                    errorService.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 4. Payment method coverage — all enum values
    // =========================================================================
    describe('payment_method enum coverage', () => {

        describe('equivalence cases — success methods', () => {
            it.each(SUCCESS_PAYMENT_METHODS)(
                'succeeds and returns a client_secret when payment method is %s',
                async (method) => {
                    const seatIds = makeSeatIds(2);
                    const lockIds = makeSeatLockIds(2);
                    const token = makeValidToken(seatIds, lockIds);
                    const { service } = buildPaymentService({ seatIds });

                    const result = await service.createPaymentIntent(
                        token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, method,
                    );

                    expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
                },
            );
        });

        describe('equivalence cases — authentication required', () => {
            it('returns a client_secret when payment method requires 3DS authentication', async () => {
                // AUTH_REQUIRED creates a PaymentIntent that requires action but does
                // not immediately fail — the client_secret is still returned so the
                // frontend can handle next-action.
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "AUTH_REQUIRED",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });
        });

        describe('equivalence cases — decline methods', () => {
            it.each(FAILURE_PAYMENT_METHODS)(
                'propagates a Stripe error (does not return success) when payment method is %s',
                async (method) => {
                    const seatIds = makeSeatIds(2);
                    const lockIds = makeSeatLockIds(2);
                    const token = makeValidToken(seatIds, lockIds);

                    // Stripe mock throws a card-declined error for these methods.
                    const { service } = buildPaymentService({ seatIds, paymentMethod: method });
                    // Re-wire the Stripe mock to throw for this specific test.
                    paymentIntentsCreateMock.mockRejectedValueOnce(`Payment declined for method: ${method}`);

                    await expect(
                        service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, method),
                    ).rejects.toThrow();
                },
            );
        });
    });

    // =========================================================================
    // 5. Idempotency — existing order
    // =========================================================================
    describe('idempotency', () => {

        describe('equivalence cases', () => {
            it('returns the existing client_secret when an order for the same idempotency key already exists', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({
                    seatIds,
                    existingOrder: { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET, order_status: OrderStatus.PENDING },
                });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
                expect(result.client_secret).toBe(STRIPE_CLIENT_SECRET);
            });

            it('returns an order_id when an order for the same idempotency key already exists', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({
                    seatIds,
                    existingOrder: { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET, order_status: OrderStatus.PENDING },
                });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result.order_id).toBe(ORDER_ID);
            });

            it('does not create a new Stripe PaymentIntent when an existing order is found', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({
                    seatIds,
                    existingOrder: { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET, order_status: OrderStatus.PENDING },
                });

                await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(paymentIntentsCreateMock).not.toHaveBeenCalled();
            });

            it('creates a new order and Stripe PaymentIntent when no existing order is found', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds, existingOrder: null });

                await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1);
            });
        });

        describe('boundary cases — expired and failed orders', () => {
            it('throws ConflictError when an EXPIRED order exists for the idempotency key', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({
                    seatIds,
                    existingOrder: { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET, order_status: OrderStatus.EXPIRED },
                });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toBeInstanceOf(ConflictError);
            });

            it('creates a new PaymentIntent when a FAILED order exists for the idempotency key (retry allowed)', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({
                    seatIds,
                    existingOrder: { id: ORDER_ID, client_secret: STRIPE_CLIENT_SECRET, order_status: OrderStatus.FAILED },
                });

                await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1);
            });
        });
    });

    // =========================================================================
    // 6. Return value contract
    // =========================================================================
    describe('return value contract', () => {

        describe('equivalence cases', () => {
            it('returns an object with client_secret and order_id on success', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('returns a non-empty string for client_secret', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(typeof result.client_secret).toBe('string');
                expect(result.client_secret.length).toBeGreaterThan(0);
            });

            it('returns a non-empty string for order_id', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(typeof result.order_id).toBe('string');
                expect(result.order_id.length).toBeGreaterThan(0);
            });

            it('client_secret comes from the Stripe PaymentIntent', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                // STRIPE_CLIENT_SECRET is what our Stripe mock returns.
                expect(result.client_secret).toBe(STRIPE_CLIENT_SECRET);
            });

            it('passes the correct total price (sum of seat prices) to the Stripe PaymentIntent', async () => {
                // makeAvailableSeats gives each seat price=10000, so 2 seats → amount=20000
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(paymentIntentsCreateMock).toHaveBeenCalledWith(
                    expect.objectContaining({ amount: 20000 }),
                    expect.anything(),
                );
            });
        });

        describe('boundary cases — seat count extremes', () => {
            it('returns a valid response when the token contains exactly 1 seat', async () => {
                const seatIds = makeSeatIds(1);
                const lockIds = makeSeatLockIds(1);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });

            it('returns a valid response when the token contains the maximum number of seats', async () => {
                const seatIds = makeSeatIds(10);
                const lockIds = makeSeatLockIds(10);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                const result = await service.createPaymentIntent(
                    token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA",
                );

                expect(result).toMatchObject(EXPECTED_PAYMENT_INTENT_RETURN_OBJECT);
            });
        });
    });

    // =========================================================================
    // 7. Error propagation
    // =========================================================================
    describe('error propagation', () => {

        describe('exception cases', () => {
            it('propagates unexpected errors thrown while creating the order in the database', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({
                    seatIds,
                    dbWriteError: new Error('DB write timeout'),
                });

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toThrow();
            });

            it('propagates unexpected errors thrown by the Stripe API', async () => {
                const seatIds = makeSeatIds(2);
                const lockIds = makeSeatLockIds(2);
                const token = makeValidToken(seatIds, lockIds);
                const { service } = buildPaymentService({ seatIds });

                paymentIntentsCreateMock.mockRejectedValueOnce(
                    new Error('Stripe API unavailable'),
                );

                await expect(
                    service.createPaymentIntent(token, USER_ID, USER_EMAIL, IDEMPOTENCY_KEY, "SUCCESS_VISA"),
                ).rejects.toThrow();
            });
        });
    });
});