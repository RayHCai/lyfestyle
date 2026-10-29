/**
 * Thin client for the Lyfestyle API (apps/api), covering the routes the desktop app uses.
 * Shapes follow docs/api.md; the run-event protocol and its SSE reader come from
 * `@lyfestyle/shared`, so they cannot drift from what the API and runner speak.
 */
import {
    streamRunEvents,
    type ContentBlock,
    type MessageRole,
    type ModelUsageTotals,
    type RunEvent,
    type RunEventInput,
    type RunKind,
    type RunStatus,
} from '@lyfestyle/shared';

export interface ApiConfig {
    baseUrl: string;
    token: string;
}

export interface ApiRun {
    id: string;
    kind: RunKind;
    status: RunStatus;
    prompt: string;
    conversationId: string | null;
    /** The automation run that queued this agent run, if one did. */
    automationRunId: string | null;
    /** The most this run may spend, in USD; the API stops it beyond that. */
    budgetUsd: number;
    output: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}
export interface ApiMessage {
    id: string;
    role: MessageRole;
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
/** What `POST /runs/claim` hands a runner (docs/api.md, Runner protocol). */
export interface ApiClaim {
    run: ApiRun;
    session: { harness: string; sessionId: string; usage: ModelUsageTotals[] } | null;
    history: { role: MessageRole; content: ContentBlock[] }[];
    automation: { id: string; name: string } | null;
    agentToken: string;
}
/** `GET /agent/config`: the built-in tool server's path and every enabled registered server. */
export interface ApiAgentConfig {
    builtinServer: { name: string; path: string };
    mcpServers: (
        | { name: string; transport: 'http' | 'sse'; url: string; headers: Record<string, string> }
        | {
              name: string;
              transport: 'stdio';
              command: string;
              args: string[];
              env: Record<string, string>;
          }
    )[];
}
export interface ApiConversationFull extends ApiConversation {
    messages: ApiMessage[];
    activeRuns: ApiRun[];
}
/** A full page as `/sync` exchanges it. */
export interface ApiSyncPage {
    id: string;
    title: string;
    icon: string | null;
    content: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}
export interface ApiPageChange {
    id: string;
    /** The server version the edit was made on, or null for a page this device created. */
    baseVersion: number | null;
    title: string;
    content: string;
    icon: string | null;
    deleted: boolean;
}
/** `gone`: the page was purged on the server, so a change with a base version cannot apply. */
export type ApiChangeResult =
    | { id: string; status: 'applied' | 'conflict'; page: ApiSyncPage }
    | { id: string; status: 'gone' };
/** `cancelled`: the automation was deleted or paused, or the API shut down, mid-run. Not a failure. */
export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface ApiAutomationRunSummary {
    id: string;
    status: AutomationRunStatus;
    startedAt: string;
    finishedAt: string | null;
}
export interface ApiAutomation {
    id: string;
    name: string;
    description: string;
    /** Cron expression, evaluated in `timezone`. */
    schedule: string;
    timezone: string;
    enabled: boolean;
    /** The deployed version; each approved deploy adds one. */
    version: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastRun?: ApiAutomationRunSummary | null;
}
export interface ApiAutomationRun extends ApiAutomationRunSummary {
    automationId: string;
    version: number;
    trigger: 'schedule' | 'manual';
    error: string | null;
    output: string | null;
    costUsd: number;
}
/** Code proposed for approval. Nothing runs until the user approves it. */
export interface ApiAutomationDeploy {
    id: string;
    /** Null when the deploy creates a new automation. */
    automationId: string | null;
    name: string;
    description: string;
    schedule: string;
    timezone: string;
    code: string;
    status: 'pending' | 'approved' | 'rejected';
    /** Who proposed it: the agent in a chat, an unattended automation run, or the user directly. */
    origin: 'chat' | 'automation' | 'user';
    /** The agent run that proposed it, if one did. */
    runId: string | null;
    createdAt: string;
    decidedAt: string | null;
    /** The deployed version this would replace. */
    current: {
        version: number;
        name: string;
        schedule: string;
        timezone: string;
        code: string;
    } | null;
}
export interface ApiTimeline {
    runs: (ApiAutomationRun & { name: string })[];
    upcoming: { automationId: string; name: string; at: string }[];
}
export interface ApiNotification {
    id: number;
    title: string;
    body: string | null;
    source: string | null;
    createdAt: string;
}
/** A server in the API's MCP registry, as `GET /mcp-servers` shows it: never its secrets. */
export interface ApiMcpServer {
    id: string;
    name: string;
    transport: 'http' | 'sse' | 'stdio';
    /** For display only: the scheme and host, plus "/…" when the URL has a path. Never send it
     *  back as the server's URL. */
    url: string | null;
    command: string | null;
    argCount: number;
    headerNames: string[];
    envNames: string[];
    enabled: boolean;
    /** The API cannot decrypt this server's stored secrets (its key changed). */
    secretsUnavailable?: true;
}

export interface ApiViewTotals {
    views: number;
    /** Distinct visitor IPs. */
    visitors: number;
}
export interface ApiViewSummary {
    groupBy: 'day' | 'origin' | 'path' | 'referrer';
    totals: ApiViewTotals;
    /** Biggest first, except `day` groups, which are oldest first and keyed `YYYY-MM-DD`. */
    groups: (ApiViewTotals & { key: string | null })[];
}

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

/** Codes whose own message would read as jargon in the UI. */
const plain: Record<string, string> = {
    rate_limited: 'The API is getting too many requests. Try again in a minute.',
    payload_too_large: 'That is more than the API accepts in one request.',
};

/** One readable sentence for any failure, for the UI. */
export function describeError(e: unknown): string {
    if (e instanceof ApiError) {
        if (e.status === 401) return 'The API rejected the token.';
        const known = plain[e.code];
        if (known) return known;
        if (e.code === 'conflict') return `Changed elsewhere first: ${e.message}`;
        if (e.code === 'invalid_request') return `The API refused it: ${e.message}`;
        return e.message;
    }
    if (e instanceof Error) return e.message;
    return String(e);
}

export class Api {
    readonly baseUrl: string;
    private readonly token: string;

