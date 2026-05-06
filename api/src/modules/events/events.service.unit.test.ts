import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventsService from "./events.service";

type SeatStatus = "AVAILABLE" | "RESERVED" | "SOLD";

const mockPrisma = {
    event: {
        findOne: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn()
    },
    seat: {
        findMany: vi.fn()
    }
}

const mockEvent = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Concert',
    description: 'A test concert event',
    venue: 'Test Venue',
    date: new Date(Date.now() + 86400000), // tomorrow
    created_at: new Date(),
    _count: { seats: 5 }
}

const mockSeat = {
    id: '223e4567-e89b-12d3-a456-426614174001',
    event_id: '123e4567-e89b-12d3-a456-426614174000',
    seat_status: 'AVAILABLE' as SeatStatus,
    price: 50.00
}

describe('EventService', () => {
    let service: EventsService;

    beforeEach(() => {
        vi.clearAllMocks()
        service = new EventsService(mockPrisma as any)
    })

    // -------------------------
    // getEvents()
    // -------------------------
    describe('getEvents', () => {
        it('Equivalence Test: returns array of future events', async () => {
            mockPrisma.event.findMany.mockResolvedValue([mockEvent]);

            const result = await service.getEvents();

            expect(result.length).toBe(1);
            expect(result[0]).toEqual(mockEvent);
        })

        it('Boundary Test: returns empty array when no events exist', async () => {
            mockPrisma.event.findMany.mockResolvedValue([]);

            const result = await service.getEvents();

            expect(result).toEqual([]);
            expect(result.length).toBe(0);
        })

        it('Exception Test: rethrows error on DB failure', async () => {
            mockPrisma.event.findMany.mockRejectedValueOnce(new Error('SQL connection failed'));

            await expect(service.getEvents()).rejects.toThrow('SQL connection failed');
        })
    })

    // -------------------------
    // getEventById(id)
    // -------------------------
    describe('getEventById', () => {
        const validId = '123e4567-e89b-12d3-a456-426614174000';

        it('Equivalence Test: returns event with seat_count when event exists', async () => {
            mockPrisma.event.findUnique.mockResolvedValue(mockEvent);

            const result = await service.getEventById(validId);

            expect(result).toMatchObject({
                id: mockEvent.id,
                name: mockEvent.name,
                description: mockEvent.description,
                venue: mockEvent.venue,
                date: mockEvent.date,
                created_at: mockEvent.created_at,
                seat_count: mockEvent._count.seats
            });
            // _count should not be exposed on the return object
            expect(result).not.toHaveProperty('_count');
        })

        it('Boundary Test: returns null when event does not exist', async () => {
            mockPrisma.event.findUnique.mockResolvedValue(null);

            const result = await service.getEventById(validId);

            expect(result).toEqual(null);
        })

        it('Boundary Test: returns seat_count of 0 when the event has no available seats', async () => {
            const eventWithNoAvailableSeats = { ...mockEvent, _count: { seats: 0 } };
            mockPrisma.event.findUnique.mockResolvedValue(eventWithNoAvailableSeats);

            const result = await service.getEventById(validId);

            expect(result).not.toBeNull();
            expect(result!.seat_count).toBe(0);
        })

        it('Exception Test: rethrows error on DB failure', async () => {
            mockPrisma.event.findUnique.mockRejectedValueOnce(new Error('SQL connection failed'));

            await expect(service.getEventById(validId)).rejects.toThrow('SQL connection failed');
        })
    })

    // -------------------------
    // getSeatsForEventById(id, status?)
    // -------------------------
    describe('getSeatsForEventById', () => {
        const validId = '123e4567-e89b-12d3-a456-426614174000';

        it('Equivalence Test: returns all seats for an event when no status filter provided', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([mockSeat]);

            const result = await service.getSeatsForEventById(validId);

            expect(result.length).toBe(1);
            expect(result[0]).toEqual(mockSeat);
        })

        it('Equivalence Test: returns only seats matching the provided status', async () => {
            const reservedSeat = { ...mockSeat, seat_status: 'RESERVED' as SeatStatus };
            mockPrisma.seat.findMany.mockResolvedValue([reservedSeat]);

            const result = await service.getSeatsForEventById(validId, 'RESERVED');

            expect(result.length).toBe(1);
            expect(result[0]?.seat_status).toBe('RESERVED');
        })

        it('Equivalence Test: each SeatStatus enum value is accepted as a valid filter', async () => {
            const statuses: SeatStatus[] = ['AVAILABLE', 'RESERVED', 'SOLD'];

            for (const status of statuses) {
                mockPrisma.seat.findMany.mockResolvedValue([{ ...mockSeat, seat_status: status }]);

                const result = await service.getSeatsForEventById(validId, status);

                expect(result[0]?.seat_status).toBe(status);
            }
        })

        it('Boundary Test: returns empty array when no seats match', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([]);

            const result = await service.getSeatsForEventById(validId, 'SOLD');

            expect(result).toEqual([]);
            expect(result.length).toBe(0);
        })
        it('Boundary Test: returns empty array when no seats exist and no status filter provided', async () => {
            mockPrisma.seat.findMany.mockResolvedValue([]);

            const result = await service.getSeatsForEventById(validId);

            expect(result).toEqual([]);
            expect(result.length).toBe(0);
        })

        it('Exception Test: rethrows error on DB failure', async () => {
            mockPrisma.seat.findMany.mockRejectedValueOnce(new Error('SQL connection failed'));

            await expect(service.getSeatsForEventById(validId, 'AVAILABLE')).rejects.toThrow('SQL connection failed');
        })
    })
})