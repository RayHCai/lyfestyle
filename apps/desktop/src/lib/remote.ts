/**
 * API mode conversations: a message becomes a run on the Lyfestyle API, executed by the runner,
 * and its events stream back over SSE into the conversation store.
 */
import type { RunEvent } from '@lyfestyle/shared';
import { getApi, useData } from '../store/data';
import { ApiError, describeError, type ApiRun } from './api';
import { deploysIn, mapTranscript, noteDeployCalls, withDeploys } from './transcript';
import { addBlocks, appendStderr, patchLast, settle, turnMessages } from './turn';
import { id as newId } from './util';
import type { Conversation, Message } from './types';

/** Runs being followed, by conversation. `calls` holds the run's `automations_deploy` tool-use
 *  ids until their results arrive, and goes with the stream when it ends. */
const streams = new Map<string, { runId: string; ac: AbortController; calls: Set<string> }>();

/** Makes sure the thread ends with an assistant message for `runId` to stream into. */
function ensureAssistant(messages: Message[], runId: string): Message[] {
    const last = messages.at(-1);
    if (
        last &&
        last.role === 'assistant' &&
        (last.runId === runId || (!last.runId && !last.content))
    ) {
        return [...messages.slice(0, -1), { ...last, runId, live: last.live ?? '' }];
    }
    return [
        ...messages,
        { id: newId(), role: 'assistant', content: '', createdAt: Date.now(), runId, live: '' },
    ];
}

function patchRun(c: Conversation, runId: string, fn: (m: Message) => Message): Conversation {
    const i = c.messages.map((m) => m.role === 'assistant' && m.runId === runId).lastIndexOf(true);
    const m = c.messages[i];
    if (!m) return c;
    const messages = c.messages.slice();
    messages[i] = fn(m);
    return { ...c, messages, updatedAt: Date.now() };
}

/** Sends `text`; with `from`, in place of that user message and everything after it. */
export async function send(conversationId: string, text: string, from?: string): Promise<void> {
    const data = useData.getState();
    const api = getApi();
    const c = data.conversations[conversationId];
    if (!api || !c || c.streaming) return;
    const at = from ? c.messages.findIndex((m) => m.id === from) : -1;
    if (from && at < 0) return;
    const [user, reply] = turnMessages(text);
    data.updateConversation(conversationId, (cur) => ({
        ...cur,
        messages: [...(from ? cur.messages.slice(0, at) : cur.messages), user, reply],
        updatedAt: user.createdAt,
        streaming: true,
        stderr: '',
        loaded: true,
    }));
    if (c.offline) {
        fail(
            conversationId,
            data.api.error ?? 'The API is unreachable, so this conversation cannot be sent.',
        );
        return;
    }
    let runId: string;
    let sent: string;
    try {
        ({
            message: { id: sent },
            run: { id: runId },
        } = await api.sendMessage(conversationId, text, from));
    } catch (e) {
        fail(conversationId, describeError(e));
        // The API kept the transcript this cut short; fetch it again on the next open.
        if (from) data.updateConversation(conversationId, (cur) => ({ ...cur, loaded: false }));
        return;
    }
    // Take the API's id for the message, so it can be edited later.
    data.updateConversation(conversationId, (cur) => ({
        ...cur,
        messages: cur.messages.map((m) =>
            m.id === reply.id ? { ...m, runId } : m.id === user.id ? { ...m, id: sent, runId } : m,
        ),
    }));
    await attach(conversationId, runId);
}

/** Follows a run's events until it ends. Safe to call for a run already being followed. */
export async function attach(conversationId: string, runId: string): Promise<void> {
    const api = getApi();
    if (!api || streams.has(conversationId)) return;
    const stream = { runId, ac: new AbortController(), calls: new Set<string>() };
    streams.set(conversationId, stream);
    const data = useData.getState();
    data.updateConversation(conversationId, (c) => ({
        ...c,
        streaming: true,
        runId,
        messages: ensureAssistant(c.messages, runId),
    }));
    let error: string | undefined;
    let lost = false;
    try {
        for await (const ev of api.streamRun(runId, stream.ac.signal))
            apply(conversationId, runId, ev, stream.calls);
    } catch (e) {
        if (!stream.ac.signal.aborted) {
            // A 4xx is about the run itself; anything else means the stream gave up reconnecting
            // while the run may still be going on the server.
            lost = !(e instanceof ApiError && e.status >= 400 && e.status < 500);
            error = lost
                ? `Lost the connection to this reply (${describeError(e)}). Open the conversation again to catch up.`
                : describeError(e);
        }
    } finally {
        streams.delete(conversationId);
        finish(conversationId, runId, error, lost);
    }
}

