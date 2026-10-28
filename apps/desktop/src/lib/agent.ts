/**
 * Sends prompts to the agent process and folds its streamed output into the conversation store.
 *
 * Understands Claude Code's `stream-json` lines (system/init, stream_event deltas, assistant
 * messages, result) and falls back to treating unknown lines as plain text, so a custom harness
 * set through LYFESTYLE_AGENT_COMMAND can print either format.
 */
import { call, isTauri, onEvent } from './tauri';
import { useData } from '../store/data';
import { addBlocks, appendStderr, patchLast, settle, turnMessages, type Block } from './turn';
import type { Conversation, Message } from './types';
import * as remote from './remote';

interface AgentEventPayload {
    conversation_id: string;
    kind: 'line' | 'stderr' | 'exit';
    line: string;
}

let listening = false;

export async function initAgent() {
    if (listening) return;
    listening = true;
    await onEvent<AgentEventPayload>('agent-event', handle);
}

export async function sendMessage(conversationId: string, text: string) {
    const data = useData.getState();
    if (data.mode === 'api') return remote.send(conversationId, text);
    const c = data.conversations[conversationId];
    if (!c || c.streaming) return;
    await start(c, c.messages.length, text, c.sessionId);
}

/** Whether `resend` works here: a conversation made while the API was unreachable has nothing to
 *  rewind. */
export const canResend = (c: Conversation) => !c.offline;

/**
 * Asks again from a user message: drops it and everything after, then sends `text` in its place.
 * Editing a message and retrying a reply are both this.
 */
export async function resend(conversationId: string, messageId: string, text: string) {
    const data = useData.getState();
    const c = data.conversations[conversationId];
    if (!c || !canResend(c) || c.streaming) return;
    if (data.mode === 'api') return remote.send(conversationId, text, messageId);
    const at = c.messages.findIndex((m) => m.id === messageId);
    if (at < 0) return;
    // The Claude Code session remembers the dropped turns, so start a fresh one and give it the
    // kept turns as a transcript instead.
    await start(c, at, text, undefined);
}

/** The thread as plain text, for a fresh session that has to pick up an earlier conversation. */
function transcript(messages: Message[]): string {
    return messages
        .filter((m) => m.content.trim())
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
        .join('\n\n');
}

/** Keeps the first `keep` messages, appends `text` and a reply to stream into, and runs the agent. */
async function start(c: Conversation, keep: number, text: string, sessionId: string | undefined) {
    const data = useData.getState();
    const conversationId = c.id;
    const kept = c.messages.slice(0, keep);
    const earlier = sessionId ? '' : transcript(kept);
    const prompt = earlier
        ? `<conversation_so_far>\n${earlier}\n</conversation_so_far>\n\n${text}`
        : text;
    const [user, reply] = turnMessages(text);
    data.updateConversation(conversationId, (cur) => ({
        ...cur,
        messages: [...kept, user, reply],
        sessionId,
        updatedAt: user.createdAt,
        streaming: true,
        stderr: '',
    }));
    await data.persistConversation(conversationId);

    if (!isTauri) {
        finish(conversationId, -1, 'The agent only runs inside the desktop app.');
        return;
    }
    const { settings } = useData.getState();
    try {
        await call('agent_send', {
            args: {
                conversation_id: conversationId,
                prompt,
                session_id: sessionId ?? null,
                command: settings.agentCommand,
                model: settings.model,
                effort: settings.effort,
                todo_mcp_url: settings.todoMcpUrl,
                cwd: settings.workingDirectory || useData.getState().dataDir,
            },
        });
    } catch (e) {
        finish(conversationId, -1, String(e));
    }
}

export async function cancel(conversationId: string) {
    if (useData.getState().mode === 'api') return remote.cancel(conversationId);
    if (!isTauri) return;
    try {
        // Tauri 2 expects top-level command arguments in camelCase.
        await call('agent_cancel', { conversationId });
    } catch (e) {
        // The process may already be gone; keep the reason where the thread can surface it.
        useData.getState().updateConversation(conversationId, (c) => ({
            ...c,
            stderr: appendStderr(c.stderr, `Stop failed: ${String(e)}`),
        }));
    }
}

/** API mode: fetch the transcript on first open and follow any turn still running. */
export async function openConversation(conversationId: string) {
    if (useData.getState().mode === 'api') await remote.open(conversationId);
}

function handle(p: AgentEventPayload) {
    const data = useData.getState();
    const id = p.conversation_id;
    if (!data.conversations[id]) return;
    if (p.kind === 'stderr') {
        data.updateConversation(id, (c) => ({
            ...c,
            stderr: appendStderr(c.stderr, p.line),
            // A missing session means the CLI's history was cleared; start fresh next time.
            sessionId: /No conversation found/i.test(p.line) ? undefined : c.sessionId,
        }));
        return;
    }
    if (p.kind === 'exit') {
        finish(id, Number(p.line));
        return;
    }
    const line = p.line.trim();
    if (!line) return;
    let obj: Record<string, unknown> | null = null;
    try {
        obj = JSON.parse(line);
    } catch {
        obj = null;
    }
    if (!obj || typeof obj !== 'object') {
        data.updateConversation(id, (c) =>
            patchLast(c, (m) => ({ ...m, content: m.content + line + '\n' })),
        );
        return;
    }
    const type = obj.type as string;
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined;

    if (type === 'system') {
        if (sessionId) data.updateConversation(id, (c) => ({ ...c, sessionId }));
        return;
    }
    if (type === 'stream_event') {
        const ev = obj.event as
            { type?: string; delta?: { type?: string; text?: string } } | undefined;
        const text =
            ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text;
        if (text)
            data.updateConversation(id, (c) =>
                patchLast(c, (m) => ({ ...m, live: (m.live ?? '') + text })),
            );
        return;
    }
    if (type === 'assistant') {
        const msg = obj.message as { content?: Block[] } | undefined;
        data.updateConversation(id, (c) => patchLast(c, (m) => addBlocks(m, msg?.content ?? [])));
        return;
    }
    if (type === 'result') {
        const result = typeof obj.result === 'string' ? obj.result : '';
        const isError =
            obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype !== 'success');
        data.updateConversation(id, (c) =>
            patchLast({ ...c, sessionId: sessionId ?? c.sessionId }, (m) => ({
                ...m,
                content: m.content.trim() ? m.content : result,
                error: isError ? result || `Agent stopped (${String(obj.subtype)})` : m.error,
                live: '',
            })),
        );
    }
}

function finish(conversationId: string, code: number, error?: string) {
    const data = useData.getState();
    if (!data.conversations[conversationId]) return;
    data.updateConversation(conversationId, (cur) =>
        patchLast({ ...cur, streaming: false }, (m) =>
            settle(m, cur.stderr, error, (tail) =>
                code === 0
                    ? 'The agent returned nothing.'
                    : `The agent exited with code ${code}.${tail ? '\n' + tail : ''}`,
            ),
        ),
    );
    void data.persistConversation(conversationId);
    // The turn may have changed documents through the app's tool server.
    void data.reloadFiles();
}
