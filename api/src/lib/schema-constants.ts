export const seatSchema = {
    type: "object",
    properties: {
        id: { type: "string", format: "uuid", examples: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"] },
        event_id: { type: "string", format: "uuid", examples: ["c3d4e5f6-a7b8-9012-cdef-123456789012"] },
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
            examples: ["AVAILABLE"],
        },
    },
} as const

export const eventSchema = {
    type: "object",
    properties: {
        id: { type: "string", format: "uuid", examples: ["c3d4e5f6-a7b8-9012-cdef-123456789012"] },
        name: { type: "string", examples: ["BTS Arirang Tour"] },
        description: { type: "string", nullable: true, examples: ["An unforgettable night with BTS at MetLife Stadium."] },
        venue: { type: "string", examples: ["MetLife Stadium"] },
        date: { type: "string", format: "date-time", examples: ["2026-08-15T19:00:00.000Z"] },
        created_at: { type: "string", format: "date-time", examples: ["2026-01-01T00:00:00.000Z"] },
    },
} as const