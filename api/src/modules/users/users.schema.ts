import { type FastifySchema } from "fastify";

// GET /me
export const getMeSchema: FastifySchema = {
    headers: {
        type: "object",
        required: ["authorization"],
        properties: {
            authorization: {
                type: "string",
                description: "Bearer JWT access token — 'Bearer <token>'"
            }
        }
    },
    response: {
        200: {
            description: "Authenticated user profile.",
            type: "object",
            properties: {
                email: { type: "string" },
                username: { type: "string" },
                created_at: { type: "string", format: "date-time" },
                user_uuid: { type: "string" },
                refresh_token_expires_at: { type: ["string", "null"], format: "date-time" }
            }
        },
        403: {
            description: "Access token is missing, invalid, or expired.",
            type: "object",
            properties: { message: { type: "string" } }
        },
        404: {
            description: "User not found.",
            type: "object",
            properties: { message: { type: "string" } }
        },
        500: {
            description: "Internal server error.",
            type: "object",
            properties: { message: { type: "string" } }
        }
    }
};

// GET /me/orders
export const getMeOrdersSchema: FastifySchema = {
    headers: {
        type: "object",
        required: ["authorization"],
        properties: {
            authorization: {
                type: "string",
                description: "Bearer JWT access token — 'Bearer <token>'"
            }
        }
    },
    response: {
        200: {
            description: "All orders associated with the authenticated user.",
            type: "array",
            items: {
                type: "object",
                properties: {
                    order_id: { type: "string" },
                    event_name: { type: "string" },
                    event_description: { type: ["string", "null"] },
                    event_date: { type: "string", format: "date-time" },
                    order_status: {
                        type: "string",
                        enum: ["PENDING", "CONFIRMED", "FAILED", "EXPIRED"]
                    },
                    created_at: { type: "string", format: "date-time" },
                    seat_names: {
                        type: "array",
                        items: { type: "string" }
                    },
                    total_price: { type: "integer" }
                }
            }
        },
        403: {
            description: "Access token is missing, invalid, or expired.",
            type: "object",
            properties: { message: { type: "string" } }
        },
        404: {
            description: "User not found.",
            type: "object",
            properties: { message: { type: "string" } }
        },
        500: {
            description: "Internal server error.",
            type: "object",
            properties: { message: { type: "string" } }
        }
    }
};
