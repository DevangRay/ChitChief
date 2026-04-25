import { FastifySchema } from "fastify";

export const confirmPaymentSchema: FastifySchema = {
    body: {
        type: "string",
        format: "binary"
    },
    headers: {
        type: "object",
        required: ["stripe-signature"],
        properties: {
            "stripe-signature": {
                type: "string"
            }
        }
    },
    response: {
        200: {
            description: "Default response",
            type: "object",
            properties: {
                recieved: {
                    type: "boolean"
                }
            }
        },
        400: {
            description: "Failed to construct Stripe event recieved with webhook",
            type: "object",
            properties: {
                message: {
                    type: "string"
                }
            }
        }
    }
}