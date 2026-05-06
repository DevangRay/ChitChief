import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { buildApp } from '../../app'
import { startDb, stopDb, clearDb, prisma } from '../../test/helpers/db.helper'
import { startRedis, stopRedis, clearRedis } from '../../test/helpers/redis.helper'
import { FastifyInstance } from 'fastify'

const TEST_USER_NAME = 'testuser'
const TEST_USER_EMAIL = 'test@example.com'
const TEST_USER_PASSWORD = 'password123'

/** Register a user and return the full supertest response. */
const registerUser = (
    app: FastifyInstance,
    user = { user_name: TEST_USER_NAME, email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }
) =>
    supertest(app.server)
        .post('/auth/register')
        .send(user)

describe('Auth Routes E2E', () => {
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

    // ─── POST /auth/register ─────────────────────────────────────────────────────

    describe('POST /auth/register', () => {

        it('Equivalence Test: returns 201 with access_token and refresh_token on a valid registration', async () => {
            const res = await registerUser(app)

            expect(res.status).toBe(201)
            expect(res.body).toHaveProperty('access_token')
            expect(res.body).toHaveProperty('refresh_token')
        })

        it('Equivalence Test: access_token is a non-empty string', async () => {
            const res = await registerUser(app)

            expect(typeof res.body.access_token).toBe('string')
            expect(res.body.access_token.length).toBeGreaterThan(0)
        })

        it('Equivalence Test: refresh_token is a non-empty string', async () => {
            const res = await registerUser(app)

            expect(typeof res.body.refresh_token).toBe('string')
            expect(res.body.refresh_token.length).toBeGreaterThan(0)
        })

        it('Boundary Test: returns 409 when registering with credentials that already exist', async () => {
            await registerUser(app)
            const res = await registerUser(app)

            expect(res.status).toBe(409)
        })

        it('Exception Test: returns 400 when user_name is missing from the body', async () => {
            const res = await supertest(app.server)
                .post('/auth/register')
                .send({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when email is missing from the body', async () => {
            const res = await supertest(app.server)
                .post('/auth/register')
                .send({ user_name: TEST_USER_NAME, password: TEST_USER_PASSWORD })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when password is missing from the body', async () => {
            const res = await supertest(app.server)
                .post('/auth/register')
                .send({ user_name: TEST_USER_NAME, email: TEST_USER_EMAIL })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when email is not a valid email format', async () => {
            const res = await supertest(app.server)
                .post('/auth/register')
                .send({ user_name: TEST_USER_NAME, email: 'not-an-email', password: TEST_USER_PASSWORD })

            expect(res.status).toBe(400)
        })
    })

    // ─── POST /auth/login ────────────────────────────────────────────────────────

    describe('POST /auth/login', () => {

        it('Equivalence Test: returns 200 with access_token and refresh_token on valid credentials', async () => {
            await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ user_name: TEST_USER_NAME, password: TEST_USER_PASSWORD })

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('access_token')
            expect(res.body).toHaveProperty('refresh_token')
        })

        it('Equivalence Test: returns 404 when the user does not exist', async () => {
            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ user_name: 'nonexistentuser', password: TEST_USER_PASSWORD })

            expect(res.status).toBe(404)
        })

        it('Equivalence Test: returns 403 when the password is incorrect', async () => {
            await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ user_name: TEST_USER_NAME, password: 'wrong-password' })

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 200 and the same refresh_token when the user is already logged in', async () => {
            const { body: { refresh_token: initial_refresh_token } } = await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ user_name: TEST_USER_NAME, password: TEST_USER_PASSWORD })

            expect(res.status).toBe(200)
            expect(res.body.refresh_token).toBe(initial_refresh_token)
        })

        it('Boundary Test: returns 200 with a new refresh_token when the existing session has expired', async () => {
            const { body: { refresh_token: expired_token } } = await registerUser(app)

            await prisma.refreshToken.updateMany({
                where: { token: expired_token },
                data: { expires_at: new Date(Date.now() - 1000) }
            })

            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ user_name: TEST_USER_NAME, password: TEST_USER_PASSWORD })

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('refresh_token')
            expect(res.body.refresh_token).not.toBe(expired_token)
        })

        it('Exception Test: returns 400 when user_name is missing from the body', async () => {
            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ password: TEST_USER_PASSWORD })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when password is missing from the body', async () => {
            const res = await supertest(app.server)
                .post('/auth/login')
                .send({ user_name: TEST_USER_NAME })

            expect(res.status).toBe(400)
        })
    })

    // ─── POST /auth/logout ───────────────────────────────────────────────────────

    describe('POST /auth/logout', () => {

        it('Equivalence Test: returns 204 on a successful logout', async () => {
            const { body: { refresh_token } } = await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/logout')
                .send({ refresh_token })

            expect(res.status).toBe(204)
        })

        it('Equivalence Test: returns 403 when the refresh_token does not exist', async () => {
            const res = await supertest(app.server)
                .post('/auth/logout')
                .send({ refresh_token: '00000000-0000-0000-0000-000000000000' })

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when attempting to logout a second time with the same refresh_token', async () => {
            const { body: { refresh_token } } = await registerUser(app)

            await supertest(app.server).post('/auth/logout').send({ refresh_token })

            const res = await supertest(app.server)
                .post('/auth/logout')
                .send({ refresh_token })

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when the refresh_token is expired', async () => {
            const { body: { refresh_token } } = await registerUser(app)

            await prisma.refreshToken.updateMany({
                where: { token: refresh_token },
                data: { expires_at: new Date(Date.now() - 1000) }
            })

            const res = await supertest(app.server)
                .post('/auth/logout')
                .send({ refresh_token })

            expect(res.status).toBe(403)
        })

        it('Exception Test: returns 400 when refresh_token is missing from the body', async () => {
            const res = await supertest(app.server)
                .post('/auth/logout')
                .send({})

            expect(res.status).toBe(400)
        })
    })

    // ─── POST /auth/refresh ──────────────────────────────────────────────────────

    describe('POST /auth/refresh', () => {

        it('Equivalence Test: returns 200 with a new access_token on valid credentials', async () => {
            const { body: { access_token, refresh_token } } = await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/refresh')
                .set('Authorization', `Bearer ${access_token}`)
                .send({ refresh_token })

            expect(res.status).toBe(200)
            expect(res.body).toHaveProperty('access_token')
            expect(res.body).not.toHaveProperty('refresh_token')
        })

        it('Equivalence Test: returns 404 when the refresh_token does not exist', async () => {
            const { body: { access_token } } = await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/refresh')
                .set('Authorization', `Bearer ${access_token}`)
                .send({ refresh_token: '00000000-0000-0000-0000-000000000000' })

            expect(res.status).toBe(404)
        })

        it('Boundary Test: returns 403 when the refresh_token is expired', async () => {
            const { body: { access_token, refresh_token } } = await registerUser(app)

            await prisma.refreshToken.updateMany({
                where: { token: refresh_token },
                data: { expires_at: new Date(Date.now() - 1000) }
            })

            const res = await supertest(app.server)
                .post('/auth/refresh')
                .set('Authorization', `Bearer ${access_token}`)
                .send({ refresh_token })

            expect(res.status).toBe(403)
        })

        it('Boundary Test: returns 403 when the access_token is invalid', async () => {
            const { body: { refresh_token } } = await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/refresh')
                .set('Authorization', 'Bearer invalid-token')
                .send({ refresh_token })

            expect(res.status).toBe(403)
        })

        it('Exception Test: returns 400 when the authorization header is missing', async () => {
            const res = await supertest(app.server)
                .post('/auth/refresh')
                .send({ refresh_token: 'any-token' })

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 when refresh_token is missing from the body', async () => {
            const { body: { access_token } } = await registerUser(app)

            const res = await supertest(app.server)
                .post('/auth/refresh')
                .set('Authorization', `Bearer ${access_token}`)
                .send({})

            expect(res.status).toBe(400)
        })
    })
})
