/// <reference types="node" />
import 'dotenv/config';
import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!,
  },
  migrations: {
    seed: 'node dist/seed.js'
  }
})
