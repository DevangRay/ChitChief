import { PrismaClient, SeatStatus } from "@prisma/client";

export async function createSeatFixture(
    prisma: PrismaClient,
    overrides: Partial<{ row: string; number: number; price: number; status: SeatStatus }> = {}
) {
    const event = await prisma.event.create({
        data: {
            name: "Test Event",
            venue: "Test Venue",
            date: new Date('2026-06-15T20:00:00Z')
        }
    });

    const seat = await prisma.seat.create({
        data: {
            event_id: event.id,
            row: overrides.row ?? 'A',
            number: overrides.number ?? 1,
            price: overrides.price ?? 10000,
            seat_status: overrides.status ?? 'AVAILABLE'
        }
    });

    return {event, seat};
}