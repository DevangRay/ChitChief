import type { FastifySchema } from "fastify";

export const registerUserSchema: FastifySchema = {
    body: {
        type: "object",
        required: ["user_name", "email", "password"],
        properties: {
            user_name: {
                type: "string",
                description: "String username of new user"
            },
            email: {
                type: "string",
                format: "email",
                description: "String email of new user"
            },
            password: {
                type: "string",
                description: "Plain-text password of new user. In real product, the password would only travel hashed."
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
    body: {
        type: "object",
        required: ["user_name", "password"],
        properties: {
            user_name: {
                type: "string",
                description: "String username of new user"
            },
            password: {
                type: "string",
                description: "Plain-text password of new user. In real product, the password would only travel hashed."
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
    body: {
        type: "object",
        required: ["refresh_token"],
        properties: {
            refresh_token: {
                type: "string",
                description: "Refresh Token previously provided."
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
    body: {
        type: "object",
        required: ["jwt_token", "refresh_token"],
        properties: {
            jwt_token: {
                type: "string",
                description: "Previously provided JWT signed token."
            },
            refresh_token: {
                type: "string",
                description: "Previously provided refresh token."
            }
        }
    },
    response: {
        200: {
            description: "Authentication tokens were succesfully rotated. The updated tokens are returned.",
            type: "object",
            properties: {
                access_token: { type: "string" },
                refresh_token: { type: "string" }
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