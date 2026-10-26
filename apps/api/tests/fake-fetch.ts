type Handler = (request: Request, url: URL) => Response | Promise<Response>;

/** An outbound `fetch` that answers from registered routes and records every call. */
export function fakeFetch() {
    const routes: { method: string; prefix: string; handler: Handler }[] = [];
    const calls: { method: string; url: string; body: string | null; headers: Headers }[] = [];

    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.body ? await request.clone().text() : null;
        calls.push({ method: request.method, url: request.url, body, headers: request.headers });
        const url = new URL(request.url);
        const route = routes.find(
            (r) =>
                r.method === request.method && `${url.origin}${url.pathname}`.startsWith(r.prefix),
        );
        if (!route)
            return new Response(`No fake for ${request.method} ${request.url}`, { status: 599 });
        return route.handler(request, url);
    }) as typeof globalThis.fetch;

    return {
        fetch,
        calls,
        on(method: string, prefix: string, handler: Handler) {
            routes.unshift({ method, prefix, handler });
        },
        json: (body: unknown, init?: ResponseInit) =>
            new Response(JSON.stringify(body), {
                ...init,
                headers: { 'content-type': 'application/json', ...init?.headers },
            }),
    };
}
