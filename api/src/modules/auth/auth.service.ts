import { PrismaClient } from "@prisma/client";
import { compare, genSalt, hash } from "bcrypt-ts";
import jwt from "jsonwebtoken";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";
import ConflictError from "../../lib/custom_errors/ConflictError.js";
import { type Redis } from "ioredis";
import { Queue } from "bullmq";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError.js";
import type { TokenPayload } from "../../lib/verify-signed-token.js";

const ACCESS_TOKEN_TTL_IN_MINUTES = 15;
const REFRESH_TOKEN_TTL_IN_HOURS = 24;

export class AuthService {
    private readonly reservation_queue: Queue;

    constructor(private readonly prisma: PrismaClient, private readonly redis: Redis) {
        this.reservation_queue = new Queue('reservations', {
            connection: this.redis
        })
    }

    async registerUser(user_name: string, email: string, password: string) {
        console.log("[registerUser] Validating parameters.");
        if (!user_name) {
            console.log("[registerUser] No user_name provided.");
            throw new ResourceNotFoundError("No user_name provided.")
        }
        if (!email) {
            console.log("[registerUser] No email provided.");
            throw new ResourceNotFoundError("No email provided.")
        }
        if (!password) {
            console.log("[registerUser] No password provided.");
            throw new ResourceNotFoundError("No password provided.")
        }
        console.log("[registerUser] Parameter validation successful.");

        // check user does not already exit
        console.log("[registerUser] Checking if user details already exist.");
        const does_user_exist = await this.prisma.user.findUnique({
            where: {
                username: user_name,
                email: email
            }
        })
        console.log("[registerUser] Retrieved user:", does_user_exist);

        if (does_user_exist) {
            throw new ConflictError("This User and Email Address are not Unique");
        }

        // hash password
        console.log("[registerUser] Hashing password to save in DB.");

        const salt = await genSalt(10);
        const hashed_password = await hash(password, salt);

        console.log("[registerUser] Hashed password.");

        // save user-details
        console.log("[registerUser] Creating user.")
        let user_result;
        try {
            user_result = await this.prisma.user.create({
                data: {
                    email: email,
                    username: user_name,
                    password_hash: hashed_password
                }
            })
        } catch (error) {
            // P2002: unique constraint violation — username or email already taken
            if ((error as any)?.code === 'P2002') {
                throw new ConflictError("This User and Email Address are not Unique");
            }
            throw error;
        }
        console.log("[registerUser] Created user:", user_result);

        // return access/refresh token
        console.log("[registerUser] Creating user refresh token.");
        const refresh_token = await this.prisma.refreshToken.create({
            data: {
                user_id: user_result.id
            }
        })
        console.log("[registerUser] Created refresh token:", refresh_token);

        // create temp access token
        console.log("[registerUser] Creating user access token and returning.");
        const signable_payload = {
            user_id: user_result.id,
            user_email: user_result.email
        }
        const signed_token = jwt.sign(
            signable_payload,
            process.env.SIGNING_SECRET!,
            {
                // time must be given in seconds
                expiresIn: ACCESS_TOKEN_TTL_IN_MINUTES * 60
            }
        );

        console.log("[registerUser] Queueing job to delete token after TTL");
        this.reservation_queue.add(
            'remove_refresh_token',
            { refresh_token_id: refresh_token.id },
            {
                // have to check TTL from schema (done through Postgres)
                // 24 hours in milliseconds
                delay: REFRESH_TOKEN_TTL_IN_HOURS * 60 * 60 * 1000
            }
        )
        console.log("[registerUser] Queued remove_refresh_token job.");

        return {
            access_token: signed_token,
            refresh_token: refresh_token.token,
        }
    }