    constructor(cfg: ApiConfig) {
        this.baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
        this.token = cfg.token.trim();
    }

    private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
        const init: RequestInit = { method, headers };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let res: Response;
        try {
            res = await fetch(this.baseUrl + path, init);
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
    /** With `from`, the message replaces that user message and everything after it. */
    sendMessage(id: string, text: string, from?: string) {
        return this.req<{ message: ApiMessage; run: ApiRun }>(
            'POST',
            `/conversations/${id}/messages`,
            from ? { text, from } : { text },
        );
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

    /** Every event of a run as it happens, from the start. Reconnects after a dropped connection
     *  or a 5xx, throws a 4xx at once (as an `ApiError`) and throws once retries run out; ends
     *  after the run's terminal status. */
    streamRun(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
        return streamRunEvents({
            baseUrl: this.baseUrl,
            token: this.token,
            runId,
            ...(signal ? { signal } : {}),
            toError: errorFrom,
        });
    }

    /** Up to 500 page edits in one request (10 MiB body); each answers `applied`, `conflict`
     *  or `gone`. */
    syncPush(changes: ApiPageChange[]) {
        return this.req<{ results: ApiChangeResult[] }>('POST', '/sync/push', { changes });
    }
    /** Pages written after `cursor`, deletions included, in write order. */
    syncPull(cursor: string, limit: number) {
        return this.req<{ pages: ApiSyncPage[]; cursor: string; hasMore: boolean }>(
            'GET',
            `/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
        );
    }

    async listAutomations() {
        return (await this.req<{ items: ApiAutomation[] }>('GET', '/automations')).items;
    }
    setAutomationEnabled(id: string, enabled: boolean) {
        return this.req<ApiAutomation>('PATCH', `/automations/${id}`, { enabled });
    }
    deleteAutomation(id: string) {
        return this.req<ApiAutomation>('DELETE', `/automations/${id}`);
    }
    triggerAutomation(id: string) {
        return this.req<ApiAutomationRun>('POST', `/automations/${id}/trigger`);
    }
    async listDeploys() {
        return (
            await this.req<{ items: ApiAutomationDeploy[] }>(
                'GET',
                '/automations/deploys?status=pending',
            )
        ).items;
    }
    getDeploy(id: string) {
        return this.req<ApiAutomationDeploy>('GET', `/automations/deploys/${id}`);
    }
    approveDeploy(id: string) {
        return this.req<ApiAutomation>('POST', `/automations/deploys/${id}/approve`);
    }
    rejectDeploy(id: string) {
        return this.req<ApiAutomationDeploy>('POST', `/automations/deploys/${id}/reject`);
    }
    /** Runs that started in [from, to) and the scheduled slots still ahead in it. */
    timeline(from: Date, to: Date) {
        const q = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
        return this.req<ApiTimeline>('GET', `/automations/timeline?${q}`);
    }
    /** Notifications after id `after`, oldest first; with `after` null, the newest `limit`.
     *  `latestId` is the newest id on the server (null when there are none). */
    notifications(after: number | null, limit = 50) {
        const q = after === null ? `limit=${limit}` : `after=${after}&limit=${limit}`;
        return this.req<{ items: ApiNotification[]; latestId: number | null }>(
            'GET',
            `/notifications?${q}`,
        );
    }

    /** Page view totals since `from`, overall and per `groupBy`; days fall in `timezone`. */
    viewSummary(
        groupBy: ApiViewSummary['groupBy'],
        opts: { from: Date; timezone: string; origin?: string },
    ) {
        const q = new URLSearchParams({
            groupBy,
            from: opts.from.toISOString(),
            timezone: opts.timezone,
        });
        if (opts.origin) q.set('origin', opts.origin);
        return this.req<ApiViewSummary>('GET', `/metrics/views/summary?${q}`);
    }

    /** Runner protocol: waits up to `waitMs` for a queued run; null when none came. */
    async claimRun(runnerId: string, harness: string, waitMs: number) {
        return (
            (await this.req<ApiClaim | undefined>('POST', '/runs/claim', {
                runnerId,
                harness,
                waitMs,
            })) ?? null
        );
    }
    agentConfig() {
        return this.req<ApiAgentConfig>('GET', '/agent/config');
    }
    postRunEvents(id: string, events: RunEventInput[]) {
        return this.req<{ cancelRequested: boolean }>('POST', `/runs/${id}/events`, { events });
    }
    heartbeatRun(id: string) {
        return this.req<{ status: RunStatus; cancelRequested: boolean }>(
            'POST',
            `/runs/${id}/heartbeat`,
        );
    }
    completeRun(
        id: string,
        result: {
            status: 'succeeded' | 'failed' | 'cancelled';
            output?: string;
            error?: string;
        },
    ) {
        return this.req<unknown>('POST', `/runs/${id}/complete`, result);
    }

    async listMcpServers() {
        return (await this.req<{ items: ApiMcpServer[] }>('GET', '/mcp-servers')).items;
    }
    createMcpServer(input: {
        name: string;
        transport: ApiMcpServer['transport'];
        url: string;
        enabled: boolean;
    }) {
        return this.req<ApiMcpServer>('POST', '/mcp-servers', input);
    }
    /** `url` replaces the stored one, so send it only when the user typed a new one: the listed
     *  `url` is a redacted display form. */
    updateMcpServer(id: string, patch: { url?: string; enabled?: boolean }) {
        return this.req<ApiMcpServer>('PATCH', `/mcp-servers/${id}`, patch);
    }
}
