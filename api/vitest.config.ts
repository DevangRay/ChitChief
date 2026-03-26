import {defineConfig} from "vitest/config";

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
        testTimeout: 30000
    }
})