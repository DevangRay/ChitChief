import { type FastifySchema } from "fastify";

// GET /
export const healthCheckSchema: FastifySchema = {
    tags: ["Health"],
    description: "Simple health check for the API.",
    response: {
        200: {
            description: "API is healthy.",
            type: "object",
            properties: { status: { type: "string" } }
        }
    }
};