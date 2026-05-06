import { type FastifyInstance } from "fastify";
import { AuthService } from "./auth.service.js";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";
import ConflictError from "../../lib/custom_errors/ConflictError.js";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError.js";
import { loginSchema, logoutSchema, refreshSchema, registerUserSchema } from "./auth.schema.js";

type RegisterRequestBody = {
    user_name: string,
    email: string,
    password: string
}
type LoginRequestBody = {
    user_name: string,
    password: string
}
type LogoutRequestBody = {
    refresh_token: string
}
type RefreshRequestBody = {
    jwt_token: string,
    refresh_token: string
}

export default async function routes(fastify: FastifyInstance, options: Object) {
    const service = new AuthService(fastify.prisma, fastify.redis);

    fastify.post("/register", { schema: registerUserSchema }, async (request, reply) => {
        // In a full-stack project, the front-end would HASH the password before sending it to the backend
        // Since the user directly interfaces with the backend in this case, the password is sent un-hashed, will be hashed and saved in this endpoint
        try {
            const request_body = request.body as RegisterRequestBody;
            const user_name = request_body.user_name;
            const email = request_body.email;
            const password = request_body.password;

            const result = await service.registerUser(user_name, email, password);
            return reply.status(201).send(result);
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log("[auth.routes /register]: Caught error: ", printable_error);
            fastify.log.error(error, '[POST /register] Failed to register User');

            if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else if (error instanceof ConflictError) {
                return reply.status(409).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    })

    fastify.post("/login", { schema: loginSchema }, async (request, reply) => {
        try {
            const request_body = request.body as LoginRequestBody;
            const user_name = request_body.user_name;
            const password = request_body.password;

            const result = await service.login(user_name, password);
            return reply.status(200).send(result);
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log("[auth.routes /login]: Caught error: ", printable_error);
            fastify.log.error(error, '[POST /login] Failed to login with provided credentials');

            if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else if (error instanceof ForbiddenError) {
                return reply.status(403).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    })

    fastify.post("/logout", { schema: logoutSchema }, async (request, reply) => {
        try {
            const request_body = request.body as LogoutRequestBody;
            const refresh_token = request_body.refresh_token;

            await service.logout(refresh_token);
            return reply.status(204).send();
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log("[auth.routes /logout]: Caught error: ", printable_error);
            fastify.log.error(error, '[POST /logout] Failed to logout for user');

            if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else if (error instanceof ForbiddenError) {
                return reply.status(403).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    })

    fastify.post("/refresh", { schema: refreshSchema }, async (request, reply) => {
        try {
            const request_body = request.body as RefreshRequestBody;
            const jwt_token = request_body.jwt_token;
            const refresh_token = request_body.refresh_token;

            const result = await service.refresh(jwt_token, refresh_token);
            return reply.status(200).send(result);
        } catch (error) {
            const printable_error = (error as Error).message;
            console.log("[auth.routes /refresh]: Caught error: ", printable_error);
            fastify.log.error(error, '[POST /refresh] Failed to refresh user credentials');

            if (error instanceof ResourceNotFoundError) {
                return reply.status(404).send({ message: error.message });
            } else if (error instanceof ForbiddenError) {
                return reply.status(403).send({ message: error.message });
            } else {
                return reply.status(500).send({ message: 'Internal server error.' });
            }
        }
    })
}