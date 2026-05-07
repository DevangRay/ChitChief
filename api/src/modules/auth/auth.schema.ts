import type { FastifySchema } from "fastify";

export const registerUserSchema: FastifySchema = {
    tags: ["Auth"],
    description: "Create a new user account. Returns a JWT access token + refresh token for re-authentication.",
    body: {
        type: "object",
        required: ["user_name", "email", "password"],
        properties: {
            user_name: {
                type: "string",
                description: "String username of new user",
                examples: ["john_doe"]
            },
            email: {
                type: "string",
                format: "email",
                description: "String email of new user",
                examples: ["john.doe@example.com"]
            },
            password: {
                type: "string",
                description: "Plain-text password of new user. In real production, the password would only travel hashed.",
                examples: ["SecurePass123!"]
            }
        }
    },
    response: {
        201: {
            description: "User was successfully created. Valid JWT token and refresh token is returned for future authentication.",
            type: "object",
            properties: {
                access_token: { type: "string" },
                refresh_token: { type: "string" }
            }
        },
        404: {
            description: "Username, email, and/or password were invalid.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        409: {
            description: "A user already uses the provided credentials.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        500: {
            description: "Internal server error",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}

export const loginSchema: FastifySchema = {
    tags: ["Auth"],
    description: "Login to an existing user account. Returns a JWT access token + refresh token for re-authentication.",
    body: {
        type: "object",
        required: ["user_name", "password"],
        properties: {
            user_name: {
                type: "string",
                description: "String username of new user",
                examples: ["john_doe"]
            },
            password: {
                type: "string",
                description: "Plain-text password of new user. In real production, the password would only travel hashed.",
                examples: ["SecurePass123!"]
            }
        }
    },
    response: {
        200: {
            description: "User was successfully logged-in. Valid JWT token and refresh token is returned for future authentication.",
            type: "object",
            properties: {
                access_token: { type: "string" },
                refresh_token: { type: "string" }
            }
        },
        404: {
            description: "Either the provided username and/or password were invalid, or no User exists for the given credentials.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        403: {
            description: "The incorrect credentials were provided",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        500: {
            description: "Internal server error",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}

export const logoutSchema: FastifySchema = {
    tags: ["Auth"],
    description: "Log-out of an authenticated session.",
    body: {
        type: "object",
        required: ["refresh_token"],
        properties: {
            refresh_token: {
                type: "string",
                description: "Refresh Token previously provided.",
                examples: ["550e8400-e29b-41d4-a716-446655440000"]
            }
        }
    },
    response: {
        204: {
            description: "User was successfully logged-out.",
            type: 'null'
        },
        404: {
            description: "The provided resource_token was invalid.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        403: {
            description: "No ResourceToken was found",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        500: {
            description: "Internal server error",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}

export const refreshSchema: FastifySchema = {
    tags: ["Auth"],
    description: "If the provided refresh token is valid, a new JWT access token is issued.",
    security: [{ bearerAuth: [] }],
    headers: {
        type: "object",
        required: ["authorization"],
        properties: {
            authorization: {
                type: "string",
                description: "Bearer JWT access token — 'Bearer <token>'",
                examples: ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"]
            }
        }
    },
    body: {
        type: "object",
        required: ["refresh_token"],
        properties: {
            refresh_token: {
                type: "string",
                description: "Previously provided refresh token.",
                examples: ["550e8400-e29b-41d4-a716-446655440000"]
            }
        }
    },
    response: {
        200: {
            description: "Authentication tokens were succesfully rotated. The updated tokens are returned.",
            type: "object",
            properties: {
                access_token: { type: "string" }
            }
        },
        404: {
            description: "The provided JWT token or refresh_token were invalid.",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        },
        500: {
            description: "Internal server error",
            type: "object",
            properties: {
                message: { type: "string" }
            }
        }
    }
}