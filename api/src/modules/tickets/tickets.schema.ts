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

// POST /reserve
export const createPaymentIntentSchema: FastifySchema = {
    body: {
        type: "object",
        required: ["reservation_token", "user_uuid", "idempotency_key"],
        properties: {
            reservation_token: {
                type: "string",
                description: "JWT Signed Reservation token from [POST] /tickets/reserve endpoint"
            },
            user_uuid: {
                type: "string",
                format: "uuid",
                description: "User UUID."
            },
            idempotency_key: {
                type: "string",
                description: "Unique Idempotency Key"
            }
        }
    },
    response: {
        200: {
            description: "Payment intent was successfully created.",
            type: "object",
            properties: {
                client_secret: { type: "string" },
                order_id: { type: "string" }
            }
        },
        403: {
            description: "One or more of the parameters are improperly configured.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        404: {
            description: "One or more of the parameters was invalid or did not exist.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        409: {
            description: "A resource, such as temporary seat lock, was expired.",
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