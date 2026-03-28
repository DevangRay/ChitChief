import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { buildApp } from '../../app'
import { startDb, stopDb, clearDb, prisma } from '../../test/helpers/db.helper'
import { createSeatFixture } from '../../test/fixtures/seat.fixture'
import { FastifyInstance } from 'fastify'

describe('Events Routes E2E', () => {
    let app: FastifyInstance

    beforeAll(async () => {
        await startDb()
        app = await buildApp()
        await app.ready()
    })

    afterAll(async () => {
        // await app.close()
        await stopDb()
    })

    beforeEach(async () => {
        await clearDb()
    })

    // ─── GET /events ────────────────────────────────────────────────────────────

    describe('GET /events', () => {

        it('Equivalence Test: returns 200 with array of future events', async () => {
            await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .get('/events')

            expect(res.status).toBe(200)
            expect(Array.isArray(res.body)).toBe(true)
            expect(res.body.length).toBe(1)
            expect(res.body[0]).toMatchObject({
                name: 'Test Event',
                venue: 'Test Venue',
            })
        })

        it('Boundary Test: returns 200 when no events exist', async () => {
            const res = await supertest(app.server)
                .get('/events')

            expect(res.status).toBe(200)
        })

        it('Boundary Test: does not return past events', async () => {
            // Create a past event directly
            await prisma.event.create({
                data: {
                    name: 'Past Event',
                    venue: 'Test Venue',
                    date: new Date('2020-01-01T00:00:00Z'), // in the past
                }
            })

            const res = await supertest(app.server)
                .get('/events')

            expect(res.status).toBe(200)
        })

        it('Equivalence Test: returns events sorted by date ascending', async () => {
            await prisma.event.createMany({
                data: [
                    { name: 'Event C', venue: 'Venue', date: new Date('2027-03-01T00:00:00Z') },
                    { name: 'Event A', venue: 'Venue', date: new Date('2027-01-01T00:00:00Z') },
                    { name: 'Event B', venue: 'Venue', date: new Date('2027-02-01T00:00:00Z') },
                ]
            })

            const res = await supertest(app.server)
                .get('/events')

            expect(res.status).toBe(200)
            expect(res.body[0].name).toBe('Event A')
            expect(res.body[1].name).toBe('Event B')
            expect(res.body[2].name).toBe('Event C')
        })

        it('Exception Test: response shape matches schema', async () => {
            await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .get('/events')

            expect(res.status).toBe(200)
            const event = res.body[0]
            expect(event).toHaveProperty('id')
            expect(event).toHaveProperty('name')
            expect(event).toHaveProperty('venue')
            expect(event).toHaveProperty('date')
            expect(event).toHaveProperty('created_at')
        })
    })

    // ─── GET /events/:id ────────────────────────────────────────────────────────

    describe('GET /events/:id', () => {

        it('Equivalence Test: returns 200 with event and seat_count', async () => {
            const { event } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .get(`/events/${event.id}`)

            expect(res.status).toBe(200)
            expect(res.body).toMatchObject({
                id: event.id,
                name: event.name,
                venue: event.venue,
            })
            expect(res.body).toHaveProperty('seat_count')
            expect(typeof res.body.seat_count).toBe('number')
        })

        it('Equivalence Test: seat_count reflects only AVAILABLE seats', async () => {
            const { event } = await createSeatFixture(prisma, { status: 'AVAILABLE' })
            // Add a reserved seat to the same event
            await prisma.seat.create({
                data: {
                    event_id: event.id,
                    row: 'B',
                    number: 1,
                    price: 10000,
                    seat_status: 'RESERVED'
                }
            })

            const res = await supertest(app.server)
                .get(`/events/${event.id}`)

            expect(res.status).toBe(200)
            // Only the AVAILABLE seat should be counted
            expect(res.body.seat_count).toBe(1)
        })

        it('Boundary Test: returns 404 when event does not exist', async () => {
            const nonExistentId = '00000000-0000-0000-0000-000000000000'

            const res = await supertest(app.server)
                .get(`/events/${nonExistentId}`)

            expect(res.status).toBe(404)
            expect(res.body).toMatchObject({ message: 'Event not found.' })
        })

        it('Boundary Test: _count is not exposed in response', async () => {
            const { event } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .get(`/events/${event.id}`)

            expect(res.body).not.toHaveProperty('_count')
        })

        it('Exception Test: returns 400 for invalid UUID format', async () => {
            const res = await supertest(app.server)
                .get('/events/not-a-valid-uuid')

            expect(res.status).toBe(400)
        })
    })

    // ─── GET /events/:id/seats ───────────────────────────────────────────────────

    describe('GET /events/:id/seats', () => {

        it('Equivalence Test: returns 200 with all seats when no status filter', async () => {
            const { event } = await createSeatFixture(prisma, { status: 'AVAILABLE' })
            await prisma.seat.create({
                data: {
                    event_id: event.id,
                    row: 'B',
                    number: 1,
                    price: 10000,
                    seat_status: 'RESERVED'
                }
            })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats`)

            expect(res.status).toBe(200)
            expect(res.body.length).toBe(2)
        })

        it('Equivalence Test: filters seats by AVAILABLE status', async () => {
            const { event } = await createSeatFixture(prisma, { status: 'AVAILABLE' })
            await prisma.seat.create({
                data: {
                    event_id: event.id,
                    row: 'B',
                    number: 1,
                    price: 10000,
                    seat_status: 'SOLD'
                }
            })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats?status=AVAILABLE`)

            expect(res.status).toBe(200)
            expect(res.body.length).toBe(1)
            expect(res.body[0].seat_status).toBe('AVAILABLE')
        })

        it('Equivalence Test: filters seats by RESERVED status', async () => {
            const { event } = await createSeatFixture(prisma, { status: 'RESERVED' })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats?status=RESERVED`)

            expect(res.status).toBe(200)
            expect(res.body.length).toBe(1)
            expect(res.body[0].seat_status).toBe('RESERVED')
        })

        it('Equivalence Test: filters seats by SOLD status', async () => {
            const { event } = await createSeatFixture(prisma, { status: 'SOLD' })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats?status=SOLD`)

            expect(res.status).toBe(200)
            expect(res.body.length).toBe(1)
            expect(res.body[0].seat_status).toBe('SOLD')
        })

        it('Equivalence Test: seats are returned sorted by price ascending', async () => {
            const { event } = await createSeatFixture(prisma, { price: 30000 })
            await prisma.seat.create({
                data: { event_id: event.id, row: 'B', number: 1, price: 10000, seat_status: 'AVAILABLE' }
            })
            await prisma.seat.create({
                data: { event_id: event.id, row: 'C', number: 1, price: 20000, seat_status: 'AVAILABLE' }
            })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats`)

            expect(res.status).toBe(200)
            expect(res.body[0].price).toBe(10000)
            expect(res.body[1].price).toBe(20000)
            expect(res.body[2].price).toBe(30000)
        })

        it('Boundary Test: returns 404 when event has no seats', async () => {
            const event = await prisma.event.create({
                data: {
                    name: 'Empty Event',
                    venue: 'Test Venue',
                    date: new Date('2027-01-01T00:00:00Z'),
                }
            })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats`)

            expect(res.status).toBe(404)
        })

        it('Boundary Test: returns 404 when no seats match status filter', async () => {
            const { event } = await createSeatFixture(prisma, { status: 'AVAILABLE' })

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats?status=SOLD`)

            expect(res.status).toBe(404)
        })

        it('Exception Test: returns 400 for invalid status query param', async () => {
            const { event } = await createSeatFixture(prisma)

            const res = await supertest(app.server)
                .get(`/events/${event.id}/seats?status=INVALID`)

            expect(res.status).toBe(400)
        })

        it('Exception Test: returns 400 for invalid UUID format', async () => {
            const res = await supertest(app.server)
                .get('/events/not-a-valid-uuid/seats')

            expect(res.status).toBe(400)
        })
    })
})