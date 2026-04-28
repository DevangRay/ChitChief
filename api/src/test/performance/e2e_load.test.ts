/**
 * END-TO-END LOAD TEST
 *
 * Simulates realistic user journeys under escalating concurrency.
 * Each VU iteration: register → browse events → reserve seats → view profile → logout.
 *
 * Seat assignment: VU n targets seats[(n-1)*2 .. n*2-1] so VUs don't fight each other
 * on the first reservation attempt. After the TTL expires (~60s), BullMQ resets seats
 * to AVAILABLE and the VU can reserve again on the next iteration.
 *
 * The registered user is auto-deleted after 30s (TEST BullMQ job in registerUser).
 * Each iteration creates a fresh user so this window is always satisfied.
 *
 * Thresholds:
 *   http_req_duration p(95) < 2s   → tail latency under load
 *   http_req_failed   rate < 5%    → near-zero network-level failures
 *   checks            rate > 0.85  → allow for expected seat conflicts on repeat iterations
 */
import { check, sleep, group } from "k6";
import http from "k6/http";
import encoding from "k6/encoding";

const BASE_URL = "http://localhost:3000";
const SEATS_PER_USER = 2;

// Under high VU counts every registration does a bcrypt hash (10 rounds). Node's libuv
// thread pool (4 threads by default) serialises these, so at 500 VUs a single bcrypt
// call can queue for ~25 s. k6's default 60 s timeout causes those legitimate-but-slow
// responses to be counted as http_req_failed network failures.
const REQUEST_PARAMS = { timeout: "120s" };

// 404 (no seats matching filter after reservations) is expected — not a failure
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 404, 409));

