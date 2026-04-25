/**
 * webhooks.service.unit.test.ts
 *
 * Behavior-driven unit tests for WebhooksService.handleSuccess() and
 * WebhooksService.handleFailure().
 *
 * Design principles:
 *  - Tests describe WHAT the service does, not HOW it does it.
 *  - Mocks only define the external state of the world (DB records) — they do
 *    not assert on which Prisma method was called or how many times.
 *  - Exception: since both functions return void, the observable effect IS the
 *    DB-state transition. Mocks are checked at a high level (did the right
 *    update reach the DB?) to verify behavior, not to pin implementation.
 *  - A full rewrite of the internals should not break any test here, as long as
 *    the DB state ends up the same.
 *
 * Boundary conditions captured:
 *  handleSuccess
 *   - Valid input: completes without throwing
 *   - user_uuid: missing / empty string
 *   - idempotency_key: missing / empty string
 *   - payment_intent: missing / empty string
 *   - DB reflects CONFIRMED order and SOLD seats after a successful call
 *   - OrderSeats are deleted after a successful call
 *   - Edge case: order with no connected seats completes without throwing
 *   - Error propagation: order.update throws, seat.updateMany throws
 *
 *  handleFailure
 *   - Valid input: completes without throwing
 *   - user_uuid: missing / empty string
 *   - idempotency_key: missing / empty string
 *   - DB reflects FAILED order and AVAILABLE seats after a successful call
 *   - OrderSeats are deleted after a successful call
 *   - Edge case: order with no connected seats completes without throwing
 *   - Error propagation: order.update throws, seat.updateMany throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhooksService } from './webhooks.service';
import { OrderStatus, SeatStatus } from '@prisma/client';
import ResourceNotFoundError from '../../lib/custom_errors/ResourceNotFoundError';

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
//
// vi.mock is hoisted — vi.hoisted() lets us share a stable fn reference into
// the stripe factory so individual tests can inspect refunds.create calls.
// ─────────────────────────────────────────────────────────────────────────────

const { mockRefundsCreate } = vi.hoisted(() => ({
    mockRefundsCreate: vi.fn().mockResolvedValue({ id: 'refund_123' }),
}));

vi.mock('stripe', () => ({
    default: vi.fn(function () {
        return { refunds: { create: mockRefundsCreate } };
    }),
}));

// Minimal no-op mock — prevents errors when the service constructor calls
// `new Queue(...)`. The actual queue instance is injected per-test in buildService.
vi.mock('bullmq', () => ({
    Queue: vi.fn(class { } as any),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = 'user-uuid-1';
const IDEMPOTENCY_KEY = 'idem-key-uuid-1';
const ORDER_ID = 'order-uuid-1';
const PAYMENT_INTENT = 'pi_test_123';

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build an array of n distinct seat id strings. */
const makeSeatIds = (n: number, prefix = 'seat-uuid-'): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** Build an Order record. */
const makeOrder = (overrides: Partial<{ id: string; order_status: OrderStatus }> = {}) => ({
    id: ORDER_ID,
    user_id: USER_ID,
    order_status: OrderStatus.FAILED,
    idempotency_key: IDEMPOTENCY_KEY,
    ...overrides,
});

/** Build an array of OrderSeats records referencing the given seat ids. */
const makeOrderSeats = (seatIds: string[]) =>
    seatIds.map((seat_id, index) => ({
        id: `order-seat-${seat_id}`,
        order_id: ORDER_ID,
        seat_id,
        price_at_purchase: 10000,
        seat: {
            row: 'A',
            number: index,
            event: {
                name: "Test Event Name",
                description: "Test Event Description"
            }
        }
    }));

