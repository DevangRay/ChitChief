# ChitChief
* Running Docker instance
    * `docker compose up -d`
* Restarting/Shutting-down Docker instance
    * `docker compose down -v`
---
DB Schema 
* https://dbdocs.io/devangray624/ChitChief-DB-Schema
---
Goals
* Distributed seat locking with Redis + TTL
    * Orders should handle for multiple seats at once
* Idempotency keys on purchase endpoints
* Event-driven architecture
* Testing + especially load testing
* OpenApi docs
    * Should pin live Swagger URL to ReadMe at end
---
Hosting
* Dev
    * Docker
        * api
            * should `depends_on` postgres and redis, with `service_healthy` and `service_started` respectively
        * BullMQ worker
            * should `depends_on` postgres & redis
        * postgres
        * redis
    * API and BullMQ will be the same TypeScript codebase, with different entry points
        * API = server.ts
        * BullMQ = worker.ts
    * should volumes be named?
* Live
    * Railway for all?
    * Upstash may be good for Redis though (per request)
---
Potential flow
1. POST /auth/register        → create an account
2. POST /auth/login           → get a JWT token (copy it)
3. GET  /events               → browse available events
4. GET  /events/{id}/seats    → see seat availability
5. POST /tickets/reserve      → hold seats #A14, #A15 (60s lock starts)
6. POST /tickets/purchase/intent       → create PaymentIntent, get client_secret
7. POST /tickets/purchase/confirm      → card: 4242 4242 4242 4242 → 200 OK
8. GET  /users/me/orders               → see completed order in history
9. POST /tickets/reserve      → try to grab same seat in #A13, #A14 (overlap)→ 409 Conflict
10. POST /auth/logout
---
Tech Stack breakdown
* DB
    * PostgreSQL
* API Layer
    * Fastify
    * @fastify/swagger & @fastify/swagger-ui for OpenAPI Docs
* Distributed Locking/Cache
    * Redis
* Event driven architecture = Message Queue
    * BullMQ
* Payment
    * Stripe
    * Resend to email order confirmation
* Authentication
    * Make it myself
* Testing
    * Vitest
    * k6 for load testing
---
Order of operations
1) Postgres schema + Prisma models
    * Will need seed script
        * start with 1 event/10 seats
2) Basic API structure
    * GET /events
    * GET /events/:id
        * return event with seat availabilty summar
    * GET /events/:id/seats
    * POST /tickets/reserve
        * connected to Redis to lock, get lock token from Redis
        * Lock all seats or None
    * BullMQ job that expired reservation and returns seats after timeout
    * TDD!!!!
3) Seat reservation with Redis locking
4) BullMQ for reservation expiry
5) Stripe for purchase endpoint (idempotency) and Resend
    * POST /tickets/purchase/intent
        * create Stripe PaymentIntent
    * POST /tickets/purchase/confirm
        * verifies payment
        * writes ORder
        * releases lock
        * queues email with BullMQ
            * need to set-up Resend here
    * Handle for idempotency key
6) Build out API
    * Auth
        * POST /auth/register
            * Hash password with bcrypt (10)
            * Creates user
            * return 201
        * POST /auth/login (returning JWT + refresh token)
            * find user by email
            * compare password hash with bcrypt
            * generate access token
                * decide timeout
            * generate refresh token
                * decide timeout
            * return both 
        * POST /auth/refresh (rotate refresh token)
            * validate refresh token exists and not expired
            * if valid:
                * delete old refresh
                * issue new token + new refresh
                * return both
        * POST /auth/logout
            * delete refresh token from DB
            * return 204
        * JWT middleware to check
    * GET /users/me
        * authenticated user profile
    * GET /users/me/orders
        * order history
6) Swagger docs
7) k6 load test
---
Payment
* 2 endpoints
    1. POST /tickets/purchase/intent
    * Creates a Stripe PaymentIntent
    * Returns a client_secret to the caller
    * Seat remains Redis-locked

    2. POST /tickets/purchase/confirm
    * Receives Stripe's payment confirmation
    * Verifies payment succeeded via Stripe API
    * Writes order to PostgreSQL
    * Releases Redis lock
    * Enqueues confirmation email via BullMQ
* Idempotency
    * Idempotency-Key header
        * supported by Stripe
---
Testing
* Unit tests
    * vitest
* Integration tests
    * real postgres + redis through testcontainers
* E2E tests
    * full http request through Fastify with Supertest