function apply(conversationId: string, runId: string, ev: RunEvent, calls: Set<string>) {
    const data = useData.getState();
    if (ev.type === 'message') {
        if (ev.role === 'tool') {
            const ids = deploysIn(ev.content, calls);
            if (ids.length)
                data.updateConversation(conversationId, (c) =>
                    patchRun(c, runId, (m) => withDeploys(m, ids)),
                );
            return;
        }
        noteDeployCalls(ev.content, calls);
        data.updateConversation(conversationId, (c) =>
            patchRun(c, runId, (m) => addBlocks(m, ev.content)),
        );
    } else if (ev.type === 'status') {
        if (ev.status === 'failed') {
            data.updateConversation(conversationId, (c) =>
                patchRun(c, runId, (m) => ({ ...m, error: ev.error || 'The run failed.' })),
            );
        } else if (ev.status === 'cancelled') {
            data.updateConversation(conversationId, (c) =>
                patchRun(c, runId, (m) => ({ ...m, error: m.content ? undefined : 'Stopped.' })),
            );
        }
    } else if (ev.type === 'log' && ev.level === 'error') {
        data.updateConversation(conversationId, (c) => ({
            ...c,
            stderr: appendStderr(c.stderr, ev.message),
        }));
    }
}

/** Ends the reply. When the stream was `lost`, the transcript is marked for a refetch, which
 *  reattaches to the run if it is still going. */
function finish(conversationId: string, runId: string, error: string | undefined, lost: boolean) {
    const data = useData.getState();
    if (!data.conversations[conversationId]) return;
    data.updateConversation(conversationId, (cur) =>
        patchRun(
            { ...cur, streaming: false, runId: undefined, ...(lost ? { loaded: false } : {}) },
            runId,
            (m) => settle(m, cur.stderr, error, (tail) => tail || 'The agent returned nothing.'),
        ),
    );
    // The run may have changed pages through the API's tools.
    void data.reloadFiles();
}

function fail(conversationId: string, error: string) {
    useData
        .getState()
        .updateConversation(conversationId, (cur) =>
            patchLast({ ...cur, streaming: false }, (m) => ({ ...m, live: undefined, error })),
        );
}

/** A turn that failed or was stopped leaves no assistant message behind; say so instead of
 *  showing nothing. */
function markUnanswered(transcript: Message[], runs: ApiRun[]): Message[] {
    const byRun = new Map(runs.map((r) => [r.id, r]));
    const out: Message[] = [];
    transcript.forEach((m, i) => {
        out.push(m);
        const next = transcript[i + 1];
        const run = m.runId ? byRun.get(m.runId) : undefined;
        if (m.role !== 'user' || !run || (next?.role === 'assistant' && next.runId === m.runId))
            return;
        if (run.status === 'failed' || run.status === 'cancelled') {
            out.push({
                id: run.id + ':end',
                role: 'assistant',
                content: '',
                createdAt: m.createdAt + 1,
                runId: run.id,
                error: run.status === 'failed' ? run.error || 'The run failed.' : 'Stopped.',
            });
        }
    });
    return out;
}

/** Fetches the transcript on first open and follows any turn still in flight. */
export async function open(conversationId: string): Promise<void> {
    const api = getApi();
    const data = useData.getState();
    const c = data.conversations[conversationId];
    if (!api || !c || c.offline || c.loaded || streams.has(conversationId)) return;
    let full;
    let runs: ApiRun[] = [];
    try {
        [full, runs] = await Promise.all([
            api.getConversation(conversationId),
            // Only for explaining unanswered turns; the transcript reads fine without it.
            api.listRuns(conversationId).catch(() => []),
        ]);
    } catch (e) {
        data.updateConversation(conversationId, (cur) => ({
            ...cur,
            loaded: true,
            stderr: describeError(e),
        }));
        return;
    }
    const active = full.activeRuns.map((r) => r.id);
    // The stream replays an active run's messages from the start, so drop its partial transcript here.
    const transcript = markUnanswered(
        mapTranscript(
            full.messages.filter((m) => m.role === 'user' || !m.runId || !active.includes(m.runId)),
        ),
        runs,
    );
    const title = full.title;
    data.updateConversation(conversationId, (cur) => {
        // A reply sent before this fetch finished is still in flight; keep it after the transcript.
        const inflight = cur.streaming
            ? cur.messages.filter((m) => !m.runId || m.runId === cur.runId)
            : [];
        const settled = cur.streaming
            ? transcript.filter((m) => m.runId !== cur.runId)
            : transcript;
        return {
            ...cur,
            title: title || cur.title,
            messages: [...settled, ...inflight],
            loaded: true,
        };
    });
    for (const runId of active) await attach(conversationId, runId);
}

export async function cancel(conversationId: string): Promise<void> {
    const api = getApi();
    const s = streams.get(conversationId);
    if (!api || !s) return;
    try {
        await api.cancelRun(s.runId);
    } catch (e) {
        s.ac.abort();
        finish(conversationId, s.runId, describeError(e), false);
    }
}
