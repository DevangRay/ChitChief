import jwt from 'jsonwebtoken';
import ForbiddenError from "./custom_errors/ForbiddenError.js";

type TokenPayload = {
    user_id: string;
    user_email: string;
};

export function verifyToken(access_token: string): TokenPayload {
    if (!access_token) {
        throw new ForbiddenError("No access token provided.");
    }
    try {
        const payload = jwt.verify(access_token, process.env.SIGNING_SECRET!) as TokenPayload;
        if (!payload) {
            throw new ForbiddenError("Invalid access token.");
        }
        
        console.log('[verifyToken] Token payload: ', payload);
        return payload;
    } catch (error) {
        if (error instanceof ForbiddenError) throw error;
        if (error instanceof Error && error.name === 'TokenExpiredError') {
            throw new ForbiddenError("Access token has expired.");
        }
        throw new ForbiddenError("Invalid access token.");
    }
}