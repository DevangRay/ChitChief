export const seatSchema = {
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

export const eventSchema = {
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