/**
 * What the app reads back from its own files, checked at the storage boundary. The files are
 * plain JSON a user (or the agent's tool server) can edit, so nothing past here trusts their shape.
 */
import {
    defaultSettings,
    type Conversation,
    type DocMeta,
    type Message,
    type Settings,
} from './types';

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Stored settings over the defaults, field by field: a missing, null or mistyped field keeps
 *  its default instead of breaking the code that reads it. */
export function parseSettings(raw: unknown): Settings {
    const out: Settings = { ...defaultSettings };
    if (!isRecord(raw)) return out;
    for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
        const value = raw[key];
        if (typeof value === 'string') out[key] = value;
    }
    return out;
}

function parseMessage(raw: unknown): Message | null {
    if (!isRecord(raw) || typeof raw.id !== 'string') return null;
    if (raw.role !== 'user' && raw.role !== 'assistant') return null;
    const m: Message = {
        id: raw.id,
        role: raw.role,
        content: text(raw.content, ''),
        createdAt: time(raw.createdAt),
    };
    if (typeof raw.error === 'string') m.error = raw.error;
    if (Array.isArray(raw.tools))
        m.tools = raw.tools.filter((t): t is string => typeof t === 'string');
    return m;
}

/** A conversation file, or null when it is not one. Messages that are not messages are dropped. */
export function parseConversation(raw: unknown): Conversation | null {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
    const messages = Array.isArray(raw.messages) ? raw.messages.map(parseMessage) : [];
    const c: Conversation = {
        id: raw.id,
        title: text(raw.title, 'Untitled'),
        createdAt: time(raw.createdAt),
        updatedAt: time(raw.updatedAt),
        messages: messages.filter((m) => m !== null),
        streaming: false,
    };
    if (typeof raw.sessionId === 'string') c.sessionId = raw.sessionId;
    return c;
}

/**
 * `documents/index.json`, newest first. Unlike the other files, an index that does not parse is
 * an error rather than an empty list: writing an empty list back would drop every document.
 * Fields this app does not know (the tool server may add some) are kept as they are.
 */
export function parseIndex(raw: string | null): DocMeta[] {
    if (raw === null || !raw.trim()) return [];
    let list: unknown;
    try {
        list = JSON.parse(raw);
    } catch (e) {
        throw new Error(`documents/index.json is not valid JSON: ${(e as Error).message}`, {
            cause: e,
        });
    }
    if (!Array.isArray(list)) throw new Error('documents/index.json is not a list');
    return list
        .filter((d): d is Record<string, unknown> => isRecord(d) && typeof d.id === 'string')
        .map((d) => ({
            ...d,
            id: d.id as string,
            title: text(d.title, 'Untitled'),
            createdAt: time(d.createdAt),
            updatedAt: time(d.updatedAt),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** `meta` in place of the entry with its id (or first, when new), keeping every other entry. */
export const putDoc = (list: DocMeta[], meta: DocMeta): DocMeta[] =>
    [meta, ...list.filter((d) => d.id !== meta.id)].sort((a, b) => b.updatedAt - a.updatedAt);

export const dropDoc = (list: DocMeta[], id: string): DocMeta[] => list.filter((d) => d.id !== id);
