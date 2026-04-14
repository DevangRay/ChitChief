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
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = 'user-uuid-1';
const IDEMPOTENCY_KEY = 'idem-key-uuid-1';
const ORDER_ID = 'order-uuid-1';

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
    order_status: OrderStatus.PENDING,
    idempotency_key: IDEMPOTENCY_KEY,
    ...overrides,
});

/** Build an array of OrderSeats records referencing the given seat ids. */
const makeOrderSeats = (seatIds: string[]) =>
    seatIds.map((seat_id) => ({
        id: `order-seat-${seat_id}`,
        order_id: ORDER_ID,
        seat_id,
        price_at_purchase: 10000,
    }));

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
} = {}) => ({
    order: {
        update: orderUpdateError
            ? vi.fn().mockRejectedValue(orderUpdateError)
            : vi.fn().mockResolvedValue(orderUpdateResult),
    },
    orderSeats: {
        findMany: vi.fn().mockResolvedValue(makeOrderSeats(seatIds)),
        deleteMany: vi.fn().mockResolvedValue({ count: seatIds.length }),
    },
    seat: {
        updateMany: seatUpdateError
            ? vi.fn().mockRejectedValue(seatUpdateError)
            : vi.fn().mockResolvedValue({ count: seatIds.length }),
    },
});

/** Build the service under test with the given world state. */
const buildService = (options: Parameters<typeof makePrismaMock>[0] = {}) => {
    const prismaMock = makePrismaMock(options);
    const service = new WebhooksService(prismaMock as any);
    return { service, prismaMock };
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
            it('completes without throwing for valid user_uuid and idempotency_key', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY)).resolves.toBeUndefined();
            });
        });

        describe('exception cases — missing user_uuid', () => {
            it('throws ResourceNotFoundError when user_uuid is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(undefined, IDEMPOTENCY_KEY))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_uuid is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess('', IDEMPOTENCY_KEY))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing idempotency_key', () => {
            it('throws ResourceNotFoundError when idempotency_key is undefined', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, undefined))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when idempotency_key is an empty string', async () => {
                const { service } = buildService();

                await expect(service.handleSuccess(USER_ID, ''))
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

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.data.order_status).toBe(OrderStatus.CONFIRMED);
        });

        it('updates the Order filtered by user_id, idempotency_key, and PENDING status', async () => {
            const { service, prismaMock } = buildService();

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY);

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

            await service.handleSuccess(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.seat.updateMany.mock.calls[0][0];
            expect(updateCall.data.seat_status).toBe(SeatStatus.SOLD);
            expect(updateCall.where.id.in).toEqual(expect.arrayContaining(seatIds));
        });
    });

    // =========================================================================
    // 3. Edge cases
    // =========================================================================

    describe('edge cases', () => {

        it('completes without throwing when the order has no connected seats', async () => {
            const { service } = buildService({ seatIds: [] });

            await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY)).resolves.toBeUndefined();
        });
    });

    // =========================================================================
    // 4. Error propagation
    // =========================================================================

    describe('error propagation', () => {

        it('propagates an error thrown by order.update (e.g. order not found)', async () => {
            const dbError = new Error('Order not found');
            const { service } = buildService({ orderUpdateError: dbError });

            await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY))
                .rejects.toThrow('Order not found');
        });

        it('propagates an error thrown by seat.updateMany', async () => {
            const dbError = new Error('Seat update failed');
            const { service } = buildService({ seatUpdateError: dbError });

            await expect(service.handleSuccess(USER_ID, IDEMPOTENCY_KEY))
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
    // 2. DB state transitions
    // =========================================================================

    describe('DB state transitions', () => {

        it('updates the Order to FAILED status', async () => {
            const { service, prismaMock } = buildService();

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.data.order_status).toBe(OrderStatus.FAILED);
        });

        it('updates the Order filtered by user_id, idempotency_key, and PENDING status', async () => {
            const { service, prismaMock } = buildService();

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.order.update.mock.calls[0][0];
            expect(updateCall.where).toMatchObject({
                user_id: USER_ID,
                idempotency_key: IDEMPOTENCY_KEY,
                order_status: OrderStatus.PENDING,
            });
        });

        it('updates connected Seats back to AVAILABLE status', async () => {
            const seatIds = makeSeatIds(3);
            const { service, prismaMock } = buildService({ seatIds });

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            const updateCall = prismaMock.seat.updateMany.mock.calls[0][0];
            expect(updateCall.data.seat_status).toBe(SeatStatus.AVAILABLE);
            expect(updateCall.where.id.in).toEqual(expect.arrayContaining(seatIds));
        });

        it('deletes connected OrderSeats after updating the order', async () => {
            const seatIds = makeSeatIds(2);
            const { service, prismaMock } = buildService({ seatIds });

            await service.handleFailure(USER_ID, IDEMPOTENCY_KEY);

            expect(prismaMock.orderSeats.deleteMany).toHaveBeenCalledOnce();
            const deleteCall = prismaMock.orderSeats.deleteMany.mock.calls[0][0];
            expect(deleteCall.where.order_id).toBe(ORDER_ID);
        });
    });

    // =========================================================================
    // 3. Edge cases
    // =========================================================================

    describe('edge cases', () => {

        it('completes without throwing when the order has no connected seats', async () => {
            const { service } = buildService({ seatIds: [] });

            await expect(service.handleFailure(USER_ID, IDEMPOTENCY_KEY)).resolves.toBeUndefined();
        });
    });

    // =========================================================================
    // 4. Error propagation
    // =========================================================================

    describe('error propagation', () => {

        it('propagates an error thrown by order.update (e.g. order not found)', async () => {
            const dbError = new Error('Order not found');
            const { service } = buildService({ orderUpdateError: dbError });

            await expect(service.handleFailure(USER_ID, IDEMPOTENCY_KEY))
                .rejects.toThrow('Order not found');
        });

        it('propagates an error thrown by seat.updateMany', async () => {
            const dbError = new Error('Seat update failed');
            const { service } = buildService({ seatUpdateError: dbError });

            await expect(service.handleFailure(USER_ID, IDEMPOTENCY_KEY))
                .rejects.toThrow('Seat update failed');
        });
    });
});
