import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReservationService } from './tickets.service';

const mockRedis = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    pipeline: vi.fn()
}

const mockPrisma = {
    seat: {
        findMany: vi.fn(),
        updateMany: vi.fn()
    }
}

describe('ReservationService', () => {
    let service: ReservationService;

    beforeEach(() => {
        vi.clearAllMocks()
        service = new ReservationService(mockRedis as any, mockPrisma as any)
    })

    describe('reserveSeats', () => {
        // Normal case
        it('should return a reservation token when seats are available', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([
                { id: 'seat-1', seat_status: 'AVAILABLE', price: 10000 }
            ]);

            mockRedis.pipeline.mockReturnValue({
                set: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([['OK']])
            });

            const result = await service.reserveSeats(['seat-1'], 'user-1');

            expect(result.success).toBe(true);
            if (result.success === true) {
                expect(result.reservation_token).toBeDefined();
                expect(result.expires_at).toBeDefined();
            }
        })

        it('should lock multiple seats atomically', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([
                { id: 'seat-1', seat_status: 'AVAILABLE', price: 10000 },
                { id: 'seat-2', seat_status: 'AVAILABLE', price: 10000 },
            ])
            const mockPipeline = {
                set: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([['OK'], ['OK']])
            }
            mockRedis.pipeline.mockReturnValue(mockPipeline)

            await service.reserveSeats(['seat-1', 'seat-2'], 'user-1')

            // Pipeline should have been called once with both locks
            expect(mockPipeline.set).toHaveBeenCalledTimes(2)
            expect(mockPipeline.set).toHaveBeenCalledWith(
                'lock:seat:seat-1',
                'user-1',
                'EX', 60,
                'NX'
            )
        })

        // Boundary cases
        it('should reject an empty seat list', async () => {
            await expect(service.reserveSeats([], 'user-1'))
                .rejects.toThrow('At least one seat must be selected')
        })

        it('should reject more than 10 seats in a single reservation', async () => {
            const seats = Array.from({ length: 11 }, (_, i) => `seat-${i}`)
            await expect(service.reserveSeats(seats, 'user-1'))
                .rejects.toThrow('Cannot reserve more than 10 seats at once')
        })

        // Exception cases
        it('should return 409 when a seat is already reserved', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([
                { id: 'seat-1', seat_status: 'RESERVED', price: 10000 }
            ])

            const result = await service.reserveSeats(['seat-1'], 'user-1')

            expect(result.success).toBe(false)
            if (result.success === false) {
                expect(result.conflict_seat_ids).toContain('seat-1')
            }
        })

        it('should return 409 when a seat is already sold', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([
                { id: 'seat-1', seat_status: 'SOLD', price: 10000 }
            ])

            const result = await service.reserveSeats(['seat-1'], 'user-1')

            expect(result.success).toBe(false)
            if (result.success === false) {
                expect(result.conflict_seat_ids).toContain('seat-1')
            }
        })

        it('should return 404 when a seat does not exist', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([]) // DB returns nothing

            await expect(service.reserveSeats(['nonexistent-id'], 'user-1'))
                .rejects.toThrow('One or more seats not found')
        })

        it('should release all locks if any lock in the pipeline fails', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([
                { id: 'seat-1', seat_status: 'AVAILABLE', price: 10000 },
                { id: 'seat-2', seat_status: 'AVAILABLE', price: 10000 },
            ])
            // seat-2 lock fails (returns null = NX condition not met)
            const mockPipeline = {
                set: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([['OK'], [null]])
            }
            mockRedis.pipeline.mockReturnValue(mockPipeline)
            mockRedis.del.mockResolvedValue(1)

            const result = await service.reserveSeats(['seat-1', 'seat-2'], 'user-1')

            expect(result.success).toBe(false)
            // Should have cleaned up seat-1's lock even though it succeeded
            expect(mockRedis.del).toHaveBeenCalledWith('lock:seat:seat-1')
        })
    })

    describe('releaseReservation', () => {
        it('should delete redis lock and set seat back to AVAILABLE', async () => {
            mockRedis.del.mockResolvedValue(1)
            mockPrisma.seat.updateMany.mockResolvedValue({ count: 1 })

            await service.releaseReservation(['seat-1'])

            expect(mockRedis.del).toHaveBeenCalledWith('lock:seat:seat-1')
            expect(mockPrisma.seat.updateMany).toHaveBeenCalledWith({
                where: { id: { in: ['seat-1'] } },
                data: { seat_status: 'AVAILABLE' }
            })
        })

        it('should handle releasing a lock that has already expired', async () => {
            mockRedis.del.mockResolvedValue(0) // 0 = key didn't exist
            mockPrisma.seat.updateMany.mockResolvedValue({ count: 1 })

            // Should not throw — this is a valid state
            await expect(service.releaseReservation(['seat-1']))
                .resolves.not.toThrow()
        })
    })
})