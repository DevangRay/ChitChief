/**
 * auth.service.unit.test.ts
 *
 * Behavior-driven unit tests for AuthService.registerUser(), login(),
 * logout(), and refresh().
 *
 * Design principles:
 *  - Tests describe WHAT the service does, not HOW it does it.
 *  - Mocks only define the external state of the world (DB records) — they do
 *    not assert on which Prisma method was called or how many times.
 *  - Exception: a handful of assertions check that specific DB writes occur
 *    (e.g. old token deletion in refresh) because those writes ARE the
 *    observable effect for void-returning sub-operations.
 *  - A full rewrite of the internals should not break any test here, as long
 *    as the service contract is preserved.
 *
 * Boundary conditions captured:
 *  registerUser
 *   - Valid input: creates user and returns access + refresh tokens
 *   - user_name / email / password: missing, null, or empty string
 *   - Conflict: user already exists with the same user_name + email
 *   - JWT payload contains user_id and user_email
 *   - access_token is a verifiable signed JWT
 *
 *  login
 *   - Valid input: returns access + refresh tokens
 *   - user_name / password: missing, null, or empty string
 *   - User not found in the database
 *   - Incorrect password
 *   - Already validated: a non-expired session exists → returns early
 *   - Expired session or no session → issues new tokens
 *   - JWT payload on success
 *
 *  logout
 *   - Valid input: completes without throwing
 *   - refresh_token: missing, null, or empty string
 *   - Token not found in database
 *   - Token is expired
 *   - Deletes the token on a valid call
 *   - Error propagation
 *
 *  refresh
 *   - Valid input: returns new access + refresh tokens
 *   - jwt_token / refresh_token: missing, null, or empty string
 *   - Refresh token not found in database
 *   - Refresh token is expired
 *   - New JWT carries the same user_id and user_email as the original
 *   - Old refresh token is deleted; new refresh token is issued
 *   - Returned refresh_token differs from the consumed one (rotation)
 *   - Error propagation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service';
import ResourceNotFoundError from '../../lib/custom_errors/ResourceNotFoundError';
import ConflictError from '../../lib/custom_errors/ConflictError';
import ForbiddenError from '../../lib/custom_errors/ForbiddenError';
import * as jwt from 'jsonwebtoken';

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
//
// vi.hoisted() ensures mockCompare is created before vi.mock() factories run,
// so individual tests can override its return value without re-importing.
// ─────────────────────────────────────────────────────────────────────────────

const { mockCompare } = vi.hoisted(() => ({
    mockCompare: vi.fn().mockResolvedValue(true),
}));

vi.mock('bcrypt-ts', () => ({
    genSalt: vi.fn().mockResolvedValue('salt'),
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: mockCompare,
}));

vi.mock('bullmq', () => ({
    Queue: vi.fn(class { add = vi.fn().mockResolvedValue({ id: 'job-1' }); } as any),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = 'user-uuid-1';
const USER_NAME = 'testuser';
const EMAIL = 'test@example.com';
const PASSWORD = 'plaintext-password';
const HASHED_PASSWORD = 'hashed_password';
const REFRESH_TOKEN_ID = 'refresh-token-uuid-1';
const REFRESH_TOKEN = 'refresh-token-value-uuid-1';
const NEW_REFRESH_TOKEN_ID = 'refresh-token-uuid-2';
const NEW_REFRESH_TOKEN = 'new-refresh-token-value-uuid-2';

const EXPECTED_AUTH_RETURN_OBJECT = {
    access_token: expect.any(String),
    refresh_token: expect.any(String),
};

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeUser = (overrides: Partial<{
    id: string; email: string; username: string; password_hash: string;
}> = {}) => ({
    id: USER_ID,
    email: EMAIL,
    username: USER_NAME,
    password_hash: HASHED_PASSWORD,
    created_at: new Date(),
    ...overrides,
});

const makeRefreshToken = (overrides: Partial<{
    id: string; token: string; user_id: string; expires_at: Date;
}> = {}) => ({
    id: REFRESH_TOKEN_ID,
    token: REFRESH_TOKEN,
    user_id: USER_ID,
    expires_at: new Date(Date.now() + 60_000),  // valid: 1 min in the future
    created_at: new Date(),
    ...overrides,
});

const makeRefreshTokenWithUser = (overrides: Partial<{
    id: string; token: string; user_id: string; expires_at: Date;
}> = {}) => ({
    id: REFRESH_TOKEN_ID,
    token: REFRESH_TOKEN,
    user_id: USER_ID,
    expires_at: new Date(Date.now() + 60_000),  // valid: 1 min in the future
    created_at: new Date(),
    user: {
        id: USER_ID, 
        email: EMAIL
    },
    ...overrides,
});

/** Convenience: a refresh token whose expires_at is already in the past. */
const makeExpiredRefreshToken = () =>
    makeRefreshToken({ expires_at: new Date(Date.now() - 1_000) });

