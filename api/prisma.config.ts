import "dotenv/config"; // Ensure environment variables are loaded
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  // ... other config (migrations, seed script, etc.)
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },

  datasource: {
    url: env("DATABASE_URL"), // Use the env() helper for type safety
  },
});
