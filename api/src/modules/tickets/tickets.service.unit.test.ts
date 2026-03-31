import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TicketService } from './tickets.service';
import { Seat, SeatStatus } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ExecReply = [Error | null, string | null];

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

const makeMultiChain = (execResult: ExecReply[] | null) => ({
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(execResult),
});

const makeRedisMock = (execResult: ExecReply[] | null = [[null, 'OK']]) => {
    const multiChain = makeMultiChain(execResult);
    return {
        watch: vi.fn().mockResolvedValue('OK'),
        multi: vi.fn().mockReturnValue(multiChain),
        del: vi.fn().mockResolvedValue(1),
        _chain: multiChain,
    };
};

const makePrismaMock = () => ({
    seat: {
        findMany: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    order: {
        findMany: vi.fn(),
        create: vi.fn(),
    },
    orderSeats: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
});

const makeQueueMock = () => ({
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
});

const makeJwtMock = () => ({
    sign: vi.fn().mockReturnValue('signed.jwt.token'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Seed data
// ─────────────────────────────────────────────────────────────────────────────

const makeSeat = (overrides: Partial<Seat> = {}): Seat => ({
    id: 'seat-uuid-1',
    event_id: 'event-uuid-1',
    row: 'A',
    number: 1,
    price: 100,
    seat_status: SeatStatus.AVAILABLE,
    ...overrides,
} as Seat);

const seat1 = makeSeat({ id: 'seat-uuid-1', row: 'A', number: 1 });
const seat2 = makeSeat({ id: 'seat-uuid-2', row: 'A', number: 2 });
const seats = [seat1, seat2];

const USER = 'user-uuid-1';
const MAX_SEATS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Exec reply builders
// ─────────────────────────────────────────────────────────────────────────────

const allOk = (n: number): ExecReply[] =>
    Array.from({ length: n }, () => [null, 'OK']);

const withConflictsAt = (n: number, indices: number[]): ExecReply[] =>
    Array.from({ length: n }, (_, i) =>
        indices.includes(i) ? [null, null] : [null, 'OK']
    );

const withErrorAt = (n: number, indices: number[]): ExecReply[] =>
    Array.from({ length: n }, (_, i) =>
        indices.includes(i) ? [new Error('ERR'), null] : [null, 'OK']
    );

// ─────────────────────────────────────────────────────────────────────────────
// Full-stack service builder
// Rebuilds all mocks cleanly — use when a test needs non-default exec behaviour
// ─────────────────────────────────────────────────────────────────────────────

const makeService = (execResult: ExecReply[] | null) => {
    const redis  = makeRedisMock(execResult);
    const prisma = makePrismaMock();
    const queue  = makeQueueMock();
    const jwt    = makeJwtMock();

    // Default happy-path DB state — override per test as needed
    prisma.seat.findMany.mockResolvedValue(
        seats.map(s => ({ ...s, seat_status: SeatStatus.AVAILABLE }))
    );

    const service = new TicketService(redis as any, prisma as any, queue as any, jwt as any);
    return { service, redis, prisma, queue, jwt };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TicketService.reserveSeats', () => {
    let redis:   ReturnType<typeof makeRedisMock>;
    let prisma:  ReturnType<typeof makePrismaMock>;
    let queue:   ReturnType<typeof makeQueueMock>;
    let jwt:     ReturnType<typeof makeJwtMock>;
    let service: TicketService;

    beforeEach(() => {
        ({ service, redis, prisma, queue, jwt } = makeService(allOk(seats.length)));
    });

    // =========================================================================
    // Step 1 — Input validation
    // =========================================================================

    describe('step 1 — input validation', () => {

        describe('equivalence cases', () => {
            it('proceeds without throwing for a valid seats array and user', async () => {
                const result = await service.reserveSeats(seats, USER);
                expect(result.success).toBe(true);

                expect(prisma.seat.findMany).toHaveBeenCalled();
                expect(redis.watch).toHaveBeenCalled();
            });
        });

        describe('boundary cases', () => {
            it('accepts exactly 1 seat (minimum)', async () => {
                const { service, prisma } = makeService(allOk(1));
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.AVAILABLE }]);

                const result = await service.reserveSeats([seat1], USER);
                expect(result.success).toBe(true);

                expect(prisma.seat.findMany).toHaveBeenCalled();
                expect(redis.watch).toHaveBeenCalled();
            });

            it('accepts exactly MAX_SEATS seats', async () => {
                const maxSeats = Array.from({ length: MAX_SEATS }, (_, i) =>
                    makeSeat({ id: `seat-uuid-${i}`, number: i + 1 })
                );
                const { service, prisma } = makeService(allOk(MAX_SEATS));
                prisma.seat.findMany.mockResolvedValue(
                    maxSeats.map(s => ({ ...s, seat_status: SeatStatus.AVAILABLE }))
                );

                const result = await service.reserveSeats(maxSeats, USER);
                expect(result.success).toBe(true);

                expect(prisma.seat.findMany).toHaveBeenCalled();
                expect(redis.watch).toHaveBeenCalled();
            });

            it('returns failure when seats array is empty', async () => {
                const result = await service.reserveSeats([], USER);
                expect(result.success).toBe(false);

                expect(prisma.seat.findMany).not.toHaveBeenCalled();
                expect(redis.watch).not.toHaveBeenCalled();
            });

            it('returns failure when seats array has MAX_SEATS + 1 seats', async () => {
                const tooMany = Array.from({ length: MAX_SEATS + 1 }, (_, i) =>
                    makeSeat({ id: `seat-uuid-${i}`, number: i + 1 })
                );

                const result = await service.reserveSeats(tooMany, USER);
                expect(result.success).toBe(false);

                expect(prisma.seat.findMany).not.toHaveBeenCalled();
                expect(redis.watch).not.toHaveBeenCalled();
            });
        });

        describe('exception cases', () => {
            it('returns failure when user is null', async () => {
                const result = await service.reserveSeats(seats, null as any);
                expect(result.success).toBe(false);

                expect(prisma.seat.findMany).not.toHaveBeenCalled();
                expect(redis.watch).not.toHaveBeenCalled();
            });

            it('returns failure when user is an empty string', async () => {
                const result = await service.reserveSeats(seats, '');
                expect(result.success).toBe(false);

                expect(prisma.seat.findMany).not.toHaveBeenCalled();
                expect(redis.watch).not.toHaveBeenCalled();
            });

            it('returns failure when user is a whitespace-only string', async () => {
                const result = await service.reserveSeats(seats, '   ');
                expect(result.success).toBe(false);
                
                expect(prisma.seat.findMany).not.toHaveBeenCalled();
                expect(redis.watch).not.toHaveBeenCalled();
            });

            it('returns failure when seats contains duplicate ids', async () => {
                const result = await service.reserveSeats([seat1, seat1], USER);
                expect(result.success).toBe(false);
                
                expect(prisma.seat.findMany).not.toHaveBeenCalled();
                expect(redis.watch).not.toHaveBeenCalled();
            });
        });
    });

    // =========================================================================
    // Step 2 — DB seat availability check
    // =========================================================================

    describe('step 2 — seat availability check', () => {

        describe('equivalence cases', () => {
            it('queries seats using event_id, row, and number', async () => {
                await service.reserveSeats(seats, USER);

                expect(prisma.seat.findMany).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({
                            and: seats.map(s => ({
                                event_id: s.event_id,
                                row:      s.row,
                                number:   s.number,
                            })),
                        }),
                    })
                );
            });

            it('proceeds to lock acquisition when all seats are AVAILABLE', async () => {
                await service.reserveSeats(seats, USER);

                expect(redis.watch).toHaveBeenCalled();
            });

            it('returns success:false without touching Redis when any seat is unavailable', async () => {
                prisma.seat.findMany.mockResolvedValue([
                    { ...seat1, seat_status: SeatStatus.RESERVED },
                    { ...seat2, seat_status: SeatStatus.AVAILABLE },
                ]);

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                expect(redis.watch).not.toHaveBeenCalled();
            });
        });

        describe('boundary cases', () => {
            it('returns only the one non-AVAILABLE seat as a conflict', async () => {
                prisma.seat.findMany.mockResolvedValue([
                    { ...seat1, seat_status: SeatStatus.AVAILABLE },
                    { ...seat2, seat_status: SeatStatus.RESERVED },
                ]);

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(1);
                    expect(result.conflict_seat_ids[0].id).toBe(seat2.id);
                }
            });

            it('returns all seats as conflicts when every seat is unavailable', async () => {
                prisma.seat.findMany.mockResolvedValue([
                    { ...seat1, seat_status: SeatStatus.SOLD },
                    { ...seat2, seat_status: SeatStatus.RESERVED },
                ]);

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(2);
                }
            });
        });

        describe('exception cases', () => {
            it('treats RESERVED seats as conflicts', async () => {
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.RESERVED }]);

                const result = await service.reserveSeats([seat1], USER);

                expect(result.success).toBe(false);
            });

            it('treats SOLD seats as conflicts', async () => {
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.SOLD }]);

                const result = await service.reserveSeats([seat1], USER);

                expect(result.success).toBe(false);
            });

            it('treats a seat not found in DB as a conflict', async () => {
                // Only seat1 returned — seat2 is absent
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.AVAILABLE }]);

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids.some(s => s.id === seat2.id)).toBe(true);
                }
            });

            it('propagates when prisma.seat.findMany rejects', async () => {
                prisma.seat.findMany.mockRejectedValue(new Error('DB unavailable'));

                await expect(service.reserveSeats(seats, USER)).rejects.toThrow('DB unavailable');
            });
        });
    });

    // =========================================================================
    // Step 3 — Redis lock acquisition
    // =========================================================================

    describe('step 3 — lock acquisition', () => {

        describe('equivalence cases', () => {
            it('watches all seat lock keys', async () => {
                await service.reserveSeats(seats, USER);

                expect(redis.watch).toHaveBeenCalledWith(
                    seats.map(s => `seat_lock_${s.id}`)
                );
            });

            it('sets each lock keyed to seat id, valued to user, using NX and PXAT', async () => {
                await service.reserveSeats(seats, USER);

                expect(redis._chain.set).toHaveBeenCalledWith(
                    `seat_lock_${seat1.id}`, USER, 'NX', 'PXAT', expect.any(Number)
                );
                expect(redis._chain.set).toHaveBeenCalledWith(
                    `seat_lock_${seat2.id}`, USER, 'NX', 'PXAT', expect.any(Number)
                );
            });

            it('returns success:false with only the conflicting seat when one lock fails', async () => {
                const { service } = makeService(withConflictsAt(seats.length, [1]));

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(1);
                    expect(result.conflict_seat_ids[0].id).toBe(seat2.id);
                }
            });
        });

        describe('boundary cases', () => {
            it('sets PXAT expiration approximately 60 seconds from now', async () => {
                const before = Date.now();
                await service.reserveSeats(seats, USER);
                const after = Date.now();

                const pxatArg = redis._chain.set.mock.calls[0][4] as number;
                expect(pxatArg).toBeGreaterThanOrEqual(before + 60000);
                expect(pxatArg).toBeLessThanOrEqual(after + 60000);
            });

            it('returns all seats as conflicts when WATCH fires (exec returns null)', async () => {
                const { service } = makeService(null);

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toEqual(expect.arrayContaining(seats));
                }
            });

            it('returns all seats as conflicts when every lock fails', async () => {
                const { service } = makeService(withConflictsAt(seats.length, [0, 1]));

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(seats.length);
                }
            });
        });

        describe('exception cases', () => {
            it('releases only successfully acquired locks on partial conflict', async () => {
                const { service, redis } = makeService(withConflictsAt(seats.length, [1]));

                await service.reserveSeats(seats, USER);

                expect(redis.del).toHaveBeenCalledWith([`seat_lock_${seat1.id}`]);
            });

            it('does not call del when no locks were acquired', async () => {
                const { service, redis } = makeService(withConflictsAt(seats.length, [0, 1]));

                await service.reserveSeats(seats, USER);

                expect(redis.del).not.toHaveBeenCalled();
            });

            it('does not call del when WATCH fires', async () => {
                const { service, redis } = makeService(null);

                await service.reserveSeats(seats, USER);

                expect(redis.del).not.toHaveBeenCalled();
            });

            it('treats a command-level error reply as a lock failure', async () => {
                const { service } = makeService(withErrorAt(seats.length, [0]));

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids[0].id).toBe(seat1.id);
                }
            });

            it('propagates when redis.watch rejects', async () => {
                redis.watch.mockRejectedValue(new Error('Redis unreachable'));

                await expect(service.reserveSeats(seats, USER)).rejects.toThrow('Redis unreachable');
            });
        });
    });

    // =========================================================================
    // Step 4 — Mark seats RESERVED in DB
    // =========================================================================

    describe('step 4 — mark seats RESERVED in DB', () => {

        describe('equivalence cases', () => {
            it('calls prisma.seat.updateMany with RESERVED for all seat ids', async () => {
                await service.reserveSeats(seats, USER);

                expect(prisma.seat.updateMany).toHaveBeenCalledWith({
                    where: { id: { in: seats.map(s => s.id) } },
                    data:  { seat_status: SeatStatus.RESERVED },
                });
            });

            it('calls updateMany after locks are acquired', async () => {
                const callOrder: string[] = [];
                redis._chain.exec.mockImplementation(async () => {
                    callOrder.push('exec');
                    return allOk(seats.length);
                });
                prisma.seat.updateMany.mockImplementation(async () => {
                    callOrder.push('updateMany');
                    return { count: 2 };
                });

                await service.reserveSeats(seats, USER);

                expect(callOrder.indexOf('exec')).toBeLessThan(callOrder.indexOf('updateMany'));
            });
        });

        describe('boundary cases', () => {
            it('updates exactly 1 seat when only 1 seat is reserved', async () => {
                const { service, prisma } = makeService(allOk(1));
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.AVAILABLE }]);

                await service.reserveSeats([seat1], USER);

                expect(prisma.seat.updateMany).toHaveBeenCalledWith({
                    where: { id: { in: [seat1.id] } },
                    data:  { seat_status: SeatStatus.RESERVED },
                });
            });
        });

        describe('exception cases', () => {
            it('does not call updateMany when any lock fails', async () => {
                const { service, prisma } = makeService(withConflictsAt(seats.length, [0]));

                await service.reserveSeats(seats, USER);

                expect(prisma.seat.updateMany).not.toHaveBeenCalled();
            });

            it('does not call updateMany when WATCH fires', async () => {
                const { service, prisma } = makeService(null);

                await service.reserveSeats(seats, USER);

                expect(prisma.seat.updateMany).not.toHaveBeenCalled();
            });

            it('does not call updateMany when DB availability check finds conflicts', async () => {
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.RESERVED }]);

                await service.reserveSeats([seat1], USER);

                expect(prisma.seat.updateMany).not.toHaveBeenCalled();
            });

            it('propagates when prisma.seat.updateMany rejects', async () => {
                prisma.seat.updateMany.mockRejectedValue(new Error('DB write failed'));

                await expect(service.reserveSeats(seats, USER)).rejects.toThrow('DB write failed');
            });
        });
    });

    // =========================================================================
    // Step 5 — Enqueue BullMQ release job
    // =========================================================================

    describe('step 5 — enqueue release job', () => {

        describe('equivalence cases', () => {
            it('calls queue.add once after all locks are acquired', async () => {
                await service.reserveSeats(seats, USER);

                expect(queue.add).toHaveBeenCalledTimes(1);
            });

            it('passes seat ids and expiration timestamp to queue.add', async () => {
                await service.reserveSeats(seats, USER);

                expect(queue.add).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.objectContaining({
                        seat_ids:   seats.map(s => s.id),
                        expires_at: expect.any(Number),
                    }),
                    expect.anything(),
                );
            });

            it('enqueues the job after seats are marked RESERVED in DB', async () => {
                const callOrder: string[] = [];
                prisma.seat.updateMany.mockImplementation(async () => {
                    callOrder.push('updateMany');
                    return { count: 2 };
                });
                queue.add.mockImplementation(async () => {
                    callOrder.push('queue.add');
                    return { id: 'job-1' };
                });

                await service.reserveSeats(seats, USER);

                expect(callOrder.indexOf('updateMany')).toBeLessThan(callOrder.indexOf('queue.add'));
            });
        });

        describe('exception cases', () => {
            it('does not call queue.add when lock acquisition fails', async () => {
                const { service, queue } = makeService(withConflictsAt(seats.length, [0]));

                await service.reserveSeats(seats, USER);

                expect(queue.add).not.toHaveBeenCalled();
            });

            it('does not call queue.add when WATCH fires', async () => {
                const { service, queue } = makeService(null);

                await service.reserveSeats(seats, USER);

                expect(queue.add).not.toHaveBeenCalled();
            });

            it('does not call queue.add when DB availability check fails', async () => {
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.RESERVED }]);

                await service.reserveSeats([seat1], USER);

                expect(queue.add).not.toHaveBeenCalled();
            });

            it('propagates when queue.add rejects', async () => {
                queue.add.mockRejectedValue(new Error('Queue unavailable'));

                await expect(service.reserveSeats(seats, USER)).rejects.toThrow('Queue unavailable');
            });
        });
    });

    // =========================================================================
    // Step 6 — Return value
    // =========================================================================

    describe('step 6 — return value', () => {

        describe('equivalence cases', () => {
            it('returns success:true on the full happy path', async () => {
                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(true);
            });

            it('signs a JWT payload containing seat_ids and expires_at', async () => {
                await service.reserveSeats(seats, USER);

                expect(jwt.sign).toHaveBeenCalledWith(
                    expect.objectContaining({
                        seat_ids:   seats.map(s => s.id),
                        expires_at: expect.any(Number),
                    }),
                    expect.anything(), // secret — opaque to this test
                );
            });

            it('returns the signed JWT as reservation_token', async () => {
                const result = await service.reserveSeats(seats, USER);

                if (result.success) {
                    expect(result.reservation_token).toBe('signed.jwt.token');
                }
            });

            it('returns expires_at as an ISO string approximately 60 seconds from now', async () => {
                const before = Date.now() + 60000;
                const result = await service.reserveSeats(seats, USER);
                const after  = Date.now() + 60000;

                if (result.success) {
                    const ts = new Date(result.expires_at).getTime();
                    expect(ts).toBeGreaterThanOrEqual(before);
                    expect(ts).toBeLessThanOrEqual(after);
                }
            });
        });

        describe('boundary cases', () => {
            it('returns success:false with all seats when WATCH fires', async () => {
                const { service } = makeService(null);

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toEqual(expect.arrayContaining(seats));
                }
            });

            it('returns success:false with only the conflicting seats — not the acquired ones', async () => {
                const { service } = makeService(withConflictsAt(seats.length, [1]));

                const result = await service.reserveSeats(seats, USER);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(1);
                    expect(result.conflict_seat_ids[0].id).toBe(seat2.id);
                }
            });
        });

        describe('exception cases', () => {
            it('does not call jwt.sign when locks fail', async () => {
                const { service, jwt } = makeService(withConflictsAt(seats.length, [0]));

                await service.reserveSeats(seats, USER);

                expect(jwt.sign).not.toHaveBeenCalled();
            });

            it('does not call jwt.sign when DB availability check finds conflicts', async () => {
                prisma.seat.findMany.mockResolvedValue([{ ...seat1, seat_status: SeatStatus.RESERVED }]);

                await service.reserveSeats([seat1], USER);

                expect(jwt.sign).not.toHaveBeenCalled();
            });

            it('does not call jwt.sign when validation fails', async () => {
                await service.reserveSeats([], USER).catch(() => {});

                expect(jwt.sign).not.toHaveBeenCalled();
            });
        });
    });
});