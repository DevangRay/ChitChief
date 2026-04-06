import { FastifySchema } from "fastify";

// POST /reserve
export const reserveTicketSchema: FastifySchema = {
    body: {
        type: "object",
        required: ["seat_ids", "user_uuid"],
        properties: {
            seat_ids: {
                type: "array", items: {
                    type: "string"
                }
            },
            user_uuid: {
                type: "string",
                format: "uuid",
                description: "User UUID."
            }
        }
    },
    response: {
        200: {
            description: "Proof of successful ticket reservation.",
            type: "object",
            properties: {
                reservation_token: { type: "string" },
                expires_at: { type: "number" },
                expires_at_string: { type: "string" }
            }
        },
        404: {
            description: "Seat or User did not exist.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        409: {
            description: "One of the seats has already been reserved.",
            type: "object",
            properties: {
                message: { type: "string" },
                conflict_seat_ids: {
                    type: "array", items: {
                        type: "string"
                    }
                }
            }
        }
    }
} 