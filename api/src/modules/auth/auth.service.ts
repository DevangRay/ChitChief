import { PrismaClient } from "@prisma/client";
import { compare, genSalt, hash } from "bcrypt-ts";
import jwt from "jsonwebtoken";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";
import ConflictError from "../../lib/custom_errors/ConflictError.js";
import { type Redis } from "ioredis";
import { Queue } from "bullmq";
import ForbiddenError from "../../lib/custom_errors/ForbiddenError.js";

const ACCESS_TOKEN_TTL_IN_MINUTES = 15;

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
            console.log("[registerUser] No user_name provided for reservation.");
            throw new ResourceNotFoundError("No user_name provided.")
        }
        if (!email) {
            console.log("[registerUser] No email provided for reservation.");
            throw new ResourceNotFoundError("No email provided.")
        }
        if (!password) {
            console.log("[registerUser] No password provided for reservation.");
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
        const user_result = await this.prisma.user.create({
            data: {
                email: email,
                username: user_name,
                password_hash: hashed_password
            }
        })
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

        return {
            access_token: signed_token,
            refresh_token: refresh_token.token,
        }
    }

    async login(user_name: string, password: string) {
        console.log("[login] Validating parameters.");
        if (!user_name) {
            console.log("[login] No user_name provided for reservation.");
            throw new ResourceNotFoundError("No user_name provided.")
        }
        if (!password) {
            console.log("[login] No password provided for reservation.");
            throw new ResourceNotFoundError("No password provided.")
        }
        console.log("[login] Parameter validation successful.");

        // get user from DB
        const existing_user = await this.prisma.user.findUnique({
            where: {
                username: user_name
            }
        })
        if (!existing_user) {
            throw new ResourceNotFoundError("No user is connected");
        }

        // compare password with hash
        const is_password_correct = await compare(password, existing_user.password_hash);
        if (!is_password_correct) {
            throw new ForbiddenError("Invalid password");
        }

        // check user not already logged in
        const does_session_exist = await this.prisma.refreshToken.findUnique({
            where: {
                user_id: existing_user.id
            }
        })

        let refresh_token;
        if (!does_session_exist) {
            // create refresh token
            console.log("[registerUser] Creating user refresh token.");

            refresh_token = await this.prisma.refreshToken.create({
                data: {
                    user_id: existing_user.id
                }
            })
            
            console.log("[registerUser] Created refresh token:", refresh_token);
        } else {
            refresh_token = does_session_exist;
        }

        // return access_token and refresh token (same shape as registerAuth)
        console.log("[registerUser] Creating user access token and returning.");
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
}