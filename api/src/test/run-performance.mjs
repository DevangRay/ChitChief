import { config } from "dotenv";
import { execSync } from "child_process";

config({ path: new URL("../../.env", import.meta.url) });

const TESTS = {
    concurrent_reservation: "src/test/performance/concurrent_reservation.test.ts",
    e2e_load: "src/test/performance/e2e_load.test.ts",
    read_load: "src/test/performance/read_load.test.ts",
};

const test_name = process.argv[2];
const base_url = "http://localhost:3000";

if (!test_name) {
    console.error("Usage: node run-performance.mjs <test_name>");
    console.error("Available tests:", Object.keys(TESTS).join(", "));
    process.exit(1);
}

if (!TESTS[test_name]) {
    console.error(`Unknown test: "${test_name}"`);
    console.error("Available tests:", Object.keys(TESTS).join(", "));
    process.exit(1);
}

const test_file = TESTS[test_name];
console.log(`\nRunning "${test_name}" against ${base_url}\n`);

execSync(
    `k6 run --env BACKEND_SERVER_URL=${base_url} ${test_file}`,
    { stdio: "inherit" }
);
