import { createPrismaClient } from "../src/lib/prisma-factory";

async function main() {
    const prisma = createPrismaClient(process.env.DATABASE_URL!);
    // 5 is a magic number right now, can be moved into its own variable for increased control
    // the length SHOULD NOT increase 25 (will go into punctuation)
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

    const user = await prisma.user.create({
        data: {
            email: "devangray624@gmail.com",
            username: "dray624",
            password_hash: "fake_hashed_password",
        }
    });

    console.log(`Created event: ${event.name}`)
    console.log(`Created ${event.seats.length} seats`)
    console.log(`Created user: ${user.username} | ${user.id}`)
}

main()
    .catch(console.error)