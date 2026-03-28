FROM node:20-alpine

WORKDIR /app
COPY . .

RUN npm install
RUN npx prisma generate
RUN npm run build

# Will be overriden for BullMQ
CMD ["node", "dist/server.js"]