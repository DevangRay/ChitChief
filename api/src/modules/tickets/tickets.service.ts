type SuccessfulReservation = {
    success: true,
    reservation_token: string,
    expires_at: string
}

type FailedReservation = {
    success: false,
    conflict_seat_ids: string[]
}

type ReservationObject = SuccessfulReservation | FailedReservation

export class ReservationService {
    constructor(redis: any, prisma: any) { }

    async reserveSeats(seats: String[], user: String): Promise<ReservationObject> {
        throw new Error('Not implemented');
    }

    async releaseReservation(seats: String[]) {
        throw new Error('Not implemented');
    }
}