/** Build a Seat record as returned by updateManyAndReturn. */
const makeSeatRecord = (id: string, index: number) => ({
    id,
    row: 'A',
    number: index + 1,
    event_id: 'event-uuid-1',
    seat_status: SeatStatus.SOLD,
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
//
// Exposed surface:
//  • prisma.order.update     — controls the updated-order returned to the service
//  • prisma.orderSeats.findMany — controls which OrderSeats are tied to the order
//  • prisma.orderSeats.deleteMany — silenced (returns a count)
//  • prisma.seat.updateMany  — can be made to throw to simulate a DB error
//
// Everything else is a no-op so the happy path works out of the box.
// ─────────────────────────────────────────────────────────────────────────────

const makePrismaMock = ({
    seatIds = makeSeatIds(2),
    orderUpdateResult = makeOrder(),
    orderUpdateError = undefined as Error | undefined,
    seatUpdateError = undefined as Error | undefined,
    // Controls what findUnique returns for the idempotency check.
    // Defaults to PENDING so the happy path proceeds normally.
    findUniqueResult = makeOrder({ order_status: OrderStatus.PENDING }) as ReturnType<typeof makeOrder> | null,
    // Controls how many seat rows updateManyAndReturn reports as updated.
    // Defaults to seatIds.length (all rows updated = no mismatch).
    // Set to a smaller value to trigger the refund-and-revert path.
    seatUpdateCount = undefined as number | undefined,
} = {}) => {
    const effectiveCount = seatUpdateCount ?? seatIds.length;
    const seatRecords = seatIds.slice(0, effectiveCount).map((id, i) => makeSeatRecord(id, i));

    return {
        order: {
            findUnique: vi.fn().mockResolvedValue(findUniqueResult),
            update: orderUpdateError
                ? vi.fn().mockRejectedValue(orderUpdateError)
                : vi.fn().mockResolvedValue(orderUpdateResult),
        },
        orderSeats: {
            findMany: vi.fn().mockResolvedValue(makeOrderSeats(seatIds)),
            deleteMany: vi.fn().mockResolvedValue({ count: seatIds.length }),
        },
        seat: {
            // Used for the initial SOLD update — returns the updated seat records.
            updateManyAndReturn: seatUpdateError
                ? vi.fn().mockRejectedValue(seatUpdateError)
                : vi.fn().mockResolvedValue(seatRecords),
            // Used only in the revert path to set seats back to AVAILABLE.
            updateMany: vi.fn().mockResolvedValue({ count: seatIds.length }),
        },
        event: {
            findUnique: vi.fn().mockResolvedValue({
                id: 'event-uuid-1',
                name: 'Test Event',
                description: 'A test event',
            }),
        },
    };
};

/** Build a Queue mock with a spy on `add`. */
const makeQueueMock = () => ({
    add: vi.fn().mockResolvedValue({}),
});

/** Build the service under test with the given world state. */
const buildService = (options: Parameters<typeof makePrismaMock>[0] = {}) => {
    const prismaMock = makePrismaMock(options);
    const queueMock = makeQueueMock();
    const service = new WebhooksService(prismaMock as any, queueMock as any);
    (service as any).reservation_queue = queueMock;
    return { service, prismaMock, queueMock };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests — handleSuccess
// ─────────────────────────────────────────────────────────────────────────────

describe('WebhooksService.handleSuccess — behavior', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('completes without throwing for valid user_uuid, idempotency_key, and payment_intent', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT)).resolves.toBeUndefined();
            });
        });

        describe('exception cases — missing user_uuid', () => {
            it('throws ResourceNotFoundError when user_uuid is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(undefined, IDEMPOTENCY_KEY, PAYMENT_INTENT))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_uuid is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess('', IDEMPOTENCY_KEY, PAYMENT_INTENT))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing idempotency_key', () => {
            it('throws ResourceNotFoundError when idempotency_key is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, undefined, PAYMENT_INTENT))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when idempotency_key is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, '', PAYMENT_INTENT))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing payment_intent', () => {
            it('throws ResourceNotFoundError when payment_intent is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, undefined))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when payment_intent is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, ''))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. DB state transitions
    // =========================================================================

    describe('DB state transitions', () => {

        it('updates the Order to CONFIRMED status', async () => {
            const { service, prismaMock } = buildService();

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.data.order_status).toBe(OrderStatus.CONFIRMED);
        });

        it('updates the Order filtered by user_id, idempotency_key, and PENDING status', async () => {
            const { service, prismaMock } = buildService();

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.where).toMatchObject({
                user_id: USER_ID,
                idempotency_key: IDEMPOTENCY_KEY,
                order_status: OrderStatus.PENDING,
            });
        });

        it('updates connected Seats to SOLD status', async () => {
            const seatIds = makeSeatIds(3);
            const { service, prismaMock } = buildService({ seatIds });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            const updateCall = prismaMock.seat.updateManyAndReturn.mock.calls[0][0];
            expect(updateCall.data.seat_status).toBe(SeatStatus.SOLD);
            expect(updateCall.where.id.in).toEqual(expect.arrayContaining(seatIds));
        });

        it('filters the Seat update to only RESERVED seats to avoid overwriting already-sold seats', async () => {
            const seatIds = makeSeatIds(3);
            const { service, prismaMock } = buildService({ seatIds });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            const updateCall = prismaMock.seat.updateManyAndReturn.mock.calls[0][0];
            expect(updateCall.where).toMatchObject({ seat_status: SeatStatus.RESERVED });
        });
    });

    // =========================================================================
    // 3. Idempotency guards
    // =========================================================================

    describe('idempotency guards', () => {

        it('returns early without writing to the DB when the order is already CONFIRMED', async () => {
            const { service, prismaMock } = buildService({
                findUniqueResult: makeOrder({ order_status: OrderStatus.CONFIRMED }),
            });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            expect(prismaMock.order.update).not.toHaveBeenCalled();
        });

        it('returns early without writing to the DB when the order is already FAILED', async () => {
            const { service, prismaMock } = buildService({
                findUniqueResult: makeOrder({ order_status: OrderStatus.FAILED }),
            });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            expect(prismaMock.order.update).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 4. Edge cases
    // =========================================================================

    describe('edge cases', () => {
        // CHECK
        it('completes without throwing when the order has no connected seats', async () => {
            const { service } = buildService({ seatIds: [] });

            await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT)).resolves.toBeUndefined();
        });
    });

    // =========================================================================
    // 5. Seat count mismatch — refund and revert
    //
    // When sold_seats.count < connected_seat_ids.length, at least one seat was
    // already in a non-RESERVED state (race condition / double-booking).
    // The service should: refund via Stripe, revert the Order to FAILED, and
    // revert all connected Seats to AVAILABLE.
    // =========================================================================

    describe('seat count mismatch — refund and revert', () => {

        it('initiates a Stripe refund with the correct payment_intent when sold seat count does not match', async () => {
            const seatIds = makeSeatIds(2);
            const { service } = buildService({ seatIds, seatUpdateCount: 1 });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: PAYMENT_INTENT });
        });

        it('reverts the Order to FAILED when sold seat count does not match', async () => {
            const seatIds = makeSeatIds(2);
            const { service, prismaMock } = buildService({ seatIds, seatUpdateCount: 1 });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            const revertCall = prismaMock.order.update.mock.calls[1][0];
            expect(revertCall.data.order_status).toBe(OrderStatus.FAILED);
        });

        it('reverts all connected Seats to AVAILABLE when sold seat count does not match', async () => {
            const seatIds = makeSeatIds(2);
            const { service, prismaMock } = buildService({ seatIds, seatUpdateCount: 1 });

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT);

            const revertCall = prismaMock.seat.updateMany.mock.calls[0][0];
            expect(revertCall.data.seat_status).toBe(SeatStatus.AVAILABLE);
        });

        it('completes without throwing when the mismatch triggers a revert', async () => {
            const seatIds = makeSeatIds(2);
            const { service } = buildService({ seatIds, seatUpdateCount: 1 });

            await expect(
                service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT)
            ).resolves.toBeUndefined();
        });
    });

    // =========================================================================
    // 6. Error propagation
    // =========================================================================

    describe('error propagation', () => {

        it('propagates an error thrown by order.update (e.g. order not found)', async () => {
            const dbError = new Error('Order not found');
            const { service } = buildService({ orderUpdateError: dbError });

            await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT))
                .rejects.toThrow('Order not found');
        });

        it('propagates an error thrown by seat.updateMany', async () => {
            const dbError = new Error('Seat update failed');
            const { service } = buildService({ seatUpdateError: dbError });

            await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY, PAYMENT_INTENT))
                .rejects.toThrow('Seat update failed');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — handleFailure
// ─────────────────────────────────────────────────────────────────────────────

describe('WebhooksService.handleFailure — behavior', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('completes without throwing for valid user_uuid and idempotency_key', async () => {
                const { service } = buildService();

                await expect(service.handleFailure(USER_ID, IDEMPOTENCY_KEY)).resolves.toBeUndefined();
            });
        });

        describe('exception cases — missing user_uuid', () => {
            it('throws ResourceNotFoundError when user_uuid is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleFailure(undefined, IDEMPOTENCY_KEY))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_uuid is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleFailure('', IDEMPOTENCY_KEY))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing idempotency_key', () => {
            it('throws ResourceNotFoundError when idempotency_key is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleFailure(USER_ID, undefined))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when idempotency_key is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleFailure(USER_ID, ''))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. Idempotency guards
    // =========================================================================

    describe('idempotency guards', () => {

        it('returns early without writing to the DB when the order is already FAILED', async () => {
            const { service, prismaMock } = buildService({
                findUniqueResult: makeOrder({ order_status: OrderStatus.FAILED }),
            });

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            expect(prismaMock.order.update).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 3. DB state transitions
    // =========================================================================

    describe('DB state transitions', () => {

        it('updates the Order to FAILED status', async () => {
            const { service, prismaMock } = buildService();

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.data.order_status).toBe(OrderStatus.FAILED);
        });

        it('updates the Order filtered by user_id, idempotency_key', async () => {
            // filter does not filter by status, regardless of status the correct action is to expire the order upon a failed webhook call
            const { service, prismaMock } = buildService();

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.where).toMatchObject({
                user_id: USER_ID,
                idempotency_key: IDEMPOTENCY_KEY,
            });
        });

        it('should not delete connected OrderSeats after updating the order', async () => {
            const seatIds = makeSeatIds(2);
            const { service, prismaMock } = buildService({ seatIds });

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            expect(prismaMock.orderSeats.deleteMany).toHaveBeenCalledTimes(0);
        });
    });

    // =========================================================================
    // 4. Edge cases
    // =========================================================================

    describe('edge cases', () => {

        it('completes without throwing when the order has no connected seats', async () => {
            const { service } = buildService({ seatIds: [] });

            await expect(service.handleFailure(USER_ID, IDEMPOTENCY_KEY)).resolves.toBeUndefined();
        });
    });

    // =========================================================================
    // 5. Error propagation
    // =========================================================================

    describe('error propagation', () => {

        it('propagates an error thrown by order.update (e.g. order not found)', async () => {
            const dbError = new Error('Order not found');
            const { service } = buildService({ orderUpdateError: dbError });

            await expect(service.handleFailure(USER_ID, IDEMPOTENCY_KEY))
                .rejects.toThrow('Order not found');
        });
    });
});
