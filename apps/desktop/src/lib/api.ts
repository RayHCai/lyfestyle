/**
 * Thin client for the Lyfestyle API (apps/api), covering the routes the desktop app uses.
 * Shapes follow docs/api.md. Kept dependency-free so the app type-checks on its own toolchain.
 */

export interface ApiConfig {
    baseUrl: string;
    token: string;
}

export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface ApiRun {
    id: string;
    kind: 'chat' | 'job';
    status: RunStatus;
    prompt: string;
    conversationId: string | null;
    jobId: string | null;
    output: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}
export interface ApiMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: ContentBlock[];
    runId: string | null;
    createdAt: string;
}
export interface ApiConversation {
    id: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface ApiConversationFull extends ApiConversation {
    messages: ApiMessage[];
    activeRuns: ApiRun[];
}
export interface ApiPageSummary {
    id: string;
    title: string;
    icon: string | null;
    excerpt: string;
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface ApiPage extends ApiPageSummary {
    content: string;
    deletedAt: string | null;
}
export interface ApiJobRun {
    id: string;
    status: RunStatus;
    createdAt: string;
    finishedAt: string | null;
}
export interface ApiJob {
    id: string;
    name: string;
    prompt: string;
    schedule: string;
    timezone: string;
    enabled: boolean;
    nextRunAt: string | null;
    lastRunAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastRun?: ApiJobRun | null;
    recentRuns?: ApiRun[];
}
export interface JobInput {
    name: string;
    prompt: string;
    schedule: string;
    timezone?: string;
    enabled?: boolean;
}

export type RunEvent = (
    | { type: 'message'; role: 'assistant' | 'tool'; content: ContentBlock[] }
    | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }
    | { type: 'session'; harness: string; sessionId: string }
    | { type: 'usage'; model: string; costUsd: number }
    | { type: 'status'; status: RunStatus; error?: string }
) & { id: number; runId: string; createdAt: string };

interface Paged<T> {
    items: T[];
    nextCursor: string | null;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

async function errorFrom(res: Response): Promise<ApiError> {
    const text = await res.text().catch(() => '');
    try {
        const { error } = JSON.parse(text) as { error: { code: string; message: string } };
        return new ApiError(res.status, error.code, error.message);
    } catch {
        return new ApiError(
            res.status,
            'http_error',
            text || res.statusText || `HTTP ${res.status}`,
        );
    }
}

/** One readable sentence for any failure, for the UI. */
export function describeError(e: unknown): string {
    if (e instanceof ApiError) return e.status === 401 ? 'The API rejected the token.' : e.message;
    if (e instanceof Error) return e.message;
    return String(e);
}

/** Splits an SSE byte stream into `{ event, data }` frames. */
async function* frames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
                const lines = buffer.slice(0, end).split('\n');
                buffer = buffer.slice(end + 2);
                const field = (name: string) =>
                    lines
                        .filter((l) => l.startsWith(name + ':'))
                        .map((l) => l.slice(name.length + 1).replace(/^ /, ''));
                yield { event: field('event')[0] ?? 'message', data: field('data').join('\n') };
            }
        }
    } finally {
        reader.releaseLock();
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Api {
    readonly baseUrl: string;
    private readonly token: string;

    constructor(cfg: ApiConfig) {
        this.baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
        this.token = cfg.token.trim();
    }

    private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
        let res: Response;
        try {
            res = await fetch(this.baseUrl + path, {
                method,
                headers: {
                    authorization: `Bearer ${this.token}`,
                    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch {
            throw new ApiError(0, 'unreachable', `Cannot reach the API at ${this.baseUrl}`);
        }
        if (!res.ok) throw await errorFrom(res);
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
    }

    /** Every item of a paged list, up to `max`. */
    private async all<T>(path: string, max = 1000): Promise<T[]> {
        const out: T[] = [];
        let cursor: string | null = null;
        do {
            const sep = path.includes('?') ? '&' : '?';
            const page: Paged<T> = await this.req(
                'GET',
                `${path}${sep}limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
            );
            out.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor && out.length < max);
        return out;
    }

    /** Validates the URL and token with the cheapest authenticated call. */
    check() {
        return this.req<Paged<ApiConversation>>('GET', '/conversations?limit=1');
    }

    listConversations() {
        return this.all<ApiConversation>('/conversations', 400);
    }
    getConversation(id: string) {
        return this.req<ApiConversationFull>('GET', `/conversations/${id}`);
    }
    createConversation(title?: string) {
        return this.req<ApiConversation>('POST', '/conversations', title ? { title } : {});
    }
    deleteConversation(id: string) {
        return this.req<ApiConversation>('DELETE', `/conversations/${id}`);
    }
    sendMessage(id: string, text: string) {
        return this.req<{ message: ApiMessage; run: ApiRun }>(
            'POST',
            `/conversations/${id}/messages`,
            { text },
        );
    }

    getRun(id: string) {
        return this.req<ApiRun>('GET', `/runs/${id}`);
    }
    /** The newest runs of a conversation (one page). */
    async listRuns(conversationId: string) {
        return (
            await this.req<Paged<ApiRun>>('GET', `/runs?conversationId=${conversationId}&limit=100`)
        ).items;
    }
    cancelRun(id: string) {
        return this.req<ApiRun>('POST', `/runs/${id}/cancel`);
    }

    /** Every event of a run as it happens, resuming after a dropped connection. Ends on a terminal status. */
    async *streamRun(runId: string, after = 0, signal?: AbortSignal): AsyncGenerator<RunEvent> {
        let retries = 5;
        for (;;) {
            try {
                const res = await fetch(`${this.baseUrl}/runs/${runId}/stream?after=${after}`, {
                    headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
                    signal,
                });
                if (!res.ok || !res.body) throw await errorFrom(res);
                for await (const frame of frames(res.body)) {
                    if (frame.event === 'ping' || !frame.data) continue;
                    const ev = JSON.parse(frame.data) as RunEvent;
                    after = ev.id;
                    yield ev;
                    if (ev.type === 'status' && TERMINAL.includes(ev.status)) return;
                }
                if (retries-- <= 0) return; // closed cleanly without a terminal status; give up quietly
            } catch (e) {
                if (signal?.aborted || e instanceof ApiError || retries-- <= 0) throw e;
            }
            await sleep(1000);
        }
    }

    listPages() {
        return this.all<ApiPageSummary>('/pages');
    }
    getPage(id: string) {
        return this.req<ApiPage>('GET', `/pages/${id}`);
    }
    createPage(input: { id?: string; title?: string; content?: string }) {
        return this.req<ApiPage>('POST', '/pages', input);
    }
    updatePage(id: string, patch: { title?: string; content?: string }) {
        return this.req<ApiPage>('PATCH', `/pages/${id}`, patch);
    }
    deletePage(id: string) {
        return this.req<ApiPage>('DELETE', `/pages/${id}`);
    }

    async listJobs() {
        return (await this.req<{ items: ApiJob[] }>('GET', '/jobs')).items;
    }
    getJob(id: string) {
        return this.req<ApiJob>('GET', `/jobs/${id}`);
    }
    createJob(input: JobInput) {
        return this.req<ApiJob>('POST', '/jobs', input);
    }
    updateJob(id: string, patch: Partial<JobInput>) {
        return this.req<ApiJob>('PATCH', `/jobs/${id}`, patch);
    }
    deleteJob(id: string) {
        return this.req<ApiJob>('DELETE', `/jobs/${id}`);
    }
    triggerJob(id: string) {
        return this.req<ApiRun>('POST', `/jobs/${id}/trigger`);
    }
}
