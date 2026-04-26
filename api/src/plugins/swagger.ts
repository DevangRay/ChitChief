import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

async function swaggerPlugin(fastify: FastifyInstance) {
    await fastify.register(swagger, {
        openapi: {
            openapi: '3.0.0',
            info: {
                title: 'ChitChief API',
                description: 'ChitChief ticketing platform API',
                version: '1.0.0',
            },
            servers: [{ url: 'http://localhost:3000' }],
            components: {
                securitySchemes: {
                    bearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                    },
                },
            },
        },
    });

    await fastify.register(swaggerUi, {
        routePrefix: '/docs',
        uiConfig: {
            docExpansion: 'list',
            deepLinking: true,
        },
    });
}

export default fp(swaggerPlugin);
