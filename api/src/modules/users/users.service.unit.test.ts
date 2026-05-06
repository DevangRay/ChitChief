/**
 * users.service.unit.test.ts
 *
 * Behavior-driven unit tests for UserService.getProfile() and UserService.getOrders()
 *
 * Design principles:
 *  - Tests describe WHAT the service does, not HOW it does it.
 *  - Mocks only define the external state of the world (DB records, token state)
 *    — they do not assert on internal implementation calls such as which Prisma
 *    method was used or how many times it was called.
 *  - The only detail we pin to is the shape of the return value, which is the
 *    public contract of the service.
 *  - A full rewrite of the internals should not break any test here.
 *
 * Boundary conditions captured:
 *  - user_id: missing, empty, valid
 *  - User: found, not found
 *  - Refresh token: present with future expiry, absent (user logged out)
 *  - Orders: none, one, many
 *  - Seats per order: one, many, none
 *  - Seat name formatting: row + number (e.g. "A1", "C12")
 *  - Total price: single seat, multiple seats with different prices, zero seats
 *  - Error propagation: DB throws unexpected errors
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserService } from './users.service';
import { OrderStatus, SeatStatus } from '@prisma/client';
import ResourceNotFoundError from '../../lib/custom_errors/ResourceNotFoundError';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = 'user-uuid-1';
const USER_EMAIL = 'user@example.com';
const USER_NAME = 'testuser';
const ORDER_ID = 'order-uuid-1';
const EVENT_ID = 'event-uuid-1';
const IDEMPOTENCY_KEY = 'idem-key-uuid-1';

const EXPECTED_PROFILE_RETURN_OBJECT = {
    email: expect.any(String),
    username: expect.any(String),
    created_at: expect.any(Date),
};

const EXPECTED_ORDER_RETURN_OBJECT = {
    order_id: expect.any(String),
    event_name: expect.any(String),
    event_date: expect.any(Date),
    order_status: expect.any(String),
    created_at: expect.any(Date),
    seat_names: expect.any(Array),
    total_price: expect.any(Number),
};

// ─────────────────────────────────────────────────────────────────────────────
// Data helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a User record with an embedded refresh_token that the service can
 * access via a single DB query (e.g. Prisma include). The test only exposes
 * expires_at since that is the only field the contract cares about.
 */
const makeUser = (refreshTokenExpiresAt: Date | null = new Date(Date.now() + 60 * 1000)) => ({
    id: USER_ID,
    email: USER_EMAIL,
    username: USER_NAME,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    password_hash: 'hashed-password',
    refresh_token: [refreshTokenExpiresAt ? { expires_at: refreshTokenExpiresAt } : null],
});

const makeEvent = (overrides: object = {}) => ({
    id: EVENT_ID,
    name: 'Test Concert',
    description: 'A great show',
    venue: 'Madison Square Garden',
    date: new Date('2024-12-25T19:00:00.000Z'),
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
});

const makeSeat = (row: string, number: number, overrides: object = {}) => ({
    id: `seat-uuid-${row}${number}`,
    event_id: EVENT_ID,
    row,
    number,
    price: 10000,
    seat_status: SeatStatus.SOLD,
    event: makeEvent(),
    ...overrides,
});

const makeOrderSeat = (row: string, number: number, price_at_purchase = 10000) => ({
    id: `os-uuid-${row}${number}`,
    order_id: ORDER_ID,
    seat_id: `seat-uuid-${row}${number}`,
    price_at_purchase,
    created_at: new Date('2024-06-01T00:00:00.000Z'),
    seat: makeSeat(row, number),
});

