import { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { WebhooksService } from "./webhooks.service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new WebhooksService(fastify.prisma, fastify.redis);

    fastify.post('/payment/confirm', async (request, reply) => {
        let event;
        try {
            const raw_event = request.body as Buffer;
            const signature = request.headers['stripe-signature']!;
            const endpoint_secret = process.env.STRIPE_ENDPOINT_SECRET!;
            console.log(`[webhooks.routes /payment/confirm]: Received stripe-signature: ${signature}`);

            event = stripe.webhooks.constructEvent(
                raw_event,
                signature,
                endpoint_secret
            );
        } catch (error) {
            console.log(`[webhooks.routes /payment/confirm]: Failed to construct Stripe event:`, error);
            return reply.status(400).send({ message: error });
        }

        switch (event.type) {
            case "payment_intent.succeeded":
                // update order
                console.log(`[webhooks.routes /payment/confirm]: Handling payment_intent.succeeded — id: ${event.data?.object?.id}, amount: ${event.data?.object?.amount / 100} ${event.data?.object?.currency?.toUpperCase()}, user_uuid: ${event.data?.object?.metadata?.user_uuid}, idempotency_key: ${event.data?.object?.metadata?.idempotency_key}, seats: ${event.data?.object?.description}`);
                await service.handleSuccess(event.data?.object?.metadata?.user_uuid, event.data?.object?.metadata?.idempotency_key, event.data?.object?.id);
                break;
            case "payment_intent.payment_failed":
                console.log(`[webhooks.routes /payment/confirm]: Handling payment_intent.payment_failed — id: ${event.data?.object?.id}, user_uuid: ${event.data?.object?.metadata?.user_uuid}, idempotency_key: ${event.data?.object?.metadata?.idempotency_key}`);
                await service.handleFailure(event.data?.object?.metadata?.user_uuid, event.data?.object?.metadata?.idempotency_key);
                break;
            case "payment_intent.requires_action":
                // out of scope at the moment
                console.log(`[webhooks.routes /payment/confirm]: Encountered payment_intent.requires_action`);
                console.log(`[webhooks.routes /payment/confirm]: Out of scope`);
            default:
                console.log(`[webhooks.routes /payment/confirm]: Unhandled Stripe event type: ${event.type}`);
        }

        return reply.status(200).send({ recieved: true })
    })

    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, payload, done) => {
        done(null, payload)
    });
}