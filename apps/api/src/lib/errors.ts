import type { ContentfulStatusCode } from 'hono/utils/http-status';

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

export function invalid(error: {
    issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): ApiError {
    return badRequest(
        'Request validation failed',
        error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
}
