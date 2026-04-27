/**
 * READ-HEAVY LOAD TEST
 *
 * Validates that read-only endpoints scale under high concurrency.
 * No writes are performed — this isolates the read path (Postgres query performance,
 * connection pooling, serialization) from write contention.
 *
 * Ramps to 200 concurrent VUs hitting GET /events, GET /events/:id, and
 * GET /events/:id/seats in a tight loop.
 *
 * Thresholds:
 *   http_req_duration p(95) < 500ms, p(99) < 1s  → read tail latency
 *   http_req_failed   rate < 1%                   → near-zero connectivity errors
 *   checks            rate > 0.99                 → all responses are correct
 */
import { check, sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BACKEND_SERVER_URL || "http://localhost:3000";

// 404 (no seats matching filter after reservations) is expected — not a failure
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 404));

export const options = {
    stages: [
        { duration: "20s", target: 50 },
        { duration: "40s", target: 200 },
        { duration: "30s", target: 200 },
        { duration: "10s", target: 0 },
    ],
    thresholds: {
        "http_req_duration": ["p(95)<500", "p(99)<1000"],
        "http_req_failed": ["rate<0.01"],
        "checks": ["rate>0.99"],
    },
};

export function setup() {
    const res = http.get(`${BASE_URL}/events`);
    if (res.status !== 200) {
        throw new Error(`GET /events failed with status ${res.status}`);
    }
    const events: { id: string }[] = JSON.parse(res.body as string);
    if (!events.length) {
        throw new Error("No events found — run seed data before the performance tests.");
    }
    return { event_id: events[0].id };
}

export default function (data: { event_id: string }) {
    const events_res = http.get(`${BASE_URL}/events`);
    check(events_res, {
        "GET /events: status 200": (r) => r.status === 200,
        "GET /events: response is array": (r) => {
            try {
                return Array.isArray(JSON.parse(r.body as string));
            } catch {
                return false;
            }
        },
    });

    sleep(0.05);

    const event_res = http.get(`${BASE_URL}/events/${data.event_id}`);
    check(event_res, {
        "GET /events/:id: status 200": (r) => r.status === 200,
        "GET /events/:id: has seat_count": (r) => {
            try {
                return typeof (JSON.parse(r.body as string) as any).seat_count === "number";
            } catch {
                return false;
            }
        },
    });

    sleep(0.05);

    const seats_res = http.get(
        `${BASE_URL}/events/${data.event_id}/seats?status=AVAILABLE`
    );
    check(seats_res, {
        "GET /events/:id/seats: 200 or 404": (r) =>
            r.status === 200 || r.status === 404,
    });

    sleep(0.05);
}
