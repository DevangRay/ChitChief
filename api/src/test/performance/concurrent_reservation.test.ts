/**
 * CONCURRENCY VALIDATION TEST
 *
 * 50 VUs simultaneously attempt to reserve the exact same 2 seats.
 * The Redis Lua script ensures exactly 1 succeeds — the rest get 409.
 *
 * Thresholds:
 *   successful_reservations count >= 1  → at least one VU reserved (seat locking not broken)
 *   successful_reservations count < 2   → no double-booking occurred
 *   checks rate > 0.95                  → no unexpected 500 errors
 */
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import encoding from "k6/encoding";

const BASE_URL = "http://localhost:3000";

// 409 is an expected outcome in this test — tell k6 not to count it as http_req_failed
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

const successful_reservations = new Counter("successful_reservations");
const conflict_reservations = new Counter("conflict_reservations");

export const options = {
    scenarios: {
        concurrent_burst: {
            executor: "shared-iterations",
            vus: 200,
            iterations: 400,
            maxDuration: "60s",
        },
    },
    thresholds: {
        "successful_reservations": ["count>=1", "count<2"],
        "http_req_failed": ["rate<0.01"],
        "checks": ["rate>0.95"],
        "http_req_duration": ["p(95)<3500"],
    },
};

function decodeJwt(token: string): { user_id: string; user_email: string } {
    const base64url = token.split(".")[1];
    return JSON.parse(encoding.b64decode(base64url, "rawurl", "s") as string);
}

export function setup() {
    const events_res = http.get(`${BASE_URL}/events`);
    if (events_res.status !== 200) {
        throw new Error(`GET /events failed with status ${events_res.status}`);
    }
    const events: { id: string }[] = JSON.parse(events_res.body as string);
    if (!events.length) {
        throw new Error("No events found — run seed data before the performance tests.");
    }

    const seats_res = http.get(
        `${BASE_URL}/events/${events[0].id}/seats?status=AVAILABLE`
    );
    if (seats_res.status !== 200) {
        throw new Error(`GET /events/:id/seats failed with status ${seats_res.status}`);
    }
    const seats: { id: string }[] = JSON.parse(seats_res.body as string);
    if (seats.length < 2) {
        throw new Error(
            `Need ≥2 available seats, found ${seats.length}. Run seed data or wait for TTL reset.`
        );
    }

    // All VUs will compete for these exact same two seats
    const contested_seat_ids = [seats[0].id, seats[1].id];

    const user_name = `perf_concurrent_${Date.now()}`;
    const register_res = http.post(
        `${BASE_URL}/auth/register`,
        JSON.stringify({
            user_name,
            email: `${user_name}@loadtest.local`,
            password: "LoadTest123!",
        }),
        { headers: { "Content-Type": "application/json" } }
    );
    if (register_res.status !== 201) {
        throw new Error(
            `Registration failed: ${register_res.status} — ${register_res.body}`
        );
    }

    const { access_token } = JSON.parse(register_res.body as string);
    const { user_id } = decodeJwt(access_token);

    return { seat_ids: contested_seat_ids, user_uuid: user_id, access_token: access_token };
}

export function teardown(data: { seat_ids: string[]; user_uuid: string; access_token: string }) {
    http.post(
        `${BASE_URL}/test/cleanup`,
        JSON.stringify({ user_ids: [data.user_uuid], seat_ids: data.seat_ids }),
        { headers: { "Content-Type": "application/json" } }
    );
}

export default function (data: { seat_ids: string[]; user_uuid: string, access_token: string }) {
    const res = http.post(
        `${BASE_URL}/tickets/reserve`,
        JSON.stringify({ seat_ids: data.seat_ids, user_uuid: data.user_uuid }),
        { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${data.access_token}` } }
    );

    check(res, {
        "no server error (status 200 or 409)": (r) =>
            r.status === 200 || r.status === 409,
    });

    if (res.status === 200) {
        successful_reservations.add(1);
        check(res, {
            "reservation_token present": (r) =>
                typeof (JSON.parse(r.body as string) as any).reservation_token === "string",
            "expires_at present": (r) =>
                typeof (JSON.parse(r.body as string) as any).expires_at === "number",
        });
    } else if (res.status === 409) {
        conflict_reservations.add(1);
        check(res, {
            "conflict_seat_ids present on 409": (r) =>
                Array.isArray((JSON.parse(r.body as string) as any).conflict_seat_ids),
        });
    }
}
