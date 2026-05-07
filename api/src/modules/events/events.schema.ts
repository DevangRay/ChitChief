import { type FastifySchema } from "fastify";
import { eventSchema, seatSchema } from "../../lib/schema-constants.js";

// GET /events
export const getEventsSchema: FastifySchema = {
    tags: ["Events"],
    description: "Get a list of all available events, meaning all dates that will take place in the future.",
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
    tags: ["Events"],
    description: "Get a description of 1 specific event, including the number of available seats.",
    params: {
        type: "object",
        required: ["id"],
        properties: {
            id: {
                type: "string",
                format: "uuid",
                description: "UUID of the event.",
                examples: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"]
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
    tags: ["Events"],
    description: "Provides a list of seats for a specific event. Can optionaly be filtered by seat status (AVAILABLE, RESERVED, or SOLD).",
    params: {
        type: "object",
        required: ["id"],
        properties: {
            id: {
                type: "string",
                format: "uuid",
                description: "UUID of the event.",
                examples: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"]
            }
        }
    },
    querystring: {
        type: "object",
        properties: {
            status: {
                type: "string",
                enum: ["AVAILABLE", "RESERVED", "SOLD"],
                description: "Filter for seat status",
                examples: ["AVAILABLE"]
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