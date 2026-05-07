# ChitChief 🎟 Ticketing API

## Check the Deployed API
### Live API Explorer: https://chitchief.up.railway.app/docs

## Test the API locally yourself!
#### Using Docker
* Use example .env files:
    * Located at:
        * [root .env.example](.env.example)
        * [api .env.example](/api/.env.example)
    * To create corresponding `.env` files
* Create Docker instances
    * `docker compose up --build -d`
* Connect Stripe webhook
    * Run in `/api` directory: `stripe listen --forward-to localhost:3000/webhooks/payment/confirm`
* Restarting/Shutting-down Docker instance
    * `docker compose down`
        * run with flag `-v` to clear the slate

## Example Backend flow
1. `POST /auth/register` or `POST /auth/login`        → create an account/login to get a JWT token (copy it)
2. `GET  /events`               → browse available events
3. `GET  /events/{id}/seats`    → see seat availability
4. `POST /tickets/reserve`      → hold seats #A4, #A5 (60s lock starts)
5. `GET /tickets/demo/idempotency_key`      → for test purposes, create Idempotency Key (would be created by front-end)
6. `POST /tickets/purchase/intent`       → create PaymentIntent, confirm with pre-set payment method
7. `[CALLED BY STRIPE] POST /webhooks/payment/confirm`      → completes the payment and sends you an email based on if the payment succeeded or failed
8. `GET  /users/me/orders`               → see completed order in history
9. `POST /tickets/reserve`      → try to grab same seat in #A3, #A4 (overlap)→ 409 Conflict
10. `POST /auth/logout`         → deletes refresh token to end session

## DB Schema
* Interactive map:
    * https://dbdocs.io/devangray624/ChitChief-DB-Schema
* Schema can be seen at:
    * [prisma.schema](api/prisma/schema.prisma) located at `/api/prisma/schema.prisma`

## Load Testing Results
Testing the core-concurrency requierment. Exactly 1 user succeeds when many race for the same seat. This was verified under load.
### Test: 400 Concurrent Reservation Requests from 200 Users
#### Command used:
```
npm run test:performance:concurrent
```
or 
```bash
node src/test/run-performance.mjs concurrent_reservation
```
#### Results
* `conflict_reservations` count is 399
* `successful_reservations` count is 1

![See the full results](/resources/k6_concurrency_test.png)
#### Discussion
50 virtual users simultaneously hit the same seat reservation endpoint.
Redis's atomic Lua script ensures exactly one lock is acquired — the 
remaining 399 receive a 409 conflict response, directly proving the solution properly supports concurrency.

## Tech Stack breakdown
* DB
    * PostgreSQL
    * Prisma as ORM
* API Layer
    * Fastify
    * @fastify/swagger & @fastify/swagger-ui for OpenAPI Docs
* Distributed Locking/Cache
    * Redis
* Event driven architecture = Message Queue
    * BullMQ - Message Queue
    * Resend - Sending Email
* Payment
    * Stripe
* Authentication
    * Self-supported
* Testing
    * Unit tests
        * `vitest`
    * Integration tests
        * real postgres + redis through `testcontainers`
    * E2E tests
        * full http request through Fastify with `Supertest`
    * Load testing
        * `k6`

## Notes
### This backend demo focuses on:
* High-concurrency seat reservation (100+ simultaneous users)
* Race condition handling with pessimistic locking
* Distributed job processing with BullMQ
* Idempotent payment processing
* Comprehensive test coverage with testcontainers

### Limitations
* I used a single Redis instance for simplicity, but I'm aware this creates a single point of failure. In production I'd use `Redis Cluster` or the `Redlock algorithm` across multiple nodes to ensure lock durability if a node fails mid-operation.
* For demo purposes I collapsed the PaymentIntent creation and confirmation into a single call: `POST /tickets/purchase/intent`
    * In production I would split this up.
        * `POST /tickets/puchase/intent` would create the PaymentIntent and return the client_secret.
        * Client-side would use something like `Stripe.js` to get payment information and confirm the payment
    * The webhook `POST /ticekts/purchase/confirm` would still exist to handle orders after confirmation (handling both success and error)
* 3DS authentication requires customer interaction and is out of scope for a backend-only demo.
    * In this demo, payments requiring 3DS are marked as failed and seats released
    * In production, this would be handled with either:
        * Stripe Checkout (hosted pages)
        * Frontend integration with Stripe.js
        * Mobile app with Stripe SDK
* With the free-tier on Neon, the deployed PostgreSQL DB scales down in periods of inactivity. This results in some latency for the first query, but once the instance is cold-started subsequent queries will have normal performance.
* Currently, there is no way to invalidate a user's access token. The refresh token is deleted so the users' current session can not be extended. 
    * Future implementation to add a list of invalidated access tokens in redis that is stored before they are naturally expired.
* Currently, the tickets service gets the max available seat count from Prisma. This is not fully concurrently-safe, but with the Redis locks and BullMQ worker, it would be impossible for a user to reserve an unavailable seat anyway.
    * Future implementation to track seat count with Redis.


## Glossary
* Re-generating prisma
    * `npx prisma generate`
* Locally see Postgres DB
    * `npx prisma studio`
    * May have to define local DB string, stored in the [API .env](/api/.env) (at `/api/.env`) as LOCAL_PRISMA_DATABASE_URL for reference
        * Add parameter `--url "${LOCAL_PRISMA_DATABASE_URL}"`
* Connect Stripe webhook
    * `stripe listen --forward-to localhost:3000/webhooks/payment/confirm`
* Resend emails
    * https://resend.com/emails
    * https://mxtoolbox.com/SuperTool.aspx?action=dmarc%3adevangray.dev&run=toolpage
* k6 performance testing
    * k6 testing should only be done locally
    * requires installation locally: https://grafana.com/docs/k6/latest/set-up/install-k6/