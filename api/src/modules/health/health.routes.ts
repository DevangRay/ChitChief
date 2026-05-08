import { type FastifyInstance } from "fastify";
import { healthCheckSchema } from "./health.schema.js";

export default async function routes(fastify: FastifyInstance, options: Object) {
    fastify.get("", { schema: healthCheckSchema }, async (_, reply) => {
        return reply.status(200).send({ status: 'ok' });
    });
}
