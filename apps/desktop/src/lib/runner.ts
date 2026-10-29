/**
 * API mode's in-app runner. Chat turns become runs on the API, and something on the user's
 * machine has to claim them; without `apps/runner` running they would wait forever. So while the
 * app is in API mode it speaks the runner protocol itself (docs/api.md, Runner protocol): it
 * long-polls `POST /runs/claim`, runs each run through the selected local harness via
 * `agent_send` (keyed by run id instead of conversation id), and reports events back. The
 * conversation view follows the run over SSE as it would any runner's.
 */
import { useSyncExternalStore } from 'react';
import {
    runEventInput,
    type ContentBlock,
    type ModelUsageTotals,
    type RunEventInput,
} from '@lyfestyle/shared';
import { ApiError, describeError, type Api, type ApiAgentConfig, type ApiClaim } from './api';
import { activeHarness, fromCodex, harnessCommand } from './harness';
import { call, isTauri } from './tauri';
import { useData } from '../store/data';

const RUNNER_ID = 'desktop';
const MAX_RUNS = 3;
const CLAIM_WAIT_MS = 25_000;
const HEARTBEAT_MS = 60_000;
const BATCH = 200;
/** The runner's own clip, so a huge tool result cannot fail a batch. */
const MAX_RESULT = 10_000;
const MISSING_SESSION = /No conversation found/i;

type Line = Record<string, unknown>;
const isRecord = (v: unknown): v is Line =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const count = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v) : 0);

/** What a harness session spent, minus the totals it had before this run (Claude Code's resumed
 *  figures are cumulative). Figures below the baseline mean they were this run's alone. */
function usageDelta(
    u: Omit<ModelUsageTotals, 'model'>,
    base: ModelUsageTotals | undefined,
): Omit<ModelUsageTotals, 'model'> {
    if (!base) return u;
    const keys = [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'costUsd',
    ] as const;
    if (keys.some((k) => u[k] < base[k])) return u;
    return Object.fromEntries(keys.map((k) => [k, u[k] - base[k]])) as typeof u;
}

function assistantBlocks(content: unknown[]): ContentBlock[] {
    return content.filter(isRecord).flatMap((b): ContentBlock[] => {
        if (b.type === 'text' && str(b.text)) return [{ type: 'text', text: b.text as string }];
        if (b.type === 'thinking' && str(b.thinking))
            return [{ type: 'thinking', text: b.thinking as string }];
        if (b.type === 'tool_use' && str(b.id) && str(b.name))
            return [
                { type: 'tool_use', id: b.id as string, name: b.name as string, input: b.input },
            ];
        return [];
    });
}

function resultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content))
        return content
            .filter(isRecord)
            .map((c) => (typeof c.text === 'string' ? c.text : ''))
            .join('\n');
    return content === undefined ? '' : JSON.stringify(content);
}

/** Run events for one Claude Code stream-json line (Codex lines are translated first). Every
 *  event is checked against the protocol, so a malformed one is dropped, not the whole batch. */
export function toRunEvents(
    line: Line,
    harness: string,
    baseline: ModelUsageTotals[] = [],
): RunEventInput[] {
    const events: unknown[] = [];
    if (line.type === 'system' && line.subtype === 'init' && str(line.session_id)) {
        events.push({ type: 'session', harness, sessionId: line.session_id });
        events.push({
            type: 'log',
            level: 'info',
            message: `Desktop ${harness} using ${str(line.model) ?? 'its default model'}`,
        });
    } else if (line.type === 'assistant' && !line.parent_tool_use_id) {
        const body = isRecord(line.message) ? line.message.content : undefined;
        const content =
            typeof body === 'string'
                ? body
                    ? [{ type: 'text', text: body }]
                    : []
                : Array.isArray(body)
                  ? assistantBlocks(body)
                  : [];
        if (content.length) events.push({ type: 'message', role: 'assistant', content });
    } else if (line.type === 'user' && !line.parent_tool_use_id) {
        const body = isRecord(line.message) ? line.message.content : undefined;
        const results = (Array.isArray(body) ? body : [])
            .filter(isRecord)
            .filter((b) => b.type === 'tool_result')
            .map((b) => ({
                type: 'tool_result',
                toolUseId: String(b.tool_use_id),
                content: resultText(b.content).slice(0, MAX_RESULT),
                ...(b.is_error ? { isError: true } : {}),
            }));
        if (results.length) events.push({ type: 'message', role: 'tool', content: results });
    } else if (line.type === 'result') {
        const sessionId = str(line.session_id);
        const models = isRecord(line.modelUsage) ? Object.entries(line.modelUsage) : [];
        models.forEach(([model, u], index) => {
            if (!model || !isRecord(u)) return;
            events.push({
                type: 'usage',
                model,
                ...usageDelta(
                    {
                        inputTokens: count(u.inputTokens),
                        outputTokens: count(u.outputTokens),
                        cacheReadTokens: count(u.cacheReadInputTokens),
                        cacheWriteTokens: count(u.cacheCreationInputTokens),
                        costUsd: typeof u.costUSD === 'number' && u.costUSD > 0 ? u.costUSD : 0,
                    },
                    baseline.find((b) => b.model === model),
                ),
                ...(sessionId ? { sessionId } : {}),
                ...(index === 0 ? { durationMs: count(line.duration_ms) } : {}),
            });
        });
        const failed = line.subtype !== 'success' || line.is_error === true;
        events.push({
            type: 'log',
            level: failed ? 'error' : 'info',
            message: failed ? `Run ended with ${String(line.subtype)}` : 'Finished',
        });
    }
    return events.flatMap((e) => {
        const parsed = runEventInput.safeParse(e);
        return parsed.success ? [parsed.data] : [];
    });
}

