import { FastifySchema } from "fastify";

const seatSchema = {
    type: "object",
    properties: {
        id: { type: "string", format: "uuid" },
        event_id: { type: "string", format: "uuid" },
        row: { type: "string", examples: ["A"] },
        number: { type: "integer", examples: [1] },
        price: {
            type: "integer",
            description: "Price in cents. Divide by 100 for display value.",
            examples: [10000],
        },
        seat_status: {
            type: "string",
            enum: ["AVAILABLE", "RESERVED", "SOLD"],
        },
    },
} as const

const eventSchema = {
    type: "object",
    properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string", examples: ["BTS Arirang Tour"] },
        description: { type: "string", nullable: true },
        venue: { type: "string", examples: ["MetLife Stadium"] },
        date: { type: "string", format: "date-time" },
        created_at: { type: "string", format: "date-time" },
    },
} as const

// GET /events
export const getEventsSchema: FastifySchema = {
    response: {
        200: {
            description: "Description of matching event.",
            type: "array",
            items: eventSchema
        },
        500: {
            description: "Internal server error.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}

// GET /events/:id
export const getEventByIdSchema: FastifySchema = {
    params: {
        type: "object",
        required: ["id"],
        properties: {
            id: {
                type: "string",
                format: "uuid",
                description: "UUID of the event."
            }
        }
    },
    response: {
        200: {
            description: "Description of the specified event.",
            type: "object",
            properties: {
                ...eventSchema.properties,
                seat_count: {
                    type: "integer",
                    description: "Number of available seats."
                }
            }
        },
        404: {
            description: "Event not found.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        500: {
            description: "Internal server error.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}

export const getSeatsOfEventByIdSchema: FastifySchema = {
    params: {
        type: "object",
        required: ["id"],
        properties: {
            id: {
                type: "string",
                format: "uuid",
                description: "UUID of the event."
            }
        }
    },
    querystring: {
        type: "object",
        properties: {
            status: {
                type: "string",
                enum: ["AVAILABLE", "RESERVED", "SOLD"],
                description: "Filter for seat status"
            }
        }
    },
    response: {
        200: {
            description: "List of seats matching .",
            type: "array",
            items: seatSchema
        },
        404: {
            description: "Event not found.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        500: {
            description: "Internal server error.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}