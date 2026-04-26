import { config } from "dotenv";
import { execSync } from "child_process";

config({ path: new URL("../../.env", import.meta.url) });

execSync(
    // `k6 run -u 10 -d 30s --env BACKEND_SERVER_URL=${process.env["BACKEND_SERVER_URL"]} src/test/performance.test.ts`,
    `k6 run -u 10 -d 30s src/test/performance.test.ts`,
    { stdio: "inherit" }
);
