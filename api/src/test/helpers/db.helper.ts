import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from "../../lib/prisma-factory";
import { execSync } from 'child_process';

let container: StartedPostgreSqlContainer
let prisma: PrismaClient

export async function startDb() {
    container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('ticketing_test')
        .withUsername('postgres')
        .withPassword('postgres')
        .start()

    const url = container.getConnectionUri();
    process.env.DATABASE_URL = url;

    // Run migrations against the test container
    execSync('npx prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: url }
    })

    prisma = createPrismaClient(url)
    await prisma.$connect();
}

export async function stopDb() {
    await prisma.$disconnect();
    await container.stop();
}

export async function clearDb() {
    // Delete in order that respects foreign keys
    await prisma.orderSeats.deleteMany();
    await prisma.order.deleteMany();
    await prisma.stripePaymentInfo.deleteMany();
    await prisma.seat.deleteMany();
    await prisma.event.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
}

export { prisma };