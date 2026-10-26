/**
 * API mode conversations: a message becomes a run on the Lyfestyle API, executed by the runner,
 * and its events stream back over SSE into the conversation store.
 */
import { getApi, useData } from '../store/data';
import {
    describeError,
    type ApiMessage,
    type ApiRun,
    type ContentBlock,
    type RunEvent,
} from './api';
import { id as newId } from './util';
import type { Conversation, Message } from './types';

const streams = new Map<string, { runId: string; ac: AbortController }>();

function fromBlocks(blocks: ContentBlock[]): { text: string; tools: string[] } {
    let text = '';
    const tools: string[] = [];
    for (const b of blocks) {
        if (b.type === 'text' && b.text)
            text += (text && !text.endsWith('\n\n') ? '\n\n' : '') + b.text;
        else if (b.type === 'tool_use' && b.name) tools.push(b.name);
    }
    return { text, tools };
}

const join = (a: string, b: string) => (a && b && !a.endsWith('\n\n') ? a + '\n\n' + b : a + b);

/** The API transcript as the UI shows it: one assistant message per run, tool results folded away. */
export function mapTranscript(messages: ApiMessage[]): Message[] {
    const out: Message[] = [];
    for (const m of messages) {
        const createdAt = new Date(m.createdAt).getTime();
        const runId = m.runId ?? undefined;
        if (m.role === 'user') {
            out.push({
                id: m.id,
                role: 'user',
                content: fromBlocks(m.content).text,
                createdAt,
                runId,
            });
            continue;
        }
        if (m.role !== 'assistant') continue;
        const { text, tools } = fromBlocks(m.content);
        const last = out[out.length - 1];
        if (last && last.role === 'assistant' && last.runId === runId) {
            last.content = join(last.content, text);
            last.tools = [...(last.tools ?? []), ...tools];
        } else {
            out.push({
                id: m.id,
                role: 'assistant',
                content: text,
                createdAt,
                runId,
                tools: tools.length ? tools : undefined,
            });
        }
    }
    return out;
}

/** Makes sure the thread ends with an assistant message for `runId` to stream into. */
function ensureAssistant(messages: Message[], runId: string): Message[] {
    const last = messages[messages.length - 1];
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
    if (i < 0) return c;
    const messages = c.messages.slice();
    messages[i] = fn(messages[i]!);
    return { ...c, messages, updatedAt: Date.now() };
}

export async function send(conversationId: string, text: string): Promise<void> {
    const data = useData.getState();
    const api = getApi();
    const c = data.conversations[conversationId];
    if (!api || !c || c.streaming) return;
    const now = Date.now();
    const user: Message = { id: newId(), role: 'user', content: text, createdAt: now };
    const assistant: Message = {
        id: newId(),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
        live: '',
    };
    data.updateConversation(conversationId, (cur) => ({
        ...cur,
        messages: [...cur.messages, user, assistant],
        updatedAt: now,
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
    try {
        ({
            run: { id: runId },
        } = await api.sendMessage(conversationId, text));
    } catch (e) {
        fail(conversationId, describeError(e));
        return;
    }
    data.updateConversation(conversationId, (cur) => ({
        ...cur,
        messages: cur.messages.map((m) =>
            m.id === assistant.id ? { ...m, runId } : m.id === user.id ? { ...m, runId } : m,
        ),
    }));
    await attach(conversationId, runId);
}

/** Follows a run's events until it ends. Safe to call for a run already being followed. */
export async function attach(conversationId: string, runId: string, after = 0): Promise<void> {
    const api = getApi();
    if (!api || streams.has(conversationId)) return;
    const ac = new AbortController();
    streams.set(conversationId, { runId, ac });
    const data = useData.getState();
    data.updateConversation(conversationId, (c) => ({
        ...c,
        streaming: true,
        runId,
        messages: ensureAssistant(c.messages, runId),
    }));
    let error: string | undefined;
    try {
        for await (const ev of api.streamRun(runId, after, ac.signal))
            apply(conversationId, runId, ev);
    } catch (e) {
        if (!ac.signal.aborted) error = describeError(e);
    } finally {
        streams.delete(conversationId);
        finish(conversationId, runId, error);
    }
}

function apply(conversationId: string, runId: string, ev: RunEvent) {
    const data = useData.getState();
    if (ev.type === 'message') {
        if (ev.role !== 'assistant') return;
        const { text, tools } = fromBlocks(ev.content);
        data.updateConversation(conversationId, (c) =>
            patchRun(c, runId, (m) => ({
                ...m,
                content: join(m.content, text),
                tools: [...(m.tools ?? []), ...tools],
                live: '',
            })),
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
            stderr: ((c.stderr ?? '') + ev.message + '\n').slice(-4000),
        }));
    }
}

function finish(conversationId: string, runId: string, error?: string) {
    const data = useData.getState();
    if (!data.conversations[conversationId]) return;
    data.updateConversation(conversationId, (cur) =>
        patchRun({ ...cur, streaming: false, runId: undefined }, runId, (m) => {
            const content = (m.content + (m.live ?? '')).trim();
            let err = error ?? m.error;
            if (!content && !err) {
                const tail = (cur.stderr ?? '').trim().split('\n').slice(-3).join('\n');
                err = tail || 'The agent returned nothing.';
            }
            return { ...m, content, live: undefined, error: err };
        }),
    );
}

function fail(conversationId: string, error: string) {
    const data = useData.getState();
    data.updateConversation(conversationId, (cur) => {
        const last = cur.messages[cur.messages.length - 1];
        if (!last || last.role !== 'assistant') return { ...cur, streaming: false };
        return {
            ...cur,
            streaming: false,
            messages: [...cur.messages.slice(0, -1), { ...last, live: undefined, error }],
        };
    });
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
    const transcript = mapTranscript(
        full.messages.filter((m) => m.role === 'user' || !m.runId || !active.includes(m.runId)),
    );
    // A turn that failed or was stopped leaves no assistant message behind; say so instead of showing nothing.
    const byRun = new Map(runs.map((r) => [r.id, r]));
    for (let i = 0; i < transcript.length; i++) {
        const m = transcript[i]!;
        const next = transcript[i + 1];
        const run = m.runId ? byRun.get(m.runId) : undefined;
        if (
            m.role !== 'user' ||
            !run ||
            (next && next.role === 'assistant' && next.runId === m.runId)
        )
            continue;
        if (run.status === 'failed' || run.status === 'cancelled') {
            transcript.splice(i + 1, 0, {
                id: run.id + ':end',
                role: 'assistant',
                content: '',
                createdAt: m.createdAt + 1,
                runId: run.id,
                error: run.status === 'failed' ? run.error || 'The run failed.' : 'Stopped.',
            });
        }
    }
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
            title: full.title || cur.title,
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
        finish(conversationId, s.runId, describeError(e));
    }
}
