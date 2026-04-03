export default class SeatConflictError extends Error {
    public conflict_seat_ids: string[];

    constructor(message: string, conflict_seat_ids: string[]) {
        super(message);
        this.name = "SeatConflictError";

        this.conflict_seat_ids = conflict_seat_ids;

        Object.setPrototypeOf(this, SeatConflictError.prototype);
    }
}