/** Earlier turns as plain text, for a fresh session mid-conversation (as the runner does). */
export function claimPrompt(claim: ApiClaim, resumed: boolean): string {
    if (resumed) return claim.run.prompt;
    const earlier = claim.history
        .flatMap(({ role, content }) =>
            content.flatMap((b) => {
                if (b.type === 'text')
                    return [`${role === 'user' ? 'User' : 'Assistant'}: ${b.text}`];
                if (b.type === 'tool_use') return [`Assistant used tool ${b.name}`];
                return [];
            }),
        )
        .join('\n\n');
    return earlier
        ? `<conversation_so_far>\n${earlier}\n</conversation_so_far>\n\n${claim.run.prompt}`
        : claim.run.prompt;
}

/** The run's MCP servers in `--mcp-config` shape: the API's own with the run's agent token
 *  first, then every server registered on the API. */
export function runMcpServers(config: ApiAgentConfig, apiUrl: string, agentToken: string) {
    const servers: Record<string, unknown> = {
        [config.builtinServer.name]: {
            type: 'http',
            url: apiUrl.replace(/\/+$/, '') + config.builtinServer.path,
            headers: { Authorization: `Bearer ${agentToken}` },
        },
    };
    for (const s of config.mcpServers)
        servers[s.name] =
            s.transport === 'stdio'
                ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
                : { type: s.transport, url: s.url, headers: s.headers };
    return servers;
}

// --- status, for Settings ---

export interface RunnerStatus {
    state: 'off' | 'waiting' | 'running' | 'error';
    runs: number;
    error: string | null;
}
let status: RunnerStatus = { state: 'off', runs: 0, error: null };
const listeners = new Set<() => void>();
function setStatus(patch: Partial<RunnerStatus>) {
    status = { ...status, ...patch };
    status.state = status.error ? 'error' : status.runs ? 'running' : status.state;
    for (const l of listeners) l();
}
export const useRunnerStatus = () =>
    useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => status,
    );

// --- the claim loop ---

interface Active {
    client: Api;
    claim: ApiClaim;
    harness: string;
    /** `desktop-<harness>`, recorded with the session so only this harness resumes it. */
    name: string;
    model: string;
    resumed: boolean;
    started: boolean;
    retried: boolean;
    missingSession: boolean;
    cancelled: boolean;
    output: string;
    error: string;
    queue: RunEventInput[];
    flushing: Promise<void>;
    flushTimer: ReturnType<typeof setTimeout> | null;
    heartbeat: ReturnType<typeof setInterval>;
}

const active = new Map<string, Active>();
let generation = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether an `agent-event` with this id belongs to a run rather than a local conversation. */
export const ownsRun = (id: string) => active.has(id);

/** Starts claiming runs for `client`. Returns a stop function; runs in flight finish. */
export function startRunner(client: Api): () => void {
    if (!isTauri || useData.getState().env.harness) return () => {};
    const gen = ++generation;
    // Another start (or the stop function) moves `generation` on, which ends this loop.
    const live = () => gen === generation;
    setStatus({ state: 'waiting', error: null, runs: active.size });
    void (async () => {
        while (live()) {
            if (active.size >= MAX_RUNS) {
                await sleep(1000);
                continue;
            }
            const harness = activeHarness(useData.getState().settings);
            try {
                const claim = await client.claimRun(RUNNER_ID, `desktop-${harness}`, CLAIM_WAIT_MS);
                if (!live()) {
                    // Claimed as the loop was stopped: hand it back rather than strand it.
                    if (claim) void client.completeRun(claim.run.id, failed('The app stopped'));
                    return;
                }
                if (status.error) setStatus({ error: null, state: 'waiting' });
                if (claim) void execute(client, claim);
            } catch (e) {
                if (!live()) return;
                setStatus({ error: describeError(e) });
                await sleep(10_000);
            }
        }
    })();
    return () => {
        if (gen === generation) generation++;
        setStatus({ state: 'off', error: null });
    };
}

const failed = (error: string) => ({ status: 'failed' as const, error });

