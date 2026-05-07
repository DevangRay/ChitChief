import { type FastifySchema } from "fastify";

// GET /me
export const getMeSchema: FastifySchema = {
    tags: ["Users"],
    description: "Get the authenticated user's profile information.",
    security: [{ bearerAuth: [] }],
    headers: {
        type: "object",
        required: ["authorization"],
        properties: {
            authorization: {
                type: "string",
                description: "Bearer JWT access token — 'Bearer <token>'",
                examples: ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"]
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
    tags: ["Users"],
    description: "Get all orders associated with the authenticated user, including event details, seat names, total price, and order status.",
    security: [{ bearerAuth: [] }],
    headers: {
        type: "object",
        required: ["authorization"],
        properties: {
            authorization: {
                type: "string",
                description: "Bearer JWT access token — 'Bearer <token>'",
                examples: ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"]
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
