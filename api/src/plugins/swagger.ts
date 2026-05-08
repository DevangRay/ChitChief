import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import "dotenv/config"; // Ensure environment variables are loaded

async function swaggerPlugin(fastify: FastifyInstance) {
    await fastify.register(swagger, {
        openapi: {
            openapi: '3.0.0',
            info: {
                title: 'ChitChief API',
                description: 'ChitChief ticketing platform API',
                version: '1.0.0',
            },
            servers: [
                {
                    url: process.env.DEPLOYED_BACKEND_URL ? `https://${process.env.DEPLOYED_BACKEND_URL}` : 'http://localhost:3000',
                    description: process.env.DEPLOYED_BACKEND_URL ? 'Deployed backend server' : 'Local development server',
                },
            ],
            tags: [
                { name: 'Auth', description: 'User registration, login, logout, and JWT token refresh' },
                { name: 'Users', description: 'Authenticated user profile and order history' },
                { name: 'Events', description: 'Browse available events and their seating inventory' },
                { name: 'Tickets', description: 'Reserve seats with distributed locking and process payments via Stripe' },
                { name: 'Webhooks', description: 'Stripe webhook callbacks for async payment confirmation' },
                { name: 'Health', description: 'Health check endpoints' },
            ],
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