async function execute(client: Api, claim: ApiClaim, fresh = false) {
    const { settings } = useData.getState();
    const harness = activeHarness(settings);
    const name = `desktop-${harness}`;
    const resumed = !fresh && claim.session?.harness === name;
    const run: Active = {
        client,
        claim,
        harness,
        name,
        model: settings.model || harness,
        resumed,
        started: false,
        retried: fresh,
        missingSession: false,
        cancelled: false,
        output: '',
        error: '',
        queue: [],
        flushing: Promise.resolve(),
        flushTimer: null,
        heartbeat: setInterval(() => void beat(claim.run.id), HEARTBEAT_MS),
    };
    active.set(claim.run.id, run);
    setStatus({ runs: active.size });
    try {
        const config = await client.agentConfig();
        await call('agent_send', {
            args: {
                conversation_id: claim.run.id,
                prompt: claimPrompt(claim, resumed),
                session_id: resumed ? (claim.session?.sessionId ?? null) : null,
                harness,
                command: harnessCommand(harness, settings, useData.getState().env) || null,
                model: settings.model,
                effort: settings.effort,
                todo_mcp_url: null,
                cwd: settings.workingDirectory || useData.getState().dataDir,
                mcp_servers: runMcpServers(config, client.baseUrl, claim.agentToken),
                max_budget_usd: claim.run.budgetUsd,
            },
        });
    } catch (e) {
        run.error = describeError(e);
        await finish(claim.run.id, -1);
    }
}

function push(id: string, events: RunEventInput[]) {
    const run = active.get(id);
    if (!run || !events.length) return;
    run.queue.push(...events);
    run.flushTimer ??= setTimeout(() => {
        run.flushTimer = null;
        void flush(id, run);
    }, 300);
}

/** Posts queued events in order, one request at a time. */
function flush(id: string, run: Active): Promise<void> {
    run.flushing = run.flushing.then(async () => {
        while (run.queue.length) {
            const batch = run.queue.splice(0, BATCH);
            try {
                const res = await run.client.postRunEvents(id, batch);
                if (res.cancelRequested) void stop(id, run);
            } catch (e) {
                // Deleted with its conversation: nothing will read the rest.
                if (e instanceof ApiError && e.status === 404) {
                    run.queue = [];
                    void stop(id, run);
                    return;
                }
                console.warn('run events not posted:', e);
            }
        }
    });
    return run.flushing;
}

async function beat(id: string) {
    const run = active.get(id);
    if (!run) return;
    try {
        const res = await run.client.heartbeatRun(id);
        if (res.cancelRequested) void stop(id, run);
    } catch (e) {
        if (e instanceof ApiError && e.status === 404) void stop(id, run);
    }
}

async function stop(id: string, run: Active) {
    if (run.cancelled) return;
    run.cancelled = true;
    try {
        await call('agent_cancel', { conversationId: id });
    } catch (e) {
        console.warn('could not stop run', id, e);
    }
}

/** One `agent-event` for a run this runner holds. */
export function handleRunEvent(p: { conversation_id: string; kind: string; line: string }) {
    const id = p.conversation_id;
    const run = active.get(id);
    if (!run) return;
    if (p.kind === 'exit') {
        void finish(id, Number(p.line));
        return;
    }
    if (p.kind === 'stderr') {
        if (MISSING_SESSION.test(p.line)) run.missingSession = true;
        push(id, [{ type: 'log', level: 'warn', message: p.line.slice(0, 2000) }]);
        return;
    }
    const text = p.line.trim();
    if (!text) return;
    let obj: unknown;
    try {
        obj = JSON.parse(text);
    } catch {
        push(id, [{ type: 'log', level: 'info', message: text.slice(0, 2000) }]);
        return;
    }
    if (!isRecord(obj)) return;
    for (const line of fromCodex(obj, run.model) ?? [obj]) {
        if (line.type === 'system') run.started = true;
        if (line.type === 'assistant') {
            const blocks = isRecord(line.message) ? line.message.content : undefined;
            const said = (Array.isArray(blocks) ? blocks : [])
                .filter(isRecord)
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join('');
            if (said) run.output = said;
        }
        if (line.type === 'result') {
            const failedRun = line.subtype !== 'success' || line.is_error === true;
            const result = typeof line.result === 'string' ? line.result : '';
            if (failedRun) {
                run.error = result || String(line.subtype);
                if (MISSING_SESSION.test(run.error)) run.missingSession = true;
            } else if (result) run.output = result;
        }
        const baseline = run.resumed ? (run.claim.session?.usage ?? []) : [];
        push(id, toRunEvents(line, run.name, baseline));
    }
}

async function finish(id: string, code: number) {
    const run = active.get(id);
    if (!run) return;
    clearInterval(run.heartbeat);
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = null;
    await flush(id, run);
    active.delete(id);
    setStatus({ runs: active.size });
    // Claude Code lost the session (cleared history): try once more from the transcript.
    if (run.resumed && !run.started && run.missingSession && !run.retried && !run.cancelled) {
        void execute(run.client, run.claim, true);
        return;
    }
    const result = run.cancelled
        ? { status: 'cancelled' as const }
        : run.error || code !== 0
          ? failed(run.error || `The agent exited with code ${code}`)
          : { status: 'succeeded' as const, output: run.output };
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await run.client.completeRun(id, result);
            return;
        } catch (e) {
            if (e instanceof ApiError && e.status >= 400 && e.status < 500) return;
            await sleep(2000 * (attempt + 1));
        }
    }
}
