import { FastifySchema } from "fastify";
import { eventSchema, seatSchema } from "../../lib/schema-constants";

// GET /events
export const getEventsSchema: FastifySchema = {
    response: {
        200: {
            description: "Description of available events, from this date.",
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
            description: "Seats not found.",
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