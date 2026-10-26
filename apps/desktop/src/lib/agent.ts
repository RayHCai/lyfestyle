/**
 * Sends prompts to the agent process and folds its streamed output into the conversation store.
 *
 * Understands Claude Code's `stream-json` lines (system/init, stream_event deltas, assistant
 * messages, result) and falls back to treating unknown lines as plain text, so a custom harness
 * set through LYFESTYLE_AGENT_COMMAND can print either format.
 */
import { call, isTauri, onEvent } from './tauri';
import { id as newId } from './util';
import { useData } from '../store/data';
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

function lastAssistant(c: Conversation): Message | undefined {
    const m = c.messages[c.messages.length - 1];
    return m && m.role === 'assistant' ? m : undefined;
}

function patchLast(c: Conversation, fn: (m: Message) => Message): Conversation {
    const last = lastAssistant(c);
    if (!last) return c;
    const messages = c.messages.slice(0, -1).concat(fn(last));
    return { ...c, messages, updatedAt: Date.now() };
}

export async function sendMessage(conversationId: string, text: string) {
    const data = useData.getState();
    if (data.mode === 'api') return remote.send(conversationId, text);
    const c = data.conversations[conversationId];
    if (!c || c.streaming) return;
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
                prompt: text,
                session_id: c.sessionId ?? null,
                command: settings.agentCommand,
                model: settings.model,
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
            stderr: ((c.stderr ?? '') + `Stop failed: ${String(e)}\n`).slice(-4000),
        }));
    }
}

/** API mode: fetch the transcript on first open and follow any turn still running. */
export async function openConversation(conversationId: string) {
    if (useData.getState().mode === 'api') await remote.open(conversationId);
}

function handle(p: AgentEventPayload) {
    const data = useData.getState();
    if (!data.conversations[p.conversation_id]) return;
    if (p.kind === 'stderr') {
        data.updateConversation(p.conversation_id, (c) => {
            const stderr = ((c.stderr ?? '') + p.line + '\n').slice(-4000);
            // A missing session means the CLI's history was cleared; start fresh next time.
            const sessionId = /No conversation found/i.test(p.line) ? undefined : c.sessionId;
            return { ...c, stderr, sessionId };
        });
        return;
    }
    if (p.kind === 'exit') {
        finish(p.conversation_id, Number(p.line));
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
        data.updateConversation(p.conversation_id, (c) =>
            patchLast(c, (m) => ({ ...m, content: m.content + line + '\n' })),
        );
        return;
    }
    const type = obj.type as string;
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined;

    if (type === 'system') {
        if (sessionId) data.updateConversation(p.conversation_id, (c) => ({ ...c, sessionId }));
        return;
    }
    if (type === 'stream_event') {
        const ev = obj.event as
            { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (
            ev?.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            ev.delta.text
        ) {
            const text = ev.delta.text;
            data.updateConversation(p.conversation_id, (c) =>
                patchLast(c, (m) => ({ ...m, live: (m.live ?? '') + text })),
            );
        }
        return;
    }
    if (type === 'assistant') {
        const msg = obj.message as
            { content?: Array<{ type: string; text?: string; name?: string }> } | undefined;
        const blocks = msg?.content ?? [];
        data.updateConversation(p.conversation_id, (c) =>
            patchLast(c, (m) => {
                let content = m.content;
                const tools = [...(m.tools ?? [])];
                for (const b of blocks) {
                    if (b.type === 'text' && b.text)
                        content += (content && !content.endsWith('\n\n') ? '\n\n' : '') + b.text;
                    else if (b.type === 'tool_use' && b.name) tools.push(b.name);
                }
                return { ...m, content, tools, live: '' };
            }),
        );
        return;
    }
    if (type === 'result') {
        const result = typeof obj.result === 'string' ? obj.result : '';
        const isError =
            obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype !== 'success');
        data.updateConversation(p.conversation_id, (c) =>
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
    const c = data.conversations[conversationId];
    if (!c) return;
    data.updateConversation(conversationId, (cur) =>
        patchLast({ ...cur, streaming: false }, (m) => {
            const content = (m.content + (m.live ?? '')).trim();
            let err = error ?? m.error;
            if (!content && !err) {
                const tail = (cur.stderr ?? '').trim().split('\n').slice(-3).join('\n');
                err =
                    code === 0
                        ? 'The agent returned nothing.'
                        : `The agent exited with code ${code}.${tail ? '\n' + tail : ''}`;
            }
            return { ...m, content, live: undefined, error: err };
        }),
    );
    void data.persistConversation(conversationId);
}
