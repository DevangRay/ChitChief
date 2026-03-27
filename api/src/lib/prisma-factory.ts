import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

export function createPrismaClient(connectionString: string) {
    const adapter = new PrismaPg({ connectionString: connectionString });
    return new PrismaClient({ adapter });
}