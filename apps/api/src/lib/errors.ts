import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Prisma } from '../db/client.js';

export class ApiError extends Error {
    constructor(
        readonly status: ContentfulStatusCode,
        readonly code: string,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }

    toJSON() {
        return {
            error: {
                code: this.code,
                message: this.message,
                ...(this.details === undefined ? {} : { details: this.details }),
            },
        };
    }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);

export const unauthorized = (message = 'Missing or invalid bearer token') =>
    new ApiError(401, 'unauthorized', message);

export const forbidden = (message: string) => new ApiError(403, 'forbidden', message);

export const tooLarge = (message = 'Body too large') =>
    new ApiError(413, 'payload_too_large', message);

export const rateLimited = (message: string) => new ApiError(429, 'rate_limited', message);

export const badRequest = (message: string, details?: unknown) =>
    new ApiError(400, 'invalid_request', message, details);

export const conflict = (message: string, details?: unknown) =>
    new ApiError(409, 'conflict', message, details);

/** An integration the request needs is not connected or not configured. */
export const unavailable = (message: string) =>
    new ApiError(424, 'integration_unavailable', message);

/** An upstream service (Canvas, Resend) answered with an error. */
export const upstream = (service: string, status: number, body: string) =>
    new ApiError(502, 'upstream_error', `${service} responded ${status}`, {
        body: body.slice(0, 2000),
    });

/** An upstream service could not be reached, or did not answer in time. */
export const unreachable = (service: string, err: unknown) =>
    new ApiError(502, 'upstream_error', `${service} did not respond`, {
        reason: err instanceof Error ? err.message : String(err),
    });

export function invalid(error: {
    issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): ApiError {
    return badRequest(
        'Request validation failed',
        error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
}

const isPrismaError = (err: unknown, code: string) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;

/**
 * The API error for a Prisma error that a request can legitimately cause (a row deleted meanwhile,
 * a unique or foreign key race), or undefined for anything else.
 */
export function fromPrisma(err: unknown): ApiError | undefined {
    if (isPrismaError(err, 'P2025')) return notFound('Record');
    if (isPrismaError(err, 'P2002')) {
        return conflict('A record with the same unique value already exists');
    }
    if (isPrismaError(err, 'P2003')) {
        return conflict('The change refers to a missing record, or to one still in use');
    }
    return undefined;
}

/** For `.catch`: a unique-constraint race becomes a 409 with `message`; anything else rethrows. */
export const onDuplicate =
    (message: string) =>
    (err: unknown): never => {
        throw isPrismaError(err, 'P2002') ? conflict(message) : err;
    };
