import { type FastifyInstance } from "fastify";
import { AuthService } from "./auth.service.js";

type RegisterRequestBody = {
    user_name: string,
    email: string,
    password: string
}

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new AuthService(fastify.prisma);

    fastify.post("/register", async (request, reply) => {
        // In a full-stack project, the front-end would HASH the password before sending it to the backend
        // Since the user directly interfaces with the backend in this case, the password is sent un-hashed, will be hashed and saved in this endpoint
        try {
            const request_body = request.body as RegisterRequestBody;
            const user_name = request_body.user_name;
            const email = request_body.email;
            const password = request_body.password;

            const result = await service.registerAuth(user_name, email, password);
        } catch (error) {
            const printable_error = (error as Error).message;

            console.log("[auth.routes /register]: Unplanned error: ", printable_error);
            fastify.log.error(error, '[POST /register] Failed to reserve seats');

            return reply.status(500).send({ message: 'Internal server error.' });
        }
    })
}