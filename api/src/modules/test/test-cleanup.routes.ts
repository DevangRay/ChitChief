import { type FastifyInstance } from "fastify";
import { SeatStatus } from "@prisma/client";
import { seatLockFromId } from "../../lib/redis-keys.js";

export default async function routes(fastify: FastifyInstance) {
    fastify.post("/cleanup", async (request, reply) => {
        const body = request.body as {
            user_ids?: string[];
            username_prefix?: string;
            seat_ids?: string[];
        };

        const { user_ids, username_prefix, seat_ids } = body;

        if (user_ids?.length) {
            await fastify.prisma.user.deleteMany({
                where: { id: { in: user_ids } },
            });
        }

        if (username_prefix) {
            await fastify.prisma.user.deleteMany({
                where: { username: { startsWith: username_prefix } },
            });
        }

        if (seat_ids?.length) {
            await fastify.prisma.seat.updateMany({
                where: { id: { in: seat_ids } },
                data: { seat_status: SeatStatus.AVAILABLE },
            });

            const redis_keys = seat_ids.map(seatLockFromId);
            await fastify.redis.del(...redis_keys);
        }

        return reply.status(204).send();
    });
}
