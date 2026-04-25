export default class EmailError extends Error {

    constructor(message: string) {
        super(message);
        this.name = "EmailError";

        Object.setPrototypeOf(this, EmailError.prototype);
    }
}