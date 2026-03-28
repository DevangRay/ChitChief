FROM node:20-alpine

WORKDIR /app
COPY . .

RUN npm install
RUN npx prisma generate
RUN npm run build

# Will be overriden for BullMQ
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]