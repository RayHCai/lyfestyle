import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AutomationLog } from '../db/client.js';

/** What the child hands over to the API: helper calls and log lines. */
export interface SandboxHost {
    /** Answers a `ctx` helper; a rejection is thrown inside the code as an Error. */
    call(method: string, args: unknown[]): Promise<unknown>;
    log(level: AutomationLog['level'], message: string): void;
}

export interface SandboxOptions {
    /** An ES module whose default export is `async (ctx) => result`. */
    code: string;
    /** Plain data the code sees as `ctx.automation` and the initial `ctx.state.get()`. */
    automation: Record<string, unknown>;
    state: unknown;
    /** The host helpers `ctx` offers, by path: `email` is `ctx.email`, `state.set` `ctx.state.set`. */
    helpers: readonly string[];
    host: SandboxHost;
    timeoutMs: number;
    signal: AbortSignal;
    memoryMb?: number;
}

/** `aborted`: stopped from outside (`signal`); `timeout`: ran too long; `failed`: anything else. */
export class SandboxError extends Error {
    constructor(
        message: string,
        readonly kind: 'aborted' | 'timeout' | 'failed' = 'failed',
    ) {
        super(message);
    }
}

const fromChild = (helpers: readonly string[]) =>
    z.discriminatedUnion('type', [
        z.object({
            type: z.literal('call'),
            id: z.int().positive(),
            method: z.enum(helpers as [string, ...string[]]),
            args: z.array(z.unknown()).max(10),
        }),
        z.object({
            type: z.literal('log'),
            level: z.enum(['info', 'warn', 'error']),
            message: z.string(),
        }),
        z.object({ type: z.literal('done'), output: z.string().nullable() }),
        z.object({ type: z.literal('failed'), error: z.string() }),
    ]);

// The child's entry point, an ES module passed with -e so the bundled API needs no file beside it.
// It waits for `start` over IPC (argv is capped at ~32 KB on Windows), builds `ctx` from the helper
// names it is sent, and imports the automation from a data: URL. `ctx` is the only way back to the
// API: every helper on it is a message the host answers.
const BOOTSTRAP = String.raw`
const send = (message) => process.send(message);
// The permission model does not cover signals, and this process runs as the API's own user.
for (const name of ['kill', '_kill']) {
    Object.defineProperty(process, name, {
        value: () => { throw new Error('process.kill is not available to automations'); },
        writable: false,
        configurable: false,
    });
}
// The API went away: nobody is left to hear the result or to enforce the timeout.
process.on('disconnect', () => process.exit(1));
const text = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
};
const log = (level) => (...args) => send({ type: 'log', level, message: args.map(text).join(' ') });
let seq = 0;
const pending = new Map();
const call = (method, args) =>
    new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try {
            send({ type: 'call', id, method, args });
        } catch (err) {
            pending.delete(id);
            reject(err);
        }
    });
const freeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
    return Object.freeze(o);
};
async function run({ code, automation, state: initial, helpers }) {
    let state = initial;
    const ctx = { automation, log: log('info'), warn: log('warn'), error: log('error') };
    for (const name of helpers) {
        const keys = name.split('.');
        const last = keys.pop();
        let target = ctx;
        for (const key of keys) target = target[key] ??= {};
        target[last] = (...args) => call(name, args);
    }
    // get() answers from this process's copy; set() adopts what the API stored, e.g. {} for null.
    const setState = ctx.state.set;
    ctx.state.get = () => state;
    ctx.state.set = async (value) => { state = await setState(value); };
    console.log = console.info = console.debug = ctx.log;
    console.warn = ctx.warn;
    console.error = ctx.error;
    const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    if (typeof mod.default !== 'function') {
        throw new Error('The module must export a default function: export default async (ctx) => {}');
    }
    const result = await mod.default(freeze(ctx));
    send({
        type: 'done',
        output: result === undefined ? null : typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? null),
    });
}
let started = false;
process.on('message', (m) => {
    if (m.type === 'start' && !started) {
        started = true;
        run(m).catch((err) => send({ type: 'failed', error: text(err) }));
    } else if (m.type === 'reply') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else p.resolve(m.value);
    }
});
`;

/** Long enough to show what a malformed message was, short enough for one log line. */
const preview = (value: unknown) => {
    try {
        return (JSON.stringify(value) ?? String(value)).slice(0, 300);
    } catch {
        return String(value).slice(0, 300);
    }
};

/**
 * Runs automation code in a child Node process under the permission model (ADR 0007): no
 * environment, no file system, no child processes or worker threads, no native addons; the network
 * stays open. The process gets its own heap limit and is killed on timeout or abort, so a crash or
 * runaway allocation takes down the child and fails the run, never the API.
 */
