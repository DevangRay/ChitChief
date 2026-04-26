import { type FastifyInstance } from "fastify";
import { UserService } from "./users.service.js";
import { getMeSchema, getMeOrdersSchema } from "./users.schema.js";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError.js";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new UserService(fastify.prisma);

    fastify.get('/me', { schema: getMeSchema }, async (request, reply) => {
        try {
            const authorization = request.headers.authorization ?? '';
            const access_token = authorization.startsWith('Bearer ')
                ? authorization.slice(7)
                : authorization;

            const result = await service.getProfile(access_token);
            return reply.status(200).send(result);
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log('[users.routes GET /me]: Caught error:', printable_error);
            fastify.log.error(error, '[GET /me] Failed to get user profile');

            if (error instanceof ForbiddenError) {
                return reply.status(403).send({ message: error.message });
            } else if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    });

    fastify.get('/me/orders', { schema: getMeOrdersSchema }, async (request, reply) => {
        try {
            const authorization = request.headers.authorization ?? '';
            const access_token = authorization.startsWith('Bearer ')
                ? authorization.slice(7)
                : authorization;

            const result = await service.getOrders(access_token);
            return reply.status(200).send(result);
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log('[users.routes GET /me/orders]: Caught error:', printable_error);
            fastify.log.error(error, '[GET /me/orders] Failed to get user orders');

            if (error instanceof ForbiddenError) {
                return reply.status(403).send({ message: error.message });
            } else if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    });
}
