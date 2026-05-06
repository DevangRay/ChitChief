import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import * as jwt from 'jsonwebtoken'
import { buildApp } from '../../app'
import { startDb, stopDb, clearDb, prisma } from '../../test/helpers/db.helper'
import { startRedis, stopRedis, clearRedis } from '../../test/helpers/redis.helper'
import { FastifyInstance } from 'fastify'
import { OrderStatus } from '@prisma/client'

const TEST_USER_UUID = '00000000-0000-0000-0000-000000000001'
const TEST_USER_EMAIL = 'test@example.com'
const TEST_USER_NAME = 'testuser'

describe('Users Routes E2E', () => {
    let app: FastifyInstance

    beforeAll(async () => {
        process.env.SIGNING_SECRET = 'test-signing-secret-e2e'
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

    const makeAccessToken = (userId = TEST_USER_UUID, userEmail = TEST_USER_EMAIL) =>
        jwt.sign({ user_id: userId, user_email: userEmail }, process.env.SIGNING_SECRET!, { expiresIn: '1h' })

    const createUser = () =>
        prisma.user.create({
            data: { id: TEST_USER_UUID, email: TEST_USER_EMAIL, username: TEST_USER_NAME, password_hash: 'hashed-password' }
        })

    const createRefreshToken = (expiresAt = new Date(Date.now() + 60 * 60 * 1000)) =>
        prisma.refreshToken.create({
            data: { user_id: TEST_USER_UUID, expires_at: expiresAt }
        })

    // ─── GET /users/me ──────────────────────────────────────────────────────────

    describe('GET /users/me', () => {

        it('Equivalence Test: returns 200 with user profile when the access token is valid', async () => {
            await createUser()
            await createRefreshToken()
            const token = makeAccessToken()

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('email', TEST_USER_EMAIL)
            expect(res.body).toHaveProperty('username', TEST_USER_NAME)
            expect(res.body).toHaveProperty('created_at')
            expect(res.body).toHaveProperty('refresh_token_expires_at')
        })

        it('Equivalence Test: refresh_token_expires_at is a future datetime when the user has an active session', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            const expiresAt = new Date(res.body.refresh_token_expires_at).getTime()
            expect(expiresAt).toBeGreaterThan(Date.now())
        })

        it('Exception Test: response shape matches the schema', async () => {
            await createUser()
            await createRefreshToken()
            const token = makeAccessToken()

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('email')
            expect(res.body).toHaveProperty('username')
            expect(res.body).toHaveProperty('created_at')
            expect(res.body).toHaveProperty('refresh_token_expires_at')
        })

        it('Boundary Test: returns 404 when the user in the access token does not exist in the database', async () => {
            const token = makeAccessToken()

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(404)
        })

        it('Boundary Test: returns 404 when the user has no active refresh token', async () => {
            await createUser()
            const token = makeAccessToken()

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(404)
        })

        it('Exception Test: returns 400 when the Authorization header is missing', async () => {
            const res = await supertest(app.server)
                .get('/users/me')

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 403 when the access token is invalid', async () => {
            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', 'Bearer not.a.real.token')

            expect(res.status).toBe(403)
        })

        it('Exception Test: returns 403 when the access token is signed with the wrong secret', async () => {
            const wrongToken = jwt.sign(
                { user_id: TEST_USER_UUID, user_email: TEST_USER_EMAIL },
                'totally-wrong-secret',
                { expiresIn: '1h' }
            )

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${wrongToken}`)

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when the access token is expired', async () => {
            const expiredToken = jwt.sign(
                { user_id: TEST_USER_UUID, user_email: TEST_USER_EMAIL },
                process.env.SIGNING_SECRET!,
                { expiresIn: -1 }
            )

            const res = await supertest(app.server)
                .get('/users/me')
                .set('Authorization', `Bearer ${expiredToken}`)

            expect(res.status).toBe(403)
        })
    })

    // ─── GET /users/me/orders ────────────────────────────────────────────────────

    describe('GET /users/me/orders', () => {

        it('Equivalence Test: returns 200 with an empty array when the user has no orders', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(Array.isArray(res.body)).toBe(true)
            expect(res.body.length).toBe(0)
        })

        it('Equivalence Test: returns 200 with a list of orders for the authenticated user', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()
            
            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_001', client_secret: 'pi_test_001_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '11111111-1111-1111-1111-111111111111'
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(Array.isArray(res.body)).toBe(true)
            expect(res.body.length).toBe(1)
        })

        it('Equivalence Test: order response shape matches the expected schema', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z'), description: 'A great show' }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_002', client_secret: 'pi_test_002_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '22222222-2222-2222-2222-222222222222'
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            const o = res.body[0]
            expect(o).toHaveProperty('order_id')
            expect(o).toHaveProperty('event_name', 'Test Event')
            expect(o).toHaveProperty('event_description', 'A great show')
            expect(o).toHaveProperty('event_date')
            expect(o).toHaveProperty('order_status', 'CONFIRMED')
            expect(o).toHaveProperty('created_at')
            expect(o).toHaveProperty('seat_names')
            expect(o).toHaveProperty('total_price')
        })

        it('Equivalence Test: event_description is null when the event has no description', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_003', client_secret: 'pi_test_003_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '33333333-3333-3333-3333-333333333333'
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body[0].event_description).toBeNull()
        })

        it('Equivalence Test: seat_names are formatted as row+number (e.g. "A1", "B3")', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'B', number: 3, price: 10000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_004', client_secret: 'pi_test_004_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '44444444-4444-4444-4444-444444444444'
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: order.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body[0].seat_names).toContain('B3')
        })

        it('Equivalence Test: total_price is the sum of price_at_purchase across all seats in the order', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat1 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const seat2 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 2, price: 20000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_005', client_secret: 'pi_test_005_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '55555555-5555-5555-5555-555555555555'
                }
            })
            await prisma.orderSeats.createMany({
                data: [
                    { order_id: order.id, seat_id: seat1.id, price_at_purchase: 10000 },
                    { order_id: order.id, seat_id: seat2.id, price_at_purchase: 20000 },
                ]
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body[0].total_price).toBe(30000)
        })

        it('Boundary Test: orders with multiple seats list all seat names', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat1 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const seat2 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 2, price: 10000, seat_status: 'AVAILABLE' }
            })
            const seat3 = await prisma.seat.create({
                data: { event_id: event.id, row: 'B', number: 1, price: 15000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_006', client_secret: 'pi_test_006_secret' }
            })
            const order = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '66666666-6666-6666-6666-666666666666'
                }
            })
            await prisma.orderSeats.createMany({
                data: [
                    { order_id: order.id, seat_id: seat1.id, price_at_purchase: 10000 },
                    { order_id: order.id, seat_id: seat2.id, price_at_purchase: 10000 },
                    { order_id: order.id, seat_id: seat3.id, price_at_purchase: 15000 },
                ]
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body[0].seat_names).toHaveLength(3)
            expect(res.body[0].seat_names).toContain('A1')
            expect(res.body[0].seat_names).toContain('A2')
            expect(res.body[0].seat_names).toContain('B1')
        })

        it('Boundary Test: orders are returned in descending created_at order (most recent first)', async () => {
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat1 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const seat2 = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 2, price: 10000, seat_status: 'AVAILABLE' }
            })
            const stripe1 = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_007a', client_secret: 'pi_test_007a_secret' }
            })
            const stripe2 = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_007b', client_secret: 'pi_test_007b_secret' }
            })
            const olderOrder = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripe1.id,
                    idempotency_key: '77777777-7777-7777-7777-777777777771',
                    created_at: new Date('2027-01-01T00:00:00Z')
                }
            })
            const newerOrder = await prisma.order.create({
                data: {
                    user_id: TEST_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripe2.id,
                    idempotency_key: '77777777-7777-7777-7777-777777777772',
                    created_at: new Date('2027-06-01T00:00:00Z')
                }
            })
            await prisma.orderSeats.create({ data: { order_id: olderOrder.id, seat_id: seat1.id, price_at_purchase: 10000 } })
            await prisma.orderSeats.create({ data: { order_id: newerOrder.id, seat_id: seat2.id, price_at_purchase: 10000 } })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body.length).toBe(2)
            expect(new Date(res.body[0].created_at).getTime()).toBeGreaterThan(new Date(res.body[1].created_at).getTime())
        })

        it('Equivalence Test: only returns orders belonging to the authenticated user, not other users', async () => {
            const OTHER_USER_UUID = '00000000-0000-0000-0000-000000000002'
            
            const futureExpiry = new Date(Date.now() + 60 * 60 * 1000)
            await createUser()
            await createRefreshToken(futureExpiry)
            const token = makeAccessToken()

            await prisma.user.create({
                data: { id: OTHER_USER_UUID, email: 'other@example.com', username: 'otheruser', password_hash: 'hashed-password' }
            })
            const event = await prisma.event.create({
                data: { name: 'Test Event', venue: 'Test Venue', date: new Date('2027-06-15T20:00:00Z') }
            })
            const seat = await prisma.seat.create({
                data: { event_id: event.id, row: 'A', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            const stripeInfo = await prisma.stripePaymentInfo.create({
                data: { payment_intent_id: 'pi_test_008', client_secret: 'pi_test_008_secret' }
            })
            const otherOrder = await prisma.order.create({
                data: {
                    user_id: OTHER_USER_UUID,
                    order_status: OrderStatus.CONFIRMED,
                    stripe_payment_id: stripeInfo.id,
                    idempotency_key: '88888888-8888-8888-8888-888888888888'
                }
            })
            await prisma.orderSeats.create({
                data: { order_id: otherOrder.id, seat_id: seat.id, price_at_purchase: 10000 }
            })

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${token}`)

            expect(res.status).toBe(200)
            expect(res.body.length).toBe(0)
        })

        it('Exception Test: returns 400 when the Authorization header is missing', async () => {
            const res = await supertest(app.server)
                .get('/users/me/orders')

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 403 when the access token is invalid', async () => {
            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', 'Bearer garbage.token.here')

            expect(res.status).toBe(403)
        })

        it('Exception Test: returns 403 when the access token is signed with the wrong secret', async () => {
            const wrongToken = jwt.sign(
                { user_id: TEST_USER_UUID, user_email: TEST_USER_EMAIL },
                'totally-wrong-secret',
                { expiresIn: '1h' }
            )

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${wrongToken}`)

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when the access token is expired', async () => {
            const expiredToken = jwt.sign(
                { user_id: TEST_USER_UUID, user_email: TEST_USER_EMAIL },
                process.env.SIGNING_SECRET!,
                { expiresIn: -1 }
            )

            const res = await supertest(app.server)
                .get('/users/me/orders')
                .set('Authorization', `Bearer ${expiredToken}`)

            expect(res.status).toBe(403)
        })
    })
})
