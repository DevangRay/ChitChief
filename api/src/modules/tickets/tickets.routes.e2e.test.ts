import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import * as jwt from 'jsonwebtoken'
import { buildApp } from '../../app'
import { startDb, stopDb, clearDb, prisma } from '../../test/helpers/db.helper'
import { startRedis, stopRedis, clearRedis, redis } from '../../test/helpers/redis.helper'
import { createSeatFixture } from '../../test/fixtures/seat.fixture'
import { FastifyInstance } from 'fastify'
import { seatLockFromId } from '../../lib/redis-keys'
import { OrderStatus } from '@prisma/client'

const TEST_USER_UUID = '00000000-0000-0000-0000-000000000001'
const TEST_IDEMPOTENCY_KEY = '11111111-1111-1111-1111-111111111111'

describe('Tickets Routes E2E', () => {
    let app: FastifyInstance

    beforeAll(async () => {
        process.env.SIGNING_SECRET = 'test-signing-secret-e2e'
        process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder'
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

    // ─── GET /tickets/demo/idempotency_key ──────────────────────────────────────

    describe('GET /tickets/demo/idempotency_key', () => {

        it('Equivalence Test: returns 200 with an idempotency_key string', async () => {
            const res = await supertest(app.server)
                .get('/tickets/demo/idempotency_key')

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('idempotency_key')
            expect(typeof res.body.idempotency_key).toBe('string')
            expect(res.body.idempotency_key.length).toBeGreaterThan(0)
        })

        it('Equivalence Test: returns a different key on each call', async () => {
            const res1 = await supertest(app.server).get('/tickets/demo/idempotency_key')
            const res2 = await supertest(app.server).get('/tickets/demo/idempotency_key')

            expect(res1.status).toBe(200)
            expect(res2.status).toBe(200)
            expect(res1.body.idempotency_key).not.toBe(res2.body.idempotency_key)
        })

        it('Exception Test: response shape matches schema', async () => {
            const res = await supertest(app.server)
                .get('/tickets/demo/idempotency_key')

            expect(res.status).toBe(200)
            expect(Object.keys(res.body)).toEqual(['idempotency_key'])
        })
    })

    // ─── POST /tickets/reserve ───────────────────────────────────────────────────

    describe('POST /tickets/reserve', () => {

        it('Equivalence Test: returns 200 with reservation token on valid request', async () => {
            const { seat } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('reservation_token')
            expect(res.body).toHaveProperty('expires_at')
            expect(res.body).toHaveProperty('expires_at_string')
        })

        it('Equivalence Test: reservation_token is a non-empty string', async () => {
            const { seat } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(200)
            expect(typeof res.body.reservation_token).toBe('string')
            expect(res.body.reservation_token.length).toBeGreaterThan(0)
        })

        it('Equivalence Test: expires_at is a number set in the future', async () => {
            const now = Date.now()
            const { seat } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(200)
            expect(typeof res.body.expires_at).toBe('number')
            expect(res.body.expires_at).toBeGreaterThan(now)
        })

        it('Equivalence Test: expires_at_string is a valid ISO 8601 datetime string', async () => {
            const { seat } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(200)
            expect(res.body.expires_at_string).toMatch(/^\d{4}-\d{2}-\d{2}T/)
            expect(() => new Date(res.body.expires_at_string).toISOString()).not.toThrow()
        })

        it('Boundary Test: succeeds when reserving multiple seats at once', async () => {
            const { event } = await createSeatFixture(prisma, { row: 'A', number: 1 })
            const seat2 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 2, price: 10000, seat_status: 'AVAILABLE' }
            })
            const seat3 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 3, price: 10000, seat_status: 'AVAILABLE' }
            })

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat2.id, seat3.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('reservation_token')
        })

        it('Boundary Test: returns 409 with conflict_seat_ids when seat is already reserved', async () => {
            const { seat } = await createSeatFixture(prisma)

            // First reservation succeeds
            await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            // Second reservation for the same seat conflicts
            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(409)
            expect(res.body).toHaveProperty('conflict_seat_ids')
            expect(res.body.conflict_seat_ids).toContain(seat.id)
        })

        it('Boundary Test: conflict_seat_ids does not include seats that were free', async () => {
            const { event, seat: seat1 } = await createSeatFixture(prisma, { row: 'A', number: 1 })
            const seat2 = await prisma.seat.create({
                data: { event_id: event.id, row: 'B', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })

            // Reserve only seat1
            await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat1.id], user_uuid: TEST_USER_UUID })

            // Try to reserve both — seat1 is now conflicting, seat2 is still free
            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat1.id, seat2.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(409)
            expect(res.body.conflict_seat_ids).toContain(seat1.id)
            expect(res.body.conflict_seat_ids).not.toContain(seat2.id)
        })

        it('Exception Test: returns 400 when seat_ids is missing from body', async () => {
            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when user_uuid is missing from body', async () => {
            const { seat } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id] })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when user_uuid is not a valid UUID format', async () => {
            const { seat } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: 'not-a-valid-uuid' })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 404 when a seat_id does not exist in the database', async () => {
            const nonExistentSeatId = '00000000-0000-0000-0000-000000000000'

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [nonExistentSeatId], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(409)
            expect(res.body).toHaveProperty('conflict_seat_ids')
        })

        it('Exception Test: returns 409 when seat is in RESERVED status in the database', async () => {
            const { seat } = await createSeatFixture(prisma, { status: 'RESERVED' })

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(409)
            expect(res.body.conflict_seat_ids).toContain(seat.id)
        })

        it('Exception Test: returns 409 when seat is in SOLD status in the database', async () => {
            const { seat } = await createSeatFixture(prisma, { status: 'SOLD' })

            const res = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(res.status).toBe(409)
            expect(res.body.conflict_seat_ids).toContain(seat.id)
        })
    })

    // ─── POST /tickets/payment/intent ────────────────────────────────────────────

    describe('POST /tickets/payment/intent', () => {

        // ── Schema validation (400) ──────────────────────────────────────────────

        it('Exception Test: returns 400 when reservation_token is missing', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when user_uuid is missing', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-token',
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when user_uuid is not a valid UUID format', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-token',
                    user_uuid: 'not-a-valid-uuid',
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when idempotency_key is missing', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-token',
                    user_uuid: TEST_USER_UUID,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when payment_method is missing', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-token',
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when payment_method is not a valid enum value', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-token',
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'NOT_A_REAL_METHOD'
                })

            expect(res.status).toBe(400)
        })

        // ── Token validation (403) ───────────────────────────────────────────────

        it('Equivalence Test: returns 403 when reservation_token is a garbage string', async () => {
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'not.a.real.jwt',
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(403)
        })

        it('Equivalence Test: returns 403 when reservation_token is signed with the wrong secret', async () => {
            const wrongToken = jwt.sign(
                { seat_ids: ['seat-1'], redis_locks: ['lock:seat:seat-1'], user_uuid: TEST_USER_UUID, expires_at: Date.now() + 60000 },
                'totally-wrong-secret',
                { expiresIn: 600 }
            )

            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: wrongToken,
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when reservation_token is expired', async () => {
            const expiredToken = jwt.sign(
                { seat_ids: ['seat-1'], redis_locks: ['lock:seat:seat-1'], user_uuid: TEST_USER_UUID, expires_at: Date.now() - 1000 },
                process.env.SIGNING_SECRET!,
                { expiresIn: -1 }
            )

            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: expiredToken,
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when token user_uuid does not match the request user_uuid', async () => {
            const { seat } = await createSeatFixture(prisma)

            // Reserve the seat to get a valid token (signed for TEST_USER_UUID)
            const reserveRes = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(reserveRes.status).toBe(200)
            const { reservation_token } = reserveRes.body

            // Present the token but claim a different user identity
            const differentUser = '00000000-0000-0000-0000-000000000002'
            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token,
                    user_uuid: differentUser,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(403)
        })

        // ── Seat lock expiry (409) ───────────────────────────────────────────────

        it('Equivalence Test: returns 409 when the Redis seat lock has expired after a valid reservation', async () => {
            const { seat } = await createSeatFixture(prisma)

            // Reserve the seat — this sets the Redis lock
            const reserveRes = await supertest(app.server)
                .post('/tickets/reserve')
                .send({ seat_ids: [seat.id], user_uuid: TEST_USER_UUID })

            expect(reserveRes.status).toBe(200)
            const { reservation_token } = reserveRes.body

            // Simulate lock expiry by manually removing the Redis key
            await redis.del(seatLockFromId(seat.id))

            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token,
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(409)
            expect(res.body).toHaveProperty('conflict_seat_ids')
            expect(res.body.conflict_seat_ids).toContain(seat.id)
        })

        // ── Idempotency (200 early return) ───────────────────────────────────────
        //
        // The idempotency check in the service queries the DB for an existing order
        // before ever verifying the JWT or checking Redis locks, so these tests can
        // pass a syntactically valid but otherwise arbitrary reservation_token.
        // The Order model has a FK to User, so each test creates a User first.

        it('Equivalence Test: returns 200 with existing client_secret when a PENDING order already exists for the idempotency key', async () => {
            const existingClientSecret = 'pi_test_existing_client_secret'

            await prisma.user.create({
                data: { id: TEST_USER_UUID, email: 'test@test.com', username: 'testuser', password_hash: 'hash' }
            })
            const stripePaymentInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_existing_intent', client_secret: existingClientSecret }
            })
            await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.PENDING,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    stripe_payment_id: stripePaymentInfo.id
                }
            })

            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-non-null-token-value',
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(200)
            expect(res.body.client_secret).toBe(existingClientSecret)
            expect(res.body).toHaveProperty('order_id')
        })

        it('Equivalence Test: returns 200 with the same order_id when a CONFIRMED order already exists for the idempotency key', async () => {
            await prisma.user.create({
                data: { id: TEST_USER_UUID, email: 'test@test.com', username: 'testuser', password_hash: 'hash' }
            })
            const stripePaymentInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_confirmed_intent', client_secret: 'pi_test_confirmed_secret' }
            })
            const existingOrder = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    stripe_payment_id: stripePaymentInfo.id
                }
            })

            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-non-null-token-value',
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(200)
            expect(res.body.order_id).toBe(existingOrder.id)
        })

        it('Boundary Test: returns 409 when an EXPIRED order exists for the idempotency key', async () => {
            await prisma.user.create({
                data: { id: TEST_USER_UUID, email: 'test@test.com', username: 'testuser', password_hash: 'hash' }
            })
            const stripePaymentInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_expired_intent', client_secret: 'pi_test_expired_secret' }
            })
            await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.EXPIRED,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    stripe_payment_id: stripePaymentInfo.id
                }
            })

            const res = await supertest(app.server)
                .post('/tickets/payment/intent')
                .send({
                    reservation_token: 'any-non-null-token-value',
                    user_uuid: TEST_USER_UUID,
                    idempotency_key: TEST_IDEMPOTENCY_KEY,
                    payment_method: 'SUCCESS_VISA'
                })

            expect(res.status).toBe(409)
            expect(res.body).toHaveProperty('message')
        })
    })
})
