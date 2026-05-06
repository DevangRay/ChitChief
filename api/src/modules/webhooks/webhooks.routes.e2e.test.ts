import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import Stripe from 'stripe'
import { buildApp } from '../../app'
import { startDb, stopDb, clearDb, prisma } from '../../test/helpers/db.helper'
import { startRedis, stopRedis, clearRedis } from '../../test/helpers/redis.helper'
import { FastifyInstance } from 'fastify'
import { OrderStatus } from '@prisma/client'

const TEST_USER_UUID = '00000000-0000-0000-0000-000000000001'
const TEST_USER_EMAIL = 'webhook-test@example.com'
const TEST_IDEMPOTENCY_KEY = '11111111-1111-1111-1111-111111111111'
const TEST_PAYMENT_INTENT_ID = 'pi_test_webhook_e2e_001'
const ENDPOINT_SECRET = 'whsec_test_endpoint_secret_e2e'

/** Generate a valid Stripe-signed webhook payload. */
const makeStripeEvent = (
    type: string,
    dataObject: Record<string, unknown>,
) => {
    const payload = JSON.stringify({
        id: `evt_test_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        type,
        data: { object: dataObject },
    })
    const signature = Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: ENDPOINT_SECRET,
    })
    return { payload, signature }
}

const makePaymentIntentObject = (overrides: Record<string, unknown> = {}) => ({
    id: TEST_PAYMENT_INTENT_ID,
    object: 'payment_intent',
    amount: 10000,
    currency: 'usd',
    description: 'A1',
    metadata: {
        user_uuid: TEST_USER_UUID,
        user_email: TEST_USER_EMAIL,
        idempotency_key: TEST_IDEMPOTENCY_KEY,
    },
    ...overrides,
})

describe('Webhooks Routes E2E', () => {
    let app: FastifyInstance

    beforeAll(async () => {
        process.env.SIGNING_SECRET = 'test-signing-secret-e2e'
        process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder'
        process.env.STRIPE_ENDPOINT_SECRET = ENDPOINT_SECRET
        await startDb()
        await startRedis()
        app = await buildApp()
        await app.ready()
    })

    afterAll(async () => {
        await stopRedis()
        await stopDb()
    })

    beforeEach(async () => {
        await clearDb()
        await clearRedis()
    })

    // ─── POST /webhooks/payment/confirm ──────────────────────────────────────────

    describe('POST /webhooks/payment/confirm', () => {

        // ── Signature validation ─────────────────────────────────────────────────
        it('Exception Test: returns 400 when the stripe-signature header is missing', async () => {
            const res = await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .send(JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {} } }))

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when the stripe-signature is invalid', async () => {
            const res = await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .set('stripe-signature', 'totally-invalid-signature')
                .send(JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {} } }))

            expect(res.status).toBe(400)
        })

        // ── Unhandled event types ────────────────────────────────────────────────
        it('Equivalence Test: returns 200 for an unhandled Stripe event type', async () => {
            const { payload, signature } = makeStripeEvent('customer.created', { id: 'cus_test_123' })

            const res = await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .set('stripe-signature', signature)
                .send(payload)

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('recieved', true)
        })

        // ── payment_intent.succeeded ─────────────────────────────────────────────
        it('Equivalence Test: returns 200 and updates order to CONFIRMED on payment_intent.succeeded', async () => {
            await prisma.user.create({
                data: { id: TEST_USER_UUID, email: TEST_USER_EMAIL, username: 'webhookuser', password_hash: 'hash' }
            })
            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-01-01T00:00:00Z'), description: 'A test' }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'RESERVED' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: TEST_PAYMENT_INTENT_ID, client_secret: 'pi_test_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.PENDING,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    stripe_payment_id: stripeInfo.id,
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const { payload, signature } = makeStripeEvent('payment_intent.succeeded', makePaymentIntentObject())

            const res = await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .set('stripe-signature', signature)
                .send(payload)

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('recieved', true)

            const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } })
            expect(updatedOrder?.order_status).toBe(OrderStatus.CONFIRMED)
        })

        it('Boundary Test: order remains CONFIRMED and does not re-process on a duplicate payment_intent.succeeded', async () => {
            await prisma.user.create({
                data: { id: TEST_USER_UUID, email: TEST_USER_EMAIL, username: 'webhookuser2', password_hash: 'hash' }
            })
            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-01-01T00:00:00Z'), description: 'A test' }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'RESERVED' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: TEST_PAYMENT_INTENT_ID, client_secret: 'pi_test_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.PENDING,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    stripe_payment_id: stripeInfo.id,
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const { payload, signature } = makeStripeEvent('payment_intent.succeeded', makePaymentIntentObject())

            // First webhook — transitions PENDING → CONFIRMED
            await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .set('stripe-signature', signature)
                .send(payload)

            // Second webhook — idempotency guard should return early
            const { payload: p2, signature: s2 } = makeStripeEvent('payment_intent.succeeded', makePaymentIntentObject())
            const res = await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .set('stripe-signature', s2)
                .send(p2)

            expect(res.status).toBe(200)
            const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } })
            expect(updatedOrder?.order_status).toBe(OrderStatus.CONFIRMED)
        })

        // ── payment_intent.payment_failed ────────────────────────────────────────
        it('Equivalence Test: returns 200 and updates order to FAILED on payment_intent.payment_failed', async () => {
            await prisma.user.create({
                data: { id: TEST_USER_UUID, email: TEST_USER_EMAIL, username: 'webhookuser3', password_hash: 'hash' }
            })
            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-01-01T00:00:00Z'), description: 'A test' }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'RESERVED' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: TEST_PAYMENT_INTENT_ID, client_secret: 'pi_test_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.PENDING,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    stripe_payment_id: stripeInfo.id,
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const { payload, signature } = makeStripeEvent('payment_intent.payment_failed', makePaymentIntentObject())

            const res = await supertest(app.server)
                .post('/webhooks/payment/confirm')
                .set('Content-Type', 'application/json')
                .set('stripe-signature', signature)
                .send(payload)

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('recieved', true)

            const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } })
            expect(updatedOrder?.order_status).toBe(OrderStatus.FAILED)
        })
    })
})
