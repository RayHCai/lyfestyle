/**
 * One turn of a conversation, the same in both modes: the user's message and an empty reply go in
 * at once, the agent's output folds into the reply as it arrives, and the reply settles when the
 * turn ends. `agent.ts` (local Claude Code) and `remote.ts` (API runs) differ only in where the
 * output comes from.
 */
import { id as newId } from './util';
import type { Conversation, Message } from './types';

/** The most of the agent's stderr a conversation keeps, from the end. */
const STDERR_MAX = 4000;

/** A content block as both Claude Code's stream-json and the API's run events shape it. */
export interface Block {
    type: string;
    text?: string;
    name?: string;
}

/** The user's message and the reply the agent's output streams into. */
export function turnMessages(text: string, now = Date.now()): [user: Message, reply: Message] {
    return [
        { id: newId(), role: 'user', content: text, createdAt: now },
        { id: newId(), role: 'assistant', content: '', createdAt: now + 1, live: '' },
    ];
}

/** Appends `text` as a new paragraph. */
export const joinText = (a: string, b: string) =>
    a && b && !a.endsWith('\n\n') ? a + '\n\n' + b : a + b;

/** The text of a message's blocks, paragraphs apart, and the tools it called. */
export function readBlocks(blocks: readonly Block[]): { text: string; tools: string[] } {
    let text = '';
    const tools: string[] = [];
    for (const b of blocks) {
        if (b.type === 'text' && b.text) text = joinText(text, b.text);
        else if (b.type === 'tool_use' && b.name) tools.push(b.name);
    }
    return { text, tools };
}

/** Folds a finished assistant message into the reply, replacing the partial text shown so far. */
export function addBlocks(m: Message, blocks: readonly Block[]): Message {
    const { text, tools } = readBlocks(blocks);
    return {
        ...m,
        content: joinText(m.content, text),
        tools: [...(m.tools ?? []), ...tools],
        live: '',
    };
}

export const appendStderr = (stderr: string | undefined, line: string) =>
    ((stderr ?? '') + line + '\n').slice(-STDERR_MAX);

/** The last few stderr lines, to explain a turn that produced nothing. */
export const stderrTail = (stderr: string | undefined, lines = 3) =>
    (stderr ?? '').trim().split('\n').slice(-lines).join('\n');

/**
 * The reply once its turn has ended: the streamed text merged in and trimmed, and an error when
 * there is neither text nor one already, worded by `empty` from the stderr tail.
 */
export function settle(
    m: Message,
    stderr: string | undefined,
    error: string | undefined,
    empty: (tail: string) => string,
): Message {
    const content = (m.content + (m.live ?? '')).trim();
    const reason = error || m.error || (content ? undefined : empty(stderrTail(stderr)));
    return { ...m, content, live: undefined, error: reason };
}

/** Applies `fn` to the reply at the end of the thread, if the thread ends with one. */
export function patchLast(c: Conversation, fn: (m: Message) => Message): Conversation {
    const last = c.messages.at(-1);
    if (!last || last.role !== 'assistant') return c;
    return { ...c, messages: [...c.messages.slice(0, -1), fn(last)], updatedAt: Date.now() };
}