export function runInSandbox(options: SandboxOptions): Promise<{ output: string | null }> {
    const { host, signal } = options;
    const memoryMb = options.memoryMb ?? 256;
    const parse = fromChild(options.helpers);
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            return reject(new SandboxError(String(signal.reason ?? 'Aborted'), 'aborted'));
        }
        const child = spawn(
            process.execPath,
            [
                '--permission',
                `--max-old-space-size=${memoryMb}`,
                '--input-type=module',
                '-e',
                BOOTSTRAP,
            ],
            // An empty env keeps the API's secrets out. On Windows libuv still copies in the few
            // system variables a process needs to start (SYSTEMROOT, PATH, TEMP, ...).
            { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
        );
        let settled = false;
        let stderrTail = '';
        const finish = (outcome: { output: string | null } | SandboxError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            child.kill('SIGKILL');
            if (outcome instanceof SandboxError) reject(outcome);
            else resolve(outcome);
        };
        const timer = setTimeout(
            () =>
                finish(
                    new SandboxError(
                        `Timed out after ${Math.round(options.timeoutMs / 1000)} s`,
                        'timeout',
                    ),
                ),
            options.timeoutMs,
        );
        const onAbort = () =>
            finish(new SandboxError(String(signal.reason ?? 'Aborted'), 'aborted'));
        signal.addEventListener('abort', onAbort, { once: true });

        // Writes that bypass the patched console (process.stdout directly) still end up in the log.
        // Both are pipes, as `stdio` asks.
        const stdout = child.stdout!;
        const stderr = child.stderr!;
        stdout.setEncoding('utf8');
        stderr.setEncoding('utf8');
        stdout.on('data', (chunk: string) => {
            if (chunk.trim()) host.log('info', chunk.trimEnd());
        });
        stderr.on('data', (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-2000);
            if (chunk.trim()) host.log('warn', chunk.trimEnd());
        });

        const send = (message: object) => {
            if (settled || !child.connected) return;
            child.send(message, (err) => {
                if (err) finish(new SandboxError(`Could not reach the code: ${err.message}`));
            });
        };
        const reply = (id: number, body: { value: unknown } | { error: unknown }) => {
            try {
                send({ type: 'reply', id, ...body });
            } catch (err) {
                // A value JSON cannot carry (a BigInt) throws here; the code gets an error instead.
                send({
                    type: 'reply',
                    id,
                    error: { message: `Unserialisable result: ${String(err)}` },
                });
            }
        };
        const answer = (id: number, method: string, args: unknown[]) => {
            Promise.resolve()
                .then(() => host.call(method, args))
                .then(
                    (value) => reply(id, { value }),
                    (err: unknown) => {
                        const { message, code } = (err ?? {}) as {
                            message?: unknown;
                            code?: unknown;
                        };
                        reply(id, {
                            error: {
                                message: typeof message === 'string' ? message : String(err),
                                code: typeof code === 'string' ? code : undefined,
                            },
                        });
                    },
                )
                .catch((err: unknown) =>
                    finish(new SandboxError(`Could not answer the code: ${String(err)}`)),
                );
        };

        // Never throws: an exception in an IPC listener would be uncaught and take the API down.
        child.on('message', (raw: unknown) => {
            try {
                if (settled) return;
                const parsed = parse.safeParse(raw);
                if (!parsed.success) {
                    host.log('error', `Invalid message from the code: ${preview(raw)}`);
                    finish(new SandboxError('The code sent the API an invalid message'));
                    return;
                }
                const message = parsed.data;
                if (message.type === 'log') host.log(message.level, message.message);
                else if (message.type === 'done') finish({ output: message.output });
                else if (message.type === 'failed') finish(new SandboxError(message.error));
                else answer(message.id, message.method, message.args);
            } catch (err) {
                finish(
                    new SandboxError(`Could not handle a message from the code: ${String(err)}`),
                );
            }
        });
        child.on('error', (err) => finish(new SandboxError(err.stack ?? err.message)));
        // The channel also closes when the child dies, so the outcome is decided on `close`; this
        // only makes sure a child that hung up on purpose does not run on unsupervised.
        child.on('disconnect', () => child.kill('SIGKILL'));
        // `close` rather than `exit`, so stderr (e.g. V8's out-of-memory report) is in the log first.
        child.on('close', (code, signalName) => {
            const oom = /heap out of memory|Allocation failed/.test(stderrTail);
            finish(
                new SandboxError(
                    oom
                        ? `Ran out of memory (${memoryMb} MB)`
                        : `The code stopped before finishing (exit ${code ?? signalName})`,
                ),
            );
        });

        send({
            type: 'start',
            code: options.code,
            automation: options.automation,
            state: options.state,
            helpers: options.helpers,
        });
    });
}
