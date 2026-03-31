import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TicketService } from './tickets.service';
import { OrderStatus, SeatStatus } from '@prisma/client';


// Setting up mocks
type ExecReply = [Error | null, string | null];

const makeMultiChain = (execResult: ExecReply[] | null) => ({
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(execResult),
});

const makeRedisMock = (execResult: ExecReply[] | null) => {
    const multiChain = makeMultiChain(execResult);
    return {
        watch: vi.fn().mockResolvedValue('OK'),
        multi: vi.fn().mockReturnValue(multiChain),
        del: vi.fn().mockResolvedValue(1),
        _chain: multiChain,
    };
};

const makePrismaMock = () => ({
    order: {
        findMany: vi.fn(),
        create: vi.fn(),
    },
    orderSeats: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
});


// Constant values
const seat1 = {
    id: '4d17bf3c-248f-463c-8ae0-bc1de4ee519c',
    event_id: 'b4840051-8571-4391-be32-b94142db7c3c',
    row: 'A',
    number: 1,
    price: 100,
    seat_status: SeatStatus.AVAILABLE,
};

const seat2 = {
    id: 'dbd63efe-19c5-4ff2-b0be-97e8b3ae1dc9',
    event_id: 'b4840051-8571-4391-be32-b94142db7c3c',
    row: 'A',
    number: 2,
    price: 200,
    seat_status: SeatStatus.AVAILABLE,
};

const existingOrder = {
    id: 'order-1',
    idempotency_key: 'idempotency-key-1',
    user_id: 'user-1',
    order_status: OrderStatus.PENDING,
};


// Functions required for redis exec
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


