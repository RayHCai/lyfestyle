import type { RouteGroups } from '@lyfestyle/api';
import { hc, type ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';

export interface ClientOptions {
    /** The API's origin, e.g. `https://lyfestyle.up.railway.app`. */
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
}

type At<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;

/** One typed client per top-level path: typing the whole app at once is too deep for tsc. */
export type ApiClient = {
    [K in keyof RouteGroups]: At<ReturnType<typeof hc<RouteGroups[K]>>, K>;
};

const GROUPS = {
    pages: true,
    sync: true,
    todos: true,
    goals: true,
    conversations: true,
    runs: true,
    jobs: true,
    usage: true,
    metrics: true,
    integrations: true,
    'mcp-servers': true,
    agent: true,
    tools: true,
    mcp: true,
} satisfies Record<keyof RouteGroups, true>;

/** A typed client for every API route: `api.pages.$get(...)`, `api.runs[':id'].$get(...)`. */
export function createApiClient(options: ClientOptions): ApiClient {
    const root = hc(options.baseUrl.replace(/\/+$/, ''), {
        headers: { authorization: `Bearer ${options.token}` },
        ...(options.fetch ? { fetch: options.fetch } : {}),
    }) as unknown as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(GROUPS).map((group) => [group, root[group]]),
    ) as ApiClient;
}

/** The API's error body, `{ error: { code, message, details? } }`, as a thrown error. */
export class ApiRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'ApiRequestError';
    }

    static async from(response: Response): Promise<ApiRequestError> {
        const text = await response.text().catch(() => '');
        try {
            const { error } = JSON.parse(text) as {
                error: { code: string; message: string; details?: unknown };
            };
            return new ApiRequestError(response.status, error.code, error.message, error.details);
        } catch {
            return new ApiRequestError(response.status, 'http_error', text || response.statusText);
        }
    }
}

type Success<R> =
    R extends ClientResponse<infer T, infer S, 'json'>
        ? S extends SuccessStatusCode
            ? T
            : never
        : never;

/** Awaits a client call and returns its JSON body, throwing `ApiRequestError` on a non-2xx. */
export async function unwrap<R extends ClientResponse<unknown, number, string>>(
    pending: Promise<R>,
): Promise<Success<R>> {
    const response = await pending;
    if (!response.ok) throw await ApiRequestError.from(response);
    return (await response.json()) as Success<R>;
}
