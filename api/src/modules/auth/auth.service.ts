import { PrismaClient } from "@prisma/client";
import ResourceNotFoundError from "../../lib/custom_errors/ResourceNotFoundError.js";
import ConflictError from "../../lib/custom_errors/ConflictError.js";
import { compare, genSalt, hash } from "bcrypt-ts";

export class AuthService {
    constructor(private readonly prisma: PrismaClient) {
    }

    async registerAuth(user_name: string, email: string, password: string) {
        console.log("[registerAuth] Validating parameters.");
        if (!user_name) {
            console.log("[registerAuth] No user_name provided for reservation.");
            throw new ResourceNotFoundError("No user_name provided.")
        }
        if (!email) {
            console.log("[registerAuth] No email provided for reservation.");
            throw new ResourceNotFoundError("No email provided.")
        }
        if (!password) {
            console.log("[registerAuth] No password provided for reservation.");
            throw new ResourceNotFoundError("No password provided.")
        }
        console.log("[registerAuth] Parameter validation successful.");

        // check user does not already exit
        console.log("[registerAuth] Checking if user details already exist.");
        const does_user_exist = await this.prisma.user.findUnique({
            where: {
                username: user_name,
                email: email
            }
        })
        console.log("[registerAuth] Retrieved user:", does_user_exist);

        if (does_user_exist) {
            throw new ConflictError("This User and Email Address are not Unique");
        }

        // hash password
        console.log("[registerAuth] Hashing password to save in DB.");
        console.log("[registerAuth] Password is:", password);

        const salt = await genSalt(10);
        const hashed_password = await hash(password, salt);

        const diff_result = await compare("WRONG_PASSWORD", hashed_password)
        const same_result = await compare(password, hashed_password)
        console.log("Trying different password:", diff_result)
        console.log("Trying same password:", same_result)

        console.log("[registerAuth] Hashed password is:", hashed_password);
        // save user-details

        // return access/refresh token
    }
}