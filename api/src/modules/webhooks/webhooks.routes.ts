import { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { WebhooksService } from "./webhooks.service";

const stripe = Stripe(process.env.STRIPE_SECRET_KEY!);

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new WebhooksService(fastify.prisma);

    fastify.post('/payment/confirm', async (request, reply) => {
        let event;
        try {
            const raw_event = request.body as Buffer;
            const signature = request.headers['stripe-signature']!;
            const endpoint_secret = process.env.STRIPE_ENDPOINT_SECRET!;
            console.log("body_event:", raw_event);
            console.log("signature:", signature);
            console.log("endpoint_secret:", endpoint_secret);

            event = stripe.webhooks.constructEvent(
                raw_event,
                signature,
                endpoint_secret
            );

            console.log("constructed event:", event);
        } catch (error) {
            console.log("caught error:", error);
            return reply.status(400).send({ message: error });
        }

        switch (event.type) {
            case "payment_intent.succeeded":
                // update order
                const result = await service.handleSuccess(event.data?.object?.metadata?.user_uuid, event.data?.object?.metadata?.idempotency_key);
                break;
            default:
                console.log(`Unhandled event type ${event.type}`);
        }

        console.log("need to update db");
        return reply.status(200).send({ recieved: true })
    })

    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, payload, done) => {
        done(null, payload)
    });
}