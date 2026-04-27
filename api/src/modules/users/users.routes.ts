import { type FastifyInstance } from "fastify";
import { UserService } from "./users.service.js";
import { getMeSchema, getMeOrdersSchema } from "./users.schema.js";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError.js";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";
import { verifyToken } from "../../lib/verify-signed-token.js";

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new UserService(fastify.prisma);

    fastify.get('/me', { schema: getMeSchema }, async (request, reply) => {
        try {
            const authorization = request.headers.authorization ?? '';
            const access_token = authorization.startsWith('Bearer ')
                ? authorization.slice(7)
                : authorization;

            console.log('[users.routes GET /me] Validating access token.');
            const payload = verifyToken(access_token);
            const user_id = payload.user_id;
            console.log('[users.routes GET /me] Token valid. Fetching profile.');

            const result = await service.getProfile(user_id);
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

            console.log('[users.routes GET /me/orders] Validating access token.');
            const payload = verifyToken(access_token);
            const user_id = payload.user_id;
            console.log('[users.routes GET /me/orders] Token valid. Fetching orders.');

            const result = await service.getOrders(user_id);
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
