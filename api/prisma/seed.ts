// Source - https://stackoverflow.com/a/54167614
// Posted by DavidP, modified by community. See post 'Timeline' for change history
// Retrieved 2026-03-25, License - CC BY-SA 4.0
// EXPLANATION: Allows file to retrieve .env file from parent directory
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
    await prisma.$connect();

    const row_array = Array.from({ length: 5 }, (_, i) => {
        return String.fromCharCode(65 + i);
    })

    const event = await prisma.event.create({
        data: {
            name: "BTS Arirang Tour",
            description: "Global tour.",
            venue: "MetLife Stadium",
            date: new Date("2026-07-09T20:00:00Z"),
            seats: {
                create: row_array.flatMap((row) => {
                    return Array.from({ length: 5 }, (_, j) => ({
                        row,
                        number: j + 1,
                        price: 10000
                    }))
                })
            }
        },
        include: { seats: true }
    })

    console.log(`Created event: ${event.name}`)
    console.log(`Created ${event.seats.length} seats`)
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());