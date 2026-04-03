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
import { SeatStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { seatLockKeyFormatter } from '../../lib/redis-keys';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SEATS = 10;
const USER_ID = 'user-uuid-1';
const EVENT_ID = 'event-uuid-1';

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build an array of n distinct seat id strings. */
const makeSeatIds = (n: number, prefix = 'seat-uuid-'): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

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

                expect(result.success).toBe(true);
            });
        });

        describe('boundary cases — seat count', () => {
            it('succeeds with exactly 1 seat (minimum valid count)', async () => {
                const seatIds = makeSeatIds(1);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
            });

            it(`succeeds with exactly ${MAX_SEATS} seats (maximum valid count)`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
            });

            it('fails immediately with 0 seats (below minimum)', async () => {
                const { service } = buildService({ seatIds: [] });

                const result = await service.reserveSeats([], USER_ID);

                expect(result.success).toBe(false);
            });

            it(`fails immediately with ${MAX_SEATS + 1} seats (above maximum)`, async () => {
                const seatIds = makeSeatIds(MAX_SEATS + 1);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });
        });

        describe('exception cases — invalid inputs', () => {
            it('fails when user id is an empty string', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, '');

                expect(result.success).toBe(false);
            });

            it('fails when user id is null', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, null as any);

                expect(result.success).toBe(false);
            });

            it('fails when user id is undefined', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, undefined as any);

                expect(result.success).toBe(false);
            });

            it('fails when the seat ids array contains duplicates', async () => {
                const id = 'seat-uuid-1';
                const { service } = buildService({ seatIds: [id] });

                const result = await service.reserveSeats([id, id], USER_ID);

                expect(result.success).toBe(false);
            });

            it('fails when seat ids array is null', async () => {
                const { service } = buildService();

                const result = await service.reserveSeats(null as any, USER_ID);

                expect(result.success).toBe(false);
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

                expect(result.success).toBe(true);
            });

            it('fails when none of the requested seats are available', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    allAvailable: false,
                    unavailableSeatIds: seatIds,   // all unavailable
                });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });
        });

        describe('boundary cases', () => {
            it('fails when only some seats are available (partial availability)', async () => {
                const seatIds = makeSeatIds(3);
                const { service } = buildService({
                    seatIds,
                    unavailableSeatIds: [seatIds[2]],  // last one is unavailable
                });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });

            it('reports the unavailable seat ids in the failure response', async () => {
                const seatIds = makeSeatIds(3);
                const unavailableSeatIds = [seatIds[1]]; // middle seat
                const { service } = buildService({ seatIds, unavailableSeatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toContain(unavailableSeatIds[0]);
                }
            });

            it('fails when a requested seat id does not exist in the database at all', async () => {
                const realIds = makeSeatIds(2);
                const ghostId = 'non-existent-seat-uuid';
                const { service } = buildService({ seatIds: realIds });

                // The ghost id is not in DB, so findMany returns only the real ones.
                const result = await service.reserveSeats([...realIds, ghostId], USER_ID);

                expect(result.success).toBe(false);
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

                expect(result.success).toBe(true);
            });

            it('fails when all seats are already locked by another user', async () => {
                const seatIds = makeSeatIds(2);
                // Simulate all lock keys being contested (format mirrors the service key formatter)
                const conflictingKeys = seatIds.map(id => seatLockKeyFormatter(id));
                const { service } = buildService({ seatIds, lockResult: conflictingKeys });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });
        });

        describe('boundary cases', () => {
            it('fails when at least one of several seats is locked', async () => {
                const seatIds = makeSeatIds(3);
                // Only the second seat is contested.
                const conflictingKeys = [seatLockKeyFormatter(seatIds[1])];
                const { service } = buildService({ seatIds, lockResult: conflictingKeys });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });

            it('includes the conflicting seat id in the failure response', async () => {
                const seatIds = makeSeatIds(2);
                const contestedSeatId = seatIds[0];
                const { service } = buildService({
                    seatIds,
                    lockResult: [seatLockKeyFormatter(contestedSeatId)],
                });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toContain(contestedSeatId);
                }
            });

            it('does not include non-conflicting seat ids in the failure response', async () => {
                const seatIds = makeSeatIds(2);
                const freeSeatId = seatIds[1];
                const { service } = buildService({
                    seatIds,
                    lockResult: [seatLockKeyFormatter(seatIds[0])], // only first conflicts
                });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).not.toContain(freeSeatId);
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

                expect(result.success).toBe(true);
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

                expect(result.success).toBe(true);
            });

            it('returns a non-empty reservation_token string on success', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    expect(typeof result.reservation_token).toBe('string');
                    expect(result.reservation_token.length).toBeGreaterThan(0);
                }
            });

            it('embeds the requested seat ids inside the reservation token', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    const payload = decodeToken(result.reservation_token);
                    expect(payload.seat_ids).toEqual(expect.arrayContaining(seatIds));
                }
            });

            it('embeds the user id inside the reservation token', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    const payload = decodeToken(result.reservation_token);
                    expect(payload.user_uuid).toBe(USER_ID);
                }
            });

            it('embeds a numeric expiration timestamp inside the reservation token', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    const payload = decodeToken(result.reservation_token);
                    expect(typeof payload.expires_at).toBe('number');
                }
            });

            it('returns expires_at as a unix timestamp in the future', async () => {
                const now = Date.now();
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.expires_at).toBeGreaterThan(now);
                }
            });

            it('returns expires_at_string as a valid ISO 8601 string', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    expect(() => new Date(result.expires_at_string).toISOString()).not.toThrow();
                    expect(result.expires_at_string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
                }
            });

            it('token expiration timestamp matches the expires_at field in the response', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    const payload = decodeToken(result.reservation_token);
                    expect(payload.expires_at).toBe(result.expires_at);
                }
            });
        });

        describe('boundary cases', () => {
            it('token contains all seat ids when reserving the maximum allowed seats', async () => {
                const seatIds = makeSeatIds(MAX_SEATS);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    const payload = decodeToken(result.reservation_token);
                    expect((payload.seat_ids as string[]).length).toBe(MAX_SEATS);
                }
            });

            it('token contains the single seat id when reserving exactly 1 seat', async () => {
                const seatIds = makeSeatIds(1);
                const { service } = buildService({ seatIds });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(true);
                if (result.success) {
                    const payload = decodeToken(result.reservation_token);
                    expect(payload.seat_ids).toEqual([seatIds[0]]);
                }
            });
        });
    });

    describe('return value — failure', () => {

        describe('equivalence cases', () => {
            it('returns success:false when input validation fails', async () => {
                const { service } = buildService();

                const result = await service.reserveSeats([], USER_ID);

                expect(result.success).toBe(false);
            });

            it('returns success:false when seats are unavailable in the DB', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    unavailableSeatIds: seatIds,
                });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });

            it('returns success:false when Redis locking detects a conflict', async () => {
                const seatIds = makeSeatIds(2);
                const { service } = buildService({
                    seatIds,
                    lockResult: seatIds.map(id => seatLockKeyFormatter(id)),
                });

                const result = await service.reserveSeats(seatIds, USER_ID);

                expect(result.success).toBe(false);
            });

            it('includes a conflict_seat_ids array in every failure response', async () => {
                const { service } = buildService();

                const result = await service.reserveSeats([], USER_ID);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(Array.isArray(result.conflict_seat_ids)).toBe(true);
                }
            });
        });

        describe('boundary cases', () => {
            it('conflict_seat_ids is empty when the failure is due to invalid input (not a seat conflict)', async () => {
                const { service } = buildService();

                // Empty array is an input validation failure, not a seat conflict.
                const result = await service.reserveSeats([], USER_ID);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(0);
                }
            });
        });
    });
});