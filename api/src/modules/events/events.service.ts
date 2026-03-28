import { PrismaClient, SeatStatus } from "@prisma/client";

export class EventsService {
    constructor(private readonly prisma: PrismaClient) { }

    async getEvents() {
        const events = await this.prisma.event.findMany({
            where: {
                date: {
                    gte: new Date()
                }
            },
            orderBy: { date: "asc" }
        });

        return events
    }

    async getEventById(id: string) {
        const unique_event = await this.prisma.event.findUnique({
            where: {
                id: id
            },
            include: {
                _count: {
                    select: {
                        seats: {
                            where: {
                                seat_status: 'AVAILABLE'
                            }
                        }
                    }
                }
            }
        });

        if (!unique_event) {
            return {};
        }

        const return_object = {
            id: unique_event.id,
            name: unique_event.name,
            description: unique_event.description,
            venue: unique_event.venue,
            date: unique_event.date,
            created_at: unique_event.created_at,
            seat_count: unique_event._count.seats
        }

        return return_object;
    }

    async getSeatsForEventById(id: string, status?: SeatStatus) {
        const event_seats = await this.prisma.seat.findMany({
            where: {
                event_id: id,
                ...(status && { seat_status: status })
            },
            orderBy: {
                price: "asc"
            }
        });

        return event_seats;
    }
}