    async login(user_name: string, password: string) {
        console.log("[login] Validating parameters.");
        if (!user_name) {
            console.log("[login] No user_name provided for.");
            throw new ResourceNotFoundError("No user_name provided.")
        }
        if (!password) {
            console.log("[login] No password provided for.");
            throw new ResourceNotFoundError("No password provided.")
        }
        console.log("[login] Parameter validation successful.");

        // get user from DB
        console.log("[login] Retrieving user from DB.");
        const existing_user = await this.prisma.user.findUnique({
            where: {
                username: user_name
            }
        })
        if (!existing_user) {
            console.log("[login] No user found.");
            throw new ResourceNotFoundError("No user is connected");
        }
        console.log("[login] Found user:", existing_user);

        // compare password with hash
        console.log("[login] Checking password.");
        const is_password_correct = await compare(password, existing_user.password_hash);
        if (!is_password_correct) {
            console.log("[login] Password is incorrect.");
            throw new ForbiddenError("Invalid password");
        }
        console.log("[login] Password is valid. Reauthorizing successful.");

        // check userF not already logged in
        console.log("[login] Checking for existing Refresh Token.");
        const does_session_exist = await this.prisma.refreshToken.findUnique({
            where: {
                user_id: existing_user.id
            }
        })

        let refresh_token;
        if (!does_session_exist) {
            // create refresh token
            console.log("[login] Creating user refresh token.");
            refresh_token = await this.prisma.refreshToken.create({
                data: {
                    user_id: existing_user.id
                }
            })
            console.log("[login] Created refresh token:", refresh_token);
        } else if (does_session_exist.expires_at.getTime() < Date.now()) {
            console.log("[login] Refresh token exists, but is expired.")
            const deleted_result = await this.prisma.refreshToken.delete({
                where: {
                    id: does_session_exist.id
                }
            })
            console.log("[login] Refresh token deleted: ", deleted_result)

            console.log("[login] Creating user refresh token.");
            refresh_token = await this.prisma.refreshToken.create({
                data: {
                    user_id: existing_user.id
                }
            })
            console.log("[login] Created refresh token:", refresh_token);
        } else {
            console.log("[login] Found refresh token:", does_session_exist);
            console.log("[login] Refresh token exists, can return existing auth.");
            refresh_token = does_session_exist;
        }

        // return access_token and refresh token (same shape as registerAuth)
        console.log("[login] Creating user access token and returning.");
        const signable_payload = {
            user_id: existing_user.id,
            user_email: existing_user.email
        }
        const signed_token = jwt.sign(
            signable_payload,
            process.env.SIGNING_SECRET!,
            {
                // time must be given in seconds
                expiresIn: ACCESS_TOKEN_TTL_IN_MINUTES * 60
            }
        );

        return {
            access_token: signed_token,
            refresh_token: refresh_token.token,
        }
    }

    async logout(refresh_token: string) {
        console.log("[logout] Validating parameters.");
        if (!refresh_token) {
            console.log("[logout] No refresh_token provided.");
            throw new ResourceNotFoundError("No refresh_token provided.")
        }
        console.log("[logout] Parameter validation successful.");

        // retrieve RefreshToken
        console.log("[logout] Checking that refresh token exists.");
        const refresh_token_exists = await this.prisma.refreshToken.findUnique({
            where: {
                token: refresh_token
            }
        })
        if (!refresh_token_exists || refresh_token_exists.expires_at.getTime() < Date.now()) {
            // since job is queued to delete token, expiration is a fringe case. still good to catch here out of an abundance of caution
            console.log("[logout] Refresh token was invalid or expired.");
            throw new ForbiddenError("User session does not exist.")
        }
        console.log("[logout] Got refresh token:", refresh_token_exists);

        // delete RefreshToken
        console.log("[logout] Deleting refresh token.");
        const deleted_refresh_token = await this.prisma.refreshToken.delete({
            where: {
                token: refresh_token
            }
        })
        console.log("[logout] Succesfully deleted token:", deleted_refresh_token);

        return
    }

    async refresh(payload: TokenPayload, refresh_token: string) {
        console.log("[refresh] Validating parameters.");
        if (!payload) {
            console.log("[refresh] No payload provided for.");
            throw new ResourceNotFoundError("No payload provided.")
        }
        if (!refresh_token) {
            console.log("[refresh] No refresh_token provided for.");
            throw new ResourceNotFoundError("No refresh_token provided.")
        }
        console.log("[refresh] Parameter validation successful.");

        // check refresh_token
        console.log("[refresh] Checking refresh token exists.");
        const refresh_token_exists = await this.prisma.refreshToken.findUnique({
            where: {
                token: refresh_token
            },
            include: {
                user: true
            }
        })
        if (!refresh_token_exists) {
            console.log("[refresh] Refresh token does not exist.");
            throw new ResourceNotFoundError("Invalid refresh token.");
        } else if (refresh_token_exists.expires_at.getTime() < Date.now()) {
            console.log("[refresh] Refresh token is expired.");
            throw new ForbiddenError("Refresh token is expired.");
        }
        console.log("[refresh] Retrieved token:", refresh_token_exists);

        // return new jwt_token 
        console.log("[refresh] Creating new JWT token and returning from existing payload:", payload);
        const signed_token = jwt.sign(
            {
                user_id: payload.user_id,
                user_email: payload.user_email
            },
            process.env.SIGNING_SECRET!,
            {
                // time must be given in seconds
                expiresIn: ACCESS_TOKEN_TTL_IN_MINUTES * 60
            }
        );

        return {
            access_token: signed_token
        }
    }
}