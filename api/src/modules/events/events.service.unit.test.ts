import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventsService from "./events.service";

const mockPrisma = {
    event: {
        findOne: vi.fn(),
        findMany: vi.fn()
    },
    seat: {
        findMany: vi.fn()
    }
}

describe('EventService', () => {
    let service: EventsService;

    beforeEach(() => {
        vi.clearAllMocks()
        service = new EventsService(mockPrisma as any)
    })

    describe('getEvents', () => {
        it('Equivalence Test', async () => {
            mockPrisma.event.findMany.mockResolvedValue([
                {
                    id: 'event-1', seat_count: 10
                }
            ]);

            const result = await service.getEvents();
            expect(result.length).toBe(1);
        })

        it('Boundary Test. Empty array', async () => {
            mockPrisma.event.findMany.mockResolvedValue([]);

            const result = await service.getEvents();
            expect(result.length).toBe(0);
        })

        it ('Exception Test', async () => {
            mockPrisma.event.findMany.mockRejectedValueOnce(new Error('SQL connection failed'));

            await expect(service.getEvents()).rejects.toThrow('SQL connection failed');
        })
    })
})