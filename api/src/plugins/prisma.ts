import { PrismaClient } from "@prisma/client";
import { FastifyInstance } from "fastify";
import fp from 'fastify-plugin';
import { createPrismaClient } from "../lib/prisma-factory";

// Source - https://stackoverflow.com/a/54167614
// Posted by DavidP, modified by community. See post 'Timeline' for change history
// Retrieved 2026-03-25, License - CC BY-SA 4.0
// EXPLANATION: Allows file to retrieve .env file from parent directory
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

declare module 'fastify' {
    interface FastifyInstance {
        prisma: PrismaClient
    }
}

async function prismaPlugin(fastify: FastifyInstance) {
    const prisma = createPrismaClient(process.env.DATABASE_URL!);
    await prisma.$connect();

    fastify.decorate('prisma', prisma);
    fastify.addHook('onClose', async () => await prisma.$disconnect());
}

export default fp(prismaPlugin);