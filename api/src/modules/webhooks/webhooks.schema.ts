import { type FastifySchema } from "fastify";

export const confirmPaymentSchema: FastifySchema = {
    tags: ["Webhooks"],
    description: "Endpoint for Stripe webhook callbacks to asynchronously handle the results of payment intents created by the [POST] /tickets/payment/intent endpoint. This endpoint will be called by Stripe with the result of the payment intent confirmation, and will update the order status and release any Redis locks accordingly. An email will be sent to the user sharing the status of their order. Make sure to check your spam folder!",
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