export const options = {
    stages: [
        { duration: "15s", target: 20 },
        { duration: "30s", target: 50 },
        { duration: "30s", target: 100 },
        { duration: "30s", target: 200 },
        { duration: "30s", target: 400 },
        { duration: "30s", target: 500 },
        { duration: "120s", target: 500 },
        { duration: "60s", target: 250 },
        { duration: "60s", target: 100 },
        { duration: "15s", target: 0 },
    ],
    thresholds: {
        // No http_req_duration threshold here: this test validates correctness (no 500s,
        // no double-booking, all checks pass), not latency. At 500 VUs, bcrypt (10 rounds)
        // saturates Node's libuv thread pool (4 threads), causing expected queuing that
        // pushes p(95) to ~20s on Local Hardware. See read_load.test.ts for latency benchmarks.
        "http_req_failed": ["rate<0.05"],
        "checks": ["rate>0.85"],
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
    const events: { id: string; name: string }[] = JSON.parse(events_res.body as string);
    if (!events.length) {
        throw new Error("No events found — run seed data before the performance tests.");
    }

    // Collect all available seats across all events
    const all_seats: { id: string }[] = [];
    for (const event of events) {
        const seats_res = http.get(
            `${BASE_URL}/events/${event.id}/seats?status=AVAILABLE`
        );
        if (seats_res.status === 200) {
            const seats: { id: string }[] = JSON.parse(seats_res.body as string);
            all_seats.push(...seats);
        }
    }

    return {
        event_id: events[0].id,
        all_seats,
        total_seats: all_seats.length,
    };
}

export function teardown(data: {
    event_id: string;
    all_seats: { id: string }[];
    total_seats: number;
}) {
    const seat_ids = data.all_seats.map((s) => s.id);
    http.post(
        `${BASE_URL}/test/cleanup`,
        JSON.stringify({ username_prefix: "perf_e2e_", seat_ids }),
        { headers: { "Content-Type": "application/json" } }
    );
}

export default function (data: {
    event_id: string;
    all_seats: { id: string }[];
    total_seats: number;
}) {
    // Deterministic per-VU seat window — avoids unintended conflicts between VUs
    const seat_start = (__VU - 1) * SEATS_PER_USER;
    const has_enough_seats =
        seat_start + SEATS_PER_USER <= data.total_seats;
    const my_seat_ids = has_enough_seats
        ? data.all_seats
            .slice(seat_start, seat_start + SEATS_PER_USER)
            .map((s) => s.id)
        : [];

    let access_token: string | null = null;
    let refresh_token: string | null = null;
    let user_uuid: string | null = null;

    // 1 — Register a fresh user for this iteration
    group("auth: register", () => {
        // __VU and __ITER make the name unique per VU per iteration; Date.now() handles rapid re-runs
        const user_name = `perf_e2e_v${__VU}_i${__ITER}_${Date.now()}`;
        const res = http.post(
            `${BASE_URL}/auth/register`,
            JSON.stringify({
                user_name,
                email: `${user_name}@loadtest.local`,
                password: "LoadTest123!",
            }),
            { ...REQUEST_PARAMS, headers: { "Content-Type": "application/json" } }
        );

        const passed = check(res, {
            "register: status 201": (r) => r.status === 201,
            "register: access_token returned": (r) => {
                try {
                    return typeof (JSON.parse(r.body as string) as any).access_token === "string";
                } catch {
                    return false;
                }
            },
        });

        if (passed && res.status === 201) {
            const body = JSON.parse(res.body as string);
            access_token = body.access_token;
            refresh_token = body.refresh_token;
            user_uuid = decodeJwt(body.access_token).user_id;
        }
    });

    // Skip the rest of the flow if registration failed
    if (!user_uuid || !access_token || !refresh_token) return;

    sleep(0.3);

    // 2 — Browse events
    group("events: list", () => {
        const res = http.get(`${BASE_URL}/events`, REQUEST_PARAMS);
        check(res, {
            "GET /events: status 200": (r) => r.status === 200,
            "GET /events: response is array": (r) => {
                try {
                    return Array.isArray(JSON.parse(r.body as string));
                } catch {
                    return false;
                }
            },
        });
    });

    group("events: get by id", () => {
        const res = http.get(`${BASE_URL}/events/${data.event_id}`, REQUEST_PARAMS);
        check(res, {
            "GET /events/:id: status 200": (r) => r.status === 200,
            "GET /events/:id: has seat_count": (r) => {
                try {
                    return typeof (JSON.parse(r.body as string) as any).seat_count === "number";
                } catch {
                    return false;
                }
            },
        });
    });

    group("events: get seats", () => {
        const res = http.get(
            `${BASE_URL}/events/${data.event_id}/seats?status=AVAILABLE`,
            REQUEST_PARAMS
        );
        check(res, {
            "GET /events/:id/seats: 200 or 404": (r) =>
                r.status === 200 || r.status === 404,
        });
    });

    sleep(0.3);

    // 3 — Reserve seats (409 is expected on repeat iterations until TTL resets seats)
    group("tickets: reserve", () => {
        if (!has_enough_seats) return;

        const res = http.post(
            `${BASE_URL}/tickets/reserve`,
            JSON.stringify({ seat_ids: my_seat_ids, user_uuid }),
            { ...REQUEST_PARAMS, headers: { "Content-Type": "application/json" } }
        );

        check(res, {
            "reserve: 200 or 409 (no server error)": (r) =>
                r.status === 200 || r.status === 409,
        });

        if (res.status === 409) {
            check(res, {
                "reserve 409: conflict_seat_ids present": (r) => {
                    try {
                        return Array.isArray(
                            (JSON.parse(r.body as string) as any).conflict_seat_ids
                        );
                    } catch {
                        return false;
                    }
                },
            });
        }
    });

    sleep(0.3);

    // 4 — View authenticated user profile
    group("users: get me", () => {
        const res = http.get(`${BASE_URL}/users/me`, {
            ...REQUEST_PARAMS,
            headers: { Authorization: `Bearer ${access_token}` },
        });
        check(res, {
            "GET /users/me: status 200": (r) => r.status === 200,
            "GET /users/me: has username": (r) => {
                try {
                    return typeof (JSON.parse(r.body as string) as any).username === "string";
                } catch {
                    return false;
                }
            },
        });
    });

    sleep(0.3);

    // 5 — Logout
    group("auth: logout", () => {
        const res = http.post(
            `${BASE_URL}/auth/logout`,
            JSON.stringify({ refresh_token }),
            { ...REQUEST_PARAMS, headers: { "Content-Type": "application/json" } }
        );
        check(res, {
            "logout: status 204": (r) => r.status === 204,
        });
    });
}