const makeOrder = (overrides: object = {}) => ({
    id: ORDER_ID,
    user_id: USER_ID,
    order_status: OrderStatus.CONFIRMED,
    idempotency_key: IDEMPOTENCY_KEY,
    stripe_payment_id: 'spi-uuid-1',
    created_at: new Date('2024-06-01T00:00:00.000Z'),
    order_seats: [makeOrderSeat('A', 1)],
    ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
//
// Each factory builds only the Prisma surface that the service needs for the
// given method. The parameters represent the state of the external world (what
// the DB contains), not which internal methods are called.
// ─────────────────────────────────────────────────────────────────────────────

const buildProfileService = ({
    userExists = true,
    refreshTokenExpiresAt = new Date(Date.now() + 60 * 1000) as Date | null,
    dbError = undefined as Error | undefined,
} = {}) => {
    const prismaMock = {
        user: {
            findUnique: dbError
                ? vi.fn().mockRejectedValue(dbError)
                : vi.fn().mockResolvedValue(
                    userExists ? makeUser(refreshTokenExpiresAt) : null,
                ),
        },
    };

    const service = new UserService(prismaMock as any);
    return { service, prismaMock };
};

const buildOrdersService = ({
    userExists = true,
    orders = [makeOrder()] as any[],
    dbError = undefined as Error | undefined,
    refreshTokenExpiresAt = new Date(Date.now() + 60 * 1000) as Date | null
} = {}) => {
    const prismaMock = {
        user: {
            findUnique: dbError
                ? vi.fn().mockRejectedValue(dbError)
                : vi.fn().mockResolvedValue(
                    userExists ? makeUser(refreshTokenExpiresAt) : null,
                ),
        },
        order: {
            findMany: dbError
                ? vi.fn().mockRejectedValue(dbError)
                : vi.fn().mockResolvedValue(orders),
        },
    };

    const service = new UserService(prismaMock as any);
    return { service, prismaMock };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests — getProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('UserService.getProfile — behavior', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('exception cases — missing or empty user_id', () => {
            it('throws ResourceNotFoundError when user_id is an empty string', async () => {
                const { service } = buildProfileService();
                await expect(service.getProfile('')).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_id is null', async () => {
                const { service } = buildProfileService();
                await expect(service.getProfile(null as any)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_id is undefined', async () => {
                const { service } = buildProfileService();
                await expect(service.getProfile(undefined as any)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. User lookup
    // =========================================================================

    describe('user lookup', () => {

        describe('equivalence cases', () => {
            it('succeeds when the user exists in the database', async () => {
                const { service } = buildProfileService({ userExists: true });
                const result = await service.getProfile(USER_ID);
                expect(result).toMatchObject(EXPECTED_PROFILE_RETURN_OBJECT);
            });

            it('throws ResourceNotFoundError when the user does not exist', async () => {
                const { service } = buildProfileService({ userExists: false });
                await expect(service.getProfile(USER_ID)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by the database', async () => {
                const { service } = buildProfileService({ dbError: new Error('DB connection lost') });
                await expect(service.getProfile(USER_ID)).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 3. Return value contract
    // =========================================================================

    describe('return value contract', () => {

        describe('equivalence cases', () => {
            it('returns the correct email for the authenticated user', async () => {
                const { service } = buildProfileService();
                const result = await service.getProfile(USER_ID);
                expect(result.email).toBe(USER_EMAIL);
            });

            it('returns the correct username for the authenticated user', async () => {
                const { service } = buildProfileService();
                const result = await service.getProfile(USER_ID);
                expect(result.username).toBe(USER_NAME);
            });

            it('returns created_at as a Date', async () => {
                const { service } = buildProfileService();
                const result = await service.getProfile(USER_ID);
                expect(result.created_at).toBeInstanceOf(Date);
            });

            it('returns refresh_token_expires_at as a Date when a refresh token exists', async () => {
                const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
                const { service } = buildProfileService({ refreshTokenExpiresAt: expiresAt });
                const result = await service.getProfile(USER_ID);
                expect(result.refresh_token_expires_at).toBeInstanceOf(Date);
                expect(result.refresh_token_expires_at).toEqual(expiresAt);
            });

            it('throws error for refresh_token_expires_at when the user has no active session', async () => {
                const { service } = buildProfileService({ refreshTokenExpiresAt: null });
                await expect(service.getProfile(USER_ID)).rejects.toThrow();
            });
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — getOrders
// ─────────────────────────────────────────────────────────────────────────────

describe('UserService.getOrders — behavior', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('exception cases — missing or empty user_id', () => {
            it('throws ResourceNotFoundError when user_id is an empty string', async () => {
                const { service } = buildOrdersService();
                await expect(service.getOrders('')).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_id is null', async () => {
                const { service } = buildOrdersService();
                await expect(service.getOrders(null as any)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_id is undefined', async () => {
                const { service } = buildOrdersService();
                await expect(service.getOrders(undefined as any)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. Orders retrieval
    // =========================================================================

    describe('orders retrieval', () => {

        describe('equivalence cases', () => {
            it('returns an empty array when the user has no orders', async () => {
                const { service } = buildOrdersService({ orders: [] });
                const result = await service.getOrders(USER_ID);
                expect(result).toEqual([]);
            });

            it('returns an array with one item for a user with a single order', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const result = await service.getOrders(USER_ID);
                expect(result).toHaveLength(1);
            });

            it('returns an array with all orders for a user with multiple orders', async () => {
                const orders = [
                    makeOrder({ id: 'order-uuid-1' }),
                    makeOrder({ id: 'order-uuid-2', idempotency_key: 'idem-key-2' }),
                    makeOrder({ id: 'order-uuid-3', idempotency_key: 'idem-key-3' }),
                ];
                const { service } = buildOrdersService({ orders });
                const result = await service.getOrders(USER_ID);
                expect(result).toHaveLength(3);
            });
        });

        describe('exception cases', () => {
            it('propagates unexpected errors thrown by the database', async () => {
                const { service } = buildOrdersService({ dbError: new Error('DB connection lost') });
                await expect(service.getOrders(USER_ID)).rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 3. Return value contract — shape
    // =========================================================================

    describe('return value contract — shape', () => {

        describe('equivalence cases', () => {
            it('each order entry contains the required fields', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order).toMatchObject(EXPECTED_ORDER_RETURN_OBJECT);
            });

            it('returns the correct event name', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.event_name).toBe('Test Concert');
            });

            it('returns the correct event description', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.event_description).toBe('A great show');
            });

            it('returns null event_description when the event has no description', async () => {
                const seatWithNoDesc = {
                    ...makeOrderSeat('A', 1),
                    seat: { ...makeSeat('A', 1), event: { ...makeEvent(), description: null } },
                };
                const { service } = buildOrdersService({
                    orders: [makeOrder({ order_seats: [seatWithNoDesc] })],
                });
                const [order] = await service.getOrders(USER_ID);
                expect(order.event_description).toBeNull();
            });

            it('returns event_date as a Date', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.event_date).toBeInstanceOf(Date);
            });

            it('returns the correct order_status', async () => {
                const { service } = buildOrdersService({
                    orders: [makeOrder({ order_status: OrderStatus.CONFIRMED })],
                });
                const [order] = await service.getOrders(USER_ID);
                expect(order.order_status).toBe(OrderStatus.CONFIRMED);
            });

            it('returns created_at as a Date', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.created_at).toBeInstanceOf(Date);
            });
        });
    });

    // =========================================================================
    // 4. Seat names
    // =========================================================================

    describe('seat names', () => {

        describe('equivalence cases', () => {
            it('formats seat names as row concatenated with number (e.g. "A1")', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.seat_names).toContain('A1');
            });

            it('returns all seat names when an order has multiple seats', async () => {
                const multiSeatOrder = makeOrder({
                    order_seats: [
                        makeOrderSeat('A', 1),
                        makeOrderSeat('B', 3),
                        makeOrderSeat('C', 12),
                    ],
                });
                const { service } = buildOrdersService({ orders: [multiSeatOrder] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.seat_names).toEqual(expect.arrayContaining(['A1', 'B3', 'C12']));
                expect(order.seat_names).toHaveLength(3);
            });
        });

        describe('boundary cases', () => {
            it('returns an array with one seat name for a single-seat order', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.seat_names).toHaveLength(1);
            });
        });
    });

    // =========================================================================
    // 5. Total price
    // =========================================================================

    describe('total price', () => {

        describe('equivalence cases', () => {
            it('returns price_at_purchase as total_price for a single-seat order', async () => {
                const { service } = buildOrdersService({ orders: [makeOrder()] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.total_price).toBe(10000);
            });

            it('returns the sum of all seat prices_at_purchase for a multi-seat order', async () => {
                const multiSeatOrder = makeOrder({
                    order_seats: [
                        makeOrderSeat('A', 1, 10000),
                        makeOrderSeat('B', 2, 15000),
                        makeOrderSeat('C', 3, 20000),
                    ],
                });
                const { service } = buildOrdersService({ orders: [multiSeatOrder] });
                const [order] = await service.getOrders(USER_ID);
                expect(order.total_price).toBe(45000);
            });
        });

        describe('boundary cases', () => {
            it("throws error the order has no seats", async () => {
                const { service } = buildOrdersService({
                    orders: [makeOrder({ order_seats: [] })],
                });

                await expect(service.getOrders(USER_ID)).rejects.toThrow();
            });
        });
    });
});
