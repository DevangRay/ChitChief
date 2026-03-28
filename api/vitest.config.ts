import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            exclude: ['node_modules/', 'prisma/']
        },
        // separating integration tests
        include: ['src/**/*.test.ts'],
        testTimeout: 60000,   // 60s for individual tests
        hookTimeout: 60000,   // 60s for beforeAll/afterAll hooks ← this is what you're missing
    }
})