describe('TicketService', () => {
    const user = 'user-1';
    const seats = [seat1, seat2];

    let redis: ReturnType<typeof makeRedisMock>;
    let prisma: ReturnType<typeof makePrismaMock>;
    let service: TicketService;

    // Default: happy path — existing order, all locks succeed
    beforeEach(() => {
        redis = makeRedisMock(allOk(seats.length));
        prisma = makePrismaMock();
        prisma.order.findMany.mockResolvedValue([existingOrder]);
        service = new TicketService(redis as any, prisma as any);
    });

    describe('reserveSeats', () => {

        // ── Equivalence (normal) cases ──────────────────────────────────────

        describe('equivalence cases', () => {
            it('returns success:true with reservation_token and expires_at when all locks acquired', async () => {
                const result = await service.reserveSeats(seats, user);

                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.reservation_token).toBe(existingOrder.idempotency_key);
                    expect(result.expires_at).toBeDefined();
                }
            });

            it('uses the existing pending order without creating a new one', async () => {
                await service.reserveSeats(seats, user);

                expect(prisma.order.findMany).toHaveBeenCalledWith({
                    where: { user_id: user, order_status: 'PENDING' },
                });
                expect(prisma.order.create).not.toHaveBeenCalled();
            });

            it('creates a new pending order when none exists for the user', async () => {
                prisma.order.findMany.mockResolvedValue([]);
                prisma.order.create.mockResolvedValue(existingOrder);

                await service.reserveSeats(seats, user);

                expect(prisma.order.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            user_id: user,
                            order_status: 'PENDING',
                            idempotency_key: expect.any(String),
                        }),
                    })
                );
            });

            it('watches all seat lock keys before executing the transaction', async () => {
                await service.reserveSeats(seats, user);

                expect(redis.watch).toHaveBeenCalledWith([
                    `seat_lock_${seat1.id}`,
                    `seat_lock_${seat2.id}`,
                ]);
            });

            it('sets each lock with the user id as value, using NX and PXAT', async () => {
                await service.reserveSeats(seats, user);

                expect(redis._chain.set).toHaveBeenCalledWith(
                    `seat_lock_${seat1.id}`, user, 'NX', 'PXAT', expect.any(Number)
                );
                expect(redis._chain.set).toHaveBeenCalledWith(
                    `seat_lock_${seat2.id}`, user, 'NX', 'PXAT', expect.any(Number)
                );
            });

            it('writes OrderSeats to DB only after all locks are acquired', async () => {
                const callOrder: string[] = [];
                redis._chain.exec.mockImplementation(async () => {
                    callOrder.push('exec');
                    return allOk(seats.length);
                });
                prisma.orderSeats.createMany.mockImplementation(async () => {
                    callOrder.push('createMany');
                    return { count: 2 };
                });

                await service.reserveSeats(seats, user);

                expect(callOrder.indexOf('exec')).toBeLessThan(callOrder.indexOf('createMany'));
            });

            it('deletes existing OrderSeats then creates new ones on success', async () => {
                await service.reserveSeats(seats, user);

                expect(prisma.orderSeats.deleteMany).toHaveBeenCalledWith({
                    where: { order_id: existingOrder.id },
                });
                expect(prisma.orderSeats.createMany).toHaveBeenCalledWith({
                    data: seats.map((seat) => ({
                        order_id: existingOrder.id,
                        seat_id: seat.id,
                        price_at_purchase: seat.price,
                    })),
                });
            });

            it('returns success:false with only the conflicting seat ids when a lock is not acquired', async () => {
                redis = makeRedisMock(withConflictsAt(seats.length, [0]));
                service = new TicketService(redis as any, prisma as any);

                const result = await service.reserveSeats(seats, user);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toContainEqual(seat1);
                    expect(result.conflict_seat_ids).not.toContainEqual(seat2);
                }
            });
        });

        // ── Boundary cases ──────────────────────────────────────────────────

        describe('boundary cases', () => {
            it('succeeds with exactly one seat', async () => {
                redis = makeRedisMock(allOk(1));
                service = new TicketService(redis as any, prisma as any);

                const result = await service.reserveSeats([seat1], user);

                expect(result.success).toBe(true);
            });

            it('sets lock expiration approximately 60 seconds from now', async () => {
                const before = Date.now();
                await service.reserveSeats(seats, user);
                const after = Date.now();

                // Extract the PXAT timestamp from the first .set() call
                const pxatArg = redis._chain.set.mock.calls[0][4] as number;
                expect(pxatArg).toBeGreaterThanOrEqual(before + 60000);
                expect(pxatArg).toBeLessThanOrEqual(after + 60000);
            });

            it('returns all seats as conflicting when WATCH fires (exec returns null)', async () => {
                redis = makeRedisMock(null);
                service = new TicketService(redis as any, prisma as any);

                const result = await service.reserveSeats(seats, user);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toEqual(seats);
                }
            });

            it('returns only the one conflicting seat when exactly one of two fails', async () => {
                redis = makeRedisMock(withConflictsAt(seats.length, [1]));
                service = new TicketService(redis as any, prisma as any);

                const result = await service.reserveSeats(seats, user);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toHaveLength(1);
                    expect(result.conflict_seat_ids[0]).toEqual(seat2);
                }
            });

            it('returns all seats as conflicting when every lock fails', async () => {
                redis = makeRedisMock(withConflictsAt(seats.length, [0, 1]));
                service = new TicketService(redis as any, prisma as any);

                const result = await service.reserveSeats(seats, user);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toEqual(seats);
                }
            });
        });

        // ── Exception cases ─────────────────────────────────────────────────

        describe('exception cases', () => {
            it('releases only the successfully acquired locks on partial conflict', async () => {
                // seat1 acquired (OK), seat2 already locked (null)
                redis = makeRedisMock(withConflictsAt(seats.length, [1]));
                service = new TicketService(redis as any, prisma as any);

                await service.reserveSeats(seats, user);

                expect(redis.del).toHaveBeenCalledWith([`seat_lock_${seat1.id}`]);
            });

            it('does not call del when no locks were acquired', async () => {
                redis = makeRedisMock(withConflictsAt(seats.length, [0, 1]));
                service = new TicketService(redis as any, prisma as any);

                await service.reserveSeats(seats, user);

                expect(redis.del).not.toHaveBeenCalled();
            });

            it('does not call del when WATCH fires', async () => {
                redis = makeRedisMock(null);
                service = new TicketService(redis as any, prisma as any);

                await service.reserveSeats(seats, user);

                expect(redis.del).not.toHaveBeenCalled();
            });

            it('does not write OrderSeats to DB when any lock fails', async () => {
                redis = makeRedisMock(withConflictsAt(seats.length, [0]));
                service = new TicketService(redis as any, prisma as any);

                await service.reserveSeats(seats, user);

                expect(prisma.orderSeats.createMany).not.toHaveBeenCalled();
            });

            it('does not write OrderSeats to DB when WATCH fires', async () => {
                redis = makeRedisMock(null);
                service = new TicketService(redis as any, prisma as any);

                await service.reserveSeats(seats, user);

                expect(prisma.orderSeats.createMany).not.toHaveBeenCalled();
            });

            it('treats a command-level error reply as a lock failure', async () => {
                redis = makeRedisMock(withErrorAt(seats.length, [0]));
                service = new TicketService(redis as any, prisma as any);

                const result = await service.reserveSeats(seats, user);

                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.conflict_seat_ids).toContainEqual(seat1);
                }
            });

            it('propagates when redis.watch rejects', async () => {
                redis.watch.mockRejectedValue(new Error('Redis connection lost'));

                await expect(service.reserveSeats(seats, user)).rejects.toThrow('Redis connection lost');
            });

            it('propagates when prisma.order.findMany rejects', async () => {
                prisma.order.findMany.mockRejectedValue(new Error('DB connection lost'));

                await expect(service.reserveSeats(seats, user)).rejects.toThrow('DB connection lost');
            });

            it('propagates when prisma.orderSeats.createMany rejects after locks are acquired', async () => {
                prisma.orderSeats.createMany.mockRejectedValue(new Error('DB write failed'));

                await expect(service.reserveSeats(seats, user)).rejects.toThrow('DB write failed');
            });
        });
    });
});