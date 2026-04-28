# ---- Stage 1: Build ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

COPY tsconfig.json ./
COPY src ./src/
RUN npx prisma generate && npm run build

# ---- Stage 2: Production ----
FROM node:20-alpine AS production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Compiled output
COPY --from=builder /app/dist ./dist/

# Prisma generated engine binary (needed at runtime)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Prisma CLI (needed for migrate deploy at startup; it's a devDep so copy from builder)
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma/
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

# Schema + migration files (needed for migrate deploy)
COPY prisma ./prisma/

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:${BACKEND_SERVER_PORT:-3000}/health || exit 1

# Overridden to "node dist/worker.js" for the worker service
CMD ["node", "dist/server.js"]