/** Mint a valid JWT with the standard auth payload. */
const makeValidJwt = (
    userId: string = USER_ID,
    userEmail: string = EMAIL,
    expiresInSeconds = 900,
): string =>
    jwt.sign(
        { user_id: userId, user_email: userEmail },
        process.env.SIGNING_SECRET ?? 'test-secret-for-unit-tests',
        { expiresIn: expiresInSeconds },
    );

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
//
// Exposed surface:
//  • prisma.user.findUnique      — controls whether a user exists in the DB
//  • prisma.user.create          — controls the newly created user record
//  • prisma.refreshToken.findUnique / findFirst — controls token look-up result
//  • prisma.refreshToken.create  — controls the newly issued token record
//  • prisma.refreshToken.delete  — can be made to throw for error propagation
//
// redis is wired only to satisfy the AuthService constructor; it is not
// exercised by auth operations.
// ─────────────────────────────────────────────────────────────────────────────

const makeRedisMock = () => ({
    eval: vi.fn().mockResolvedValue(['OK']),
    keys: vi.fn().mockResolvedValue([]),
    pipeline: vi.fn().mockReturnValue({ del: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
});

const buildService = ({
    existingUser = null as ReturnType<typeof makeUser> | null,
    newUser = makeUser(),
    existingToken = null as ReturnType<typeof makeRefreshToken> | null,
    // newToken uses a distinct token string so rotation tests can assert
    // result.refresh_token !== REFRESH_TOKEN.
    newToken = makeRefreshToken({ id: NEW_REFRESH_TOKEN_ID, token: NEW_REFRESH_TOKEN }),
    userCreateError = undefined as Error | undefined,
    tokenDeleteError = undefined as Error | undefined,
} = {}) => {
    const prismaMock = {
        user: {
            findUnique: vi.fn().mockResolvedValue(existingUser),
            create: userCreateError
                ? vi.fn().mockRejectedValue(userCreateError)
                : vi.fn().mockResolvedValue(newUser),
        },
        refreshToken: {
            findUnique: vi.fn().mockResolvedValue(existingToken),
            findFirst: vi.fn().mockResolvedValue(existingToken),
            create: vi.fn().mockResolvedValue(newToken),
            delete: tokenDeleteError
                ? vi.fn().mockRejectedValue(tokenDeleteError)
                : vi.fn().mockResolvedValue(makeRefreshToken()),
        },
    };

    const redisMock = makeRedisMock();
    const service = new AuthService(prismaMock as any, redisMock as any);
    return { service, prismaMock, redisMock };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for asserting on access tokens
// ─────────────────────────────────────────────────────────────────────────────

/** Decode the token without verifying the signature to inspect its payload. */
const decodeToken = (token: string): Record<string, unknown> =>
    jwt.decode(token) as Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Tests — registerUser
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthService.registerUser — behavior', () => {

    beforeEach(() => {
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('succeeds for a valid user_name, email, and password', async () => {
                const { service } = buildService();

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });
        });

        describe('exception cases — missing user_name', () => {
            it('throws ResourceNotFoundError when user_name is an empty string', async () => {
                const { service } = buildService();

                await expect(service.registerUser('', EMAIL, PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_name is null', async () => {
                const { service } = buildService();

                await expect(service.registerUser(null as any, EMAIL, PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_name is undefined', async () => {
                const { service } = buildService();

                await expect(service.registerUser(undefined as any, EMAIL, PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing email', () => {
            it('throws ResourceNotFoundError when email is an empty string', async () => {
                const { service } = buildService();

                await expect(service.registerUser(USER_NAME, '', PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when email is null', async () => {
                const { service } = buildService();

                await expect(service.registerUser(USER_NAME, null as any, PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing password', () => {
            it('throws ResourceNotFoundError when password is an empty string', async () => {
                const { service } = buildService();

                await expect(service.registerUser(USER_NAME, EMAIL, ''))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when password is null', async () => {
                const { service } = buildService();

                await expect(service.registerUser(USER_NAME, EMAIL, null as any))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. User uniqueness check
    // =========================================================================

    describe('user uniqueness check', () => {

        describe('equivalence cases', () => {
            it('succeeds when no user exists with the given user_name and email', async () => {
                const { service } = buildService({ existingUser: null });

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });

            it('throws ConflictError when a user with the same user_name and email already exists', async () => {
                const { service } = buildService({ existingUser: makeUser() });

                await expect(service.registerUser(USER_NAME, EMAIL, PASSWORD))
                    .rejects.toBeInstanceOf(ConflictError);
            });
        });
    });

    // =========================================================================
    // 3. Return value contract
    // =========================================================================

    describe('return value contract', () => {

        describe('equivalence cases', () => {
            it('returns a non-empty access_token string', async () => {
                const { service } = buildService();

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                expect(typeof result.access_token).toBe('string');
                expect(result.access_token.length).toBeGreaterThan(0);
            });

            it('returns a non-empty refresh_token string', async () => {
                const { service } = buildService();

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                expect(typeof result.refresh_token).toBe('string');
                expect(result.refresh_token.length).toBeGreaterThan(0);
            });

            it('embeds the user_id inside the access token', async () => {
                const { service } = buildService();

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                const payload = decodeToken(result.access_token);
                expect(payload.user_id).toBe(USER_ID);
            });

            it('embeds the user_email inside the access token', async () => {
                const { service } = buildService();

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                const payload = decodeToken(result.access_token);
                expect(payload.user_email).toBe(EMAIL);
            });

            it('access_token is a verifiable signed JWT', async () => {
                const { service } = buildService();

                const result = await service.registerUser(USER_NAME, EMAIL, PASSWORD);

                expect(() =>
                    jwt.verify(result.access_token, process.env.SIGNING_SECRET!)
                ).not.toThrow();
            });
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — login
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthService.login — behavior', () => {

    beforeEach(() => {
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        vi.clearAllMocks();
        // Re-apply the default so tests that override it don't bleed into siblings.
        mockCompare.mockResolvedValue(true);
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('equivalence cases — valid input', () => {
            it('succeeds for a valid user_name and password', async () => {
                const { service } = buildService({ existingUser: makeUser() });

                const result = await service.login(USER_NAME, PASSWORD);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });
        });

        describe('exception cases — missing user_name', () => {
            it('throws ResourceNotFoundError when user_name is an empty string', async () => {
                const { service } = buildService();

                await expect(service.login('', PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when user_name is null', async () => {
                const { service } = buildService();

                await expect(service.login(null as any, PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing password', () => {
            it('throws ResourceNotFoundError when password is an empty string', async () => {
                const { service } = buildService();

                await expect(service.login(USER_NAME, ''))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when password is null', async () => {
                const { service } = buildService();

                await expect(service.login(USER_NAME, null as any))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. User existence and password check
    // =========================================================================

    describe('user existence and password check', () => {

        describe('equivalence cases', () => {
            it('throws ResourceNotFoundError when no user exists with the given user_name', async () => {
                const { service } = buildService({ existingUser: null });

                await expect(service.login(USER_NAME, PASSWORD))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ForbiddenError when the password does not match the stored hash', async () => {
                mockCompare.mockResolvedValueOnce(false);
                const { service } = buildService({ existingUser: makeUser() });

                await expect(service.login(USER_NAME, PASSWORD))
                    .rejects.toBeInstanceOf(ForbiddenError);
            });
        });
    });

    // =========================================================================
    // 3. Already validated — existing active session
    // =========================================================================

    describe('already validated — existing active session', () => {

        describe('equivalence cases', () => {
            it('returns correct object when a non-expired refresh token exists', async () => {
                const { service } = buildService({
                    existingUser: makeUser(),
                    existingToken: makeRefreshToken(),   // valid, non-expired
                });

                const result = await service.login(USER_NAME, PASSWORD);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });

            it('does not issue new tokens when a valid session is already active', async () => {
                const { service, prismaMock } = buildService({
                    existingUser: makeUser(),
                    existingToken: makeRefreshToken(),
                });

                await service.login(USER_NAME, PASSWORD);

                expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
            });

            it('issues new tokens when the only existing refresh token is expired', async () => {
                const { service } = buildService({
                    existingUser: makeUser(),
                    existingToken: makeExpiredRefreshToken(),
                });

                const result = await service.login(USER_NAME, PASSWORD);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });

            it('issues new tokens when no existing refresh token is found', async () => {
                const { service } = buildService({
                    existingUser: makeUser(),
                    existingToken: null,
                });

                const result = await service.login(USER_NAME, PASSWORD);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });
        });
    });

    // =========================================================================
    // 4. Return value contract
    // =========================================================================

    describe('return value contract', () => {

        describe('equivalence cases', () => {
            it('returns a non-empty access_token string on success', async () => {
                const { service } = buildService({ existingUser: makeUser() });

                const result = await service.login(USER_NAME, PASSWORD);

                expect(typeof result.access_token).toBe('string');
                expect(result.access_token.length).toBeGreaterThan(0);
            });

            it('returns a non-empty refresh_token string on success', async () => {
                const { service } = buildService({ existingUser: makeUser() });

                const result = await service.login(USER_NAME, PASSWORD);

                expect(typeof result.refresh_token).toBe('string');
                expect(result.refresh_token.length).toBeGreaterThan(0);
            });

            it('embeds the user_id inside the access token', async () => {
                const { service } = buildService({ existingUser: makeUser() });

                const result = await service.login(USER_NAME, PASSWORD);

                const payload = decodeToken(result.access_token);
                expect(payload.user_id).toBe(USER_ID);
            });

            it('embeds the user_email inside the access token', async () => {
                const { service } = buildService({ existingUser: makeUser() });

                const result = await service.login(USER_NAME, PASSWORD);

                const payload = decodeToken(result.access_token);
                expect(payload.user_email).toBe(EMAIL);
            });
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — logout
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthService.logout — behavior', () => {

    beforeEach(() => {
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('exception cases — missing refresh_token', () => {
            it('throws ResourceNotFoundError when refresh_token is an empty string', async () => {
                const { service } = buildService();

                await expect(service.logout('')).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when refresh_token is null', async () => {
                const { service } = buildService();

                await expect(service.logout(null as any)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when refresh_token is undefined', async () => {
                const { service } = buildService();

                await expect(service.logout(undefined as any)).rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. Token state
    // =========================================================================

    describe('token state', () => {

        describe('equivalence cases', () => {
            it('completes without throwing when the token is valid and non-expired', async () => {
                const { service } = buildService({ existingToken: makeRefreshToken() });

                await expect(service.logout(REFRESH_TOKEN)).resolves.toBeUndefined();
            });

            it('throws when the token does not exist in the database', async () => {
                const { service } = buildService({ existingToken: null });

                await expect(service.logout(REFRESH_TOKEN)).rejects.toThrow();
            });
        });

        describe('boundary cases', () => {
            it('throws ForbiddenError when the token is expired', async () => {
                const { service } = buildService({ existingToken: makeExpiredRefreshToken() });

                await expect(service.logout(REFRESH_TOKEN)).rejects.toBeInstanceOf(ForbiddenError);
            });
        });
    });

    // =========================================================================
    // 3. Successful deletion
    // =========================================================================

    describe('successful deletion', () => {

        describe('equivalence cases', () => {
            it('deletes the refresh token record from the database', async () => {
                const { service, prismaMock } = buildService({ existingToken: makeRefreshToken() });

                await service.logout(REFRESH_TOKEN);

                expect(prismaMock.refreshToken.delete).toHaveBeenCalledTimes(1);
            });
        });
    });

    // =========================================================================
    // 4. Error propagation
    // =========================================================================

    describe('error propagation', () => {

        describe('exception cases', () => {
            it('propagates unexpected errors thrown while deleting the token', async () => {
                const { service } = buildService({
                    existingToken: makeRefreshToken(),
                    tokenDeleteError: new Error('DB delete timeout'),
                });

                await expect(service.logout(REFRESH_TOKEN)).rejects.toThrow('DB delete timeout');
            });
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — refresh
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthService.refresh — behavior', () => {

    beforeEach(() => {
        process.env.SIGNING_SECRET = 'test-secret-for-unit-tests';
        vi.clearAllMocks();
    });

    // =========================================================================
    // 1. Input validation
    // =========================================================================

    describe('input validation', () => {

        describe('exception cases — missing jwt_token', () => {
            it('throws ResourceNotFoundError when jwt_token is an empty string', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                await expect(service.refresh('', REFRESH_TOKEN))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when jwt_token is null', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                await expect(service.refresh(null as any, REFRESH_TOKEN))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });

        describe('exception cases — missing refresh_token', () => {
            it('throws ResourceNotFoundError when refresh_token is an empty string', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                await expect(service.refresh(makeValidJwt(), ''))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });

            it('throws ResourceNotFoundError when refresh_token is null', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                await expect(service.refresh(makeValidJwt(), null as any))
                    .rejects.toBeInstanceOf(ResourceNotFoundError);
            });
        });
    });

    // =========================================================================
    // 2. Refresh token state
    // =========================================================================

    describe('refresh token state', () => {

        describe('equivalence cases', () => {
            it('succeeds when the refresh token exists and is not expired', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                const result = await service.refresh(makeValidJwt(), REFRESH_TOKEN);

                expect(result).toMatchObject(EXPECTED_AUTH_RETURN_OBJECT);
            });

            it('throws when the refresh token does not exist in the database', async () => {
                const { service } = buildService({ existingToken: null });

                await expect(service.refresh(makeValidJwt(), REFRESH_TOKEN)).rejects.toThrow();
            });
        });

        describe('boundary cases', () => {
            it('throws when the refresh token is expired', async () => {
                const { service } = buildService({ existingToken: makeExpiredRefreshToken() });

                await expect(service.refresh(makeValidJwt(), REFRESH_TOKEN))
                    .rejects.toThrow();
            });
        });
    });

    // =========================================================================
    // 3. Return value contract
    // =========================================================================

    describe('return value contract', () => {

        describe('equivalence cases', () => {
            it('returns a non-empty access_token string on success', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                const result = await service.refresh(makeValidJwt(), REFRESH_TOKEN);

                expect(typeof result.access_token).toBe('string');
                expect(result.access_token.length).toBeGreaterThan(0);
            });

            it('returns a non-empty refresh_token string on success', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                const result = await service.refresh(makeValidJwt(), REFRESH_TOKEN);

                expect(typeof result.refresh_token).toBe('string');
                expect(result.refresh_token.length).toBeGreaterThan(0);
            });

            it('new access token carries the same user_id as the original JWT', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                const result = await service.refresh(makeValidJwt(USER_ID, EMAIL), REFRESH_TOKEN);

                const payload = decodeToken(result.access_token);
                expect(payload.user_id).toBe(USER_ID);
            });

            it('new access token carries the same user_email as the original JWT', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                const result = await service.refresh(makeValidJwt(USER_ID, EMAIL), REFRESH_TOKEN);

                const payload = decodeToken(result.access_token);
                expect(payload.user_email).toBe(EMAIL);
            });

            it('the returned refresh_token differs from the consumed one (token rotation)', async () => {
                const { service } = buildService({ existingToken: makeRefreshTokenWithUser() });

                const result = await service.refresh(makeValidJwt(), REFRESH_TOKEN);

                // A new token must be issued; returning the same value would defeat rotation.
                expect(result.refresh_token).not.toBe(REFRESH_TOKEN);
            });
        });
    });

    // =========================================================================
    // 4. Token lifecycle — rotation
    // =========================================================================

    describe('token lifecycle — rotation', () => {

        describe('equivalence cases', () => {
            it('deletes the consumed refresh token from the database', async () => {
                const { service, prismaMock } = buildService({ existingToken: makeRefreshTokenWithUser() });

                await service.refresh(makeValidJwt(), REFRESH_TOKEN);

                expect(prismaMock.refreshToken.delete).toHaveBeenCalledTimes(1);
            });

            it('creates a new refresh token in the database', async () => {
                const { service, prismaMock } = buildService({ existingToken: makeRefreshTokenWithUser() });

                await service.refresh(makeValidJwt(), REFRESH_TOKEN);

                expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
            });
        });
    });

    // =========================================================================
    // 5. Error propagation
    // =========================================================================

    describe('error propagation', () => {

        describe('exception cases', () => {
            it('propagates unexpected errors thrown while deleting the old token', async () => {
                const { service } = buildService({
                    existingToken: makeRefreshTokenWithUser(),
                    tokenDeleteError: new Error('DB delete timeout'),
                });

                await expect(service.refresh(makeValidJwt(), REFRESH_TOKEN))
                    .rejects.toThrow('DB delete timeout');
            });
        });
    });
});
