import {
    ApiRequestError,
    createApiClient,
    streamRunEvents,
    unwrap,
    type ApiClient,
    type ClientOptions,
} from '@lyfestyle/client';
import type { RunEvent } from '@lyfestyle/shared';
import { parseArgs } from 'node:util';
import { loadRunnerEnv } from './env.js';

/** Words the desktop app looks for on stderr to drop a session id it should stop resuming. */
export const UNKNOWN_SESSION = 'No conversation found';
const WAITING_HINT_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A run event as the stream-json lines Claude Code prints, or none for events it has no line for. */
export function toStreamJson(event: RunEvent, sessionId: string): object[] {
    if (event.type !== 'message') return [];
    if (event.role === 'assistant') {
        const content = event.content.flatMap((block): object[] => {
            if (block.type === 'text') return [{ type: 'text', text: block.text }];
            if (block.type === 'tool_use')
                return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
            return [];
        });
        return content.length
            ? [
                  {
                      type: 'assistant',
                      session_id: sessionId,
                      message: { role: 'assistant', content },
                  },
              ]
            : [];
    }
    const content = event.content.flatMap((block) =>
        block.type === 'tool_result'
            ? [
                  {
                      type: 'tool_result',
                      tool_use_id: block.toolUseId,
                      content: block.content,
                      is_error: block.isError ?? false,
                  },
              ]
            : [],
    );
    return content.length
        ? [{ type: 'user', session_id: sessionId, message: { role: 'user', content } }]
        : [];
}

export interface BridgeIO {
    write(line: object): void;
    warn(message: string): void;
}

async function conversationFor(api: ApiClient, session: string | undefined, io: BridgeIO) {
    if (session && UUID.test(session)) {
        const res = await api.conversations[':id'].$get({ param: { id: session } });
        if (res.ok) return session;
        if (res.status !== 404) throw await ApiRequestError.from(res);
        io.warn(`${UNKNOWN_SESSION} with id ${session}; starting a new one`);
    }
    return (await unwrap(api.conversations.$post({ json: {} }))).id;
}

/**
 * One chat turn through the API: posts the prompt to a conversation, follows the run a runner
 * executes for it, and prints it as Claude Code stream-json. Resolves the exit code.
 */
export async function bridge(options: {
    client: ClientOptions;
    prompt: string;
    session?: string | undefined;
    io: BridgeIO;
    signal?: AbortSignal;
}): Promise<number> {
    const { client, prompt, io } = options;
    const api = createApiClient(client);
    const conversationId = await conversationFor(api, options.session, io);
    const { run } = await unwrap(
        api.conversations[':id'].messages.$post({
            param: { id: conversationId },
            json: { text: prompt },
        }),
    );
    io.write({
        type: 'system',
        subtype: 'init',
        session_id: conversationId,
        run_id: run.id,
        model: 'lyfestyle',
    });

    const cancel = () =>
        void api.runs[':id'].cancel.$post({ param: { id: run.id } }).catch(() => {});
    options.signal?.addEventListener('abort', cancel, { once: true });
    const hint = setTimeout(
        () => io.warn('Waiting for a runner to pick this turn up; is `pnpm runner` running?'),
        WAITING_HINT_MS,
    );
    try {
        for await (const event of streamRunEvents({
            ...client,
            runId: run.id,
            ...(options.signal ? { signal: options.signal } : {}),
        })) {
            if (event.type === 'status' && event.status !== 'queued') clearTimeout(hint);
            if (event.type === 'log' && (event.level === 'error' || event.level === 'warn'))
                io.warn(event.message);
            for (const line of toStreamJson(event, conversationId)) io.write(line);
        }
    } finally {
        clearTimeout(hint);
        options.signal?.removeEventListener('abort', cancel);
    }

    const final = await unwrap(api.runs[':id'].$get({ param: { id: run.id } }));
    const ok = final.status === 'succeeded';
    io.write({
        type: 'result',
        subtype: ok ? 'success' : 'error_during_execution',
        is_error: !ok,
        result: ok ? (final.output ?? '') : (final.error ?? `Run ${final.status}`),
        session_id: conversationId,
        total_cost_usd: final.usage.costUsd,
        usage: {
            input_tokens: final.usage.inputTokens,
            output_tokens: final.usage.outputTokens,
            cache_read_input_tokens: final.usage.cacheReadTokens,
            cache_creation_input_tokens: final.usage.cacheWriteTokens,
        },
    });
    return ok ? 0 : 1;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

/** CLI entry: prompt on stdin, `--session <id>` to continue a conversation. */
export async function main(): Promise<number> {
    const { values } = parseArgs({
        options: { session: { type: 'string' }, resume: { type: 'string' } },
        strict: false,
    });
    const env = loadRunnerEnv();
    const prompt = (await readStdin()).trim();
    if (!prompt) {
        console.error('Expected the prompt on stdin');
        return 2;
    }
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    process.once('SIGTERM', () => stop.abort());
    const session = values.session ?? values.resume;
    return bridge({
        client: { baseUrl: env.apiUrl, token: env.apiToken },
        prompt,
        session: typeof session === 'string' ? session : undefined,
        signal: stop.signal,
        io: {
            write: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
            warn: (message) => process.stderr.write(`${message}\n`),
        },
    });
}
