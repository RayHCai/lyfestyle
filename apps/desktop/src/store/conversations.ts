import { describeError, type ApiConversation } from '../lib/api';
import { storage, writeJSON } from '../lib/storage';
import { call, isTauri } from '../lib/tauri';
import { id as newId } from '../lib/util';
import type { Conversation } from '../lib/types';
import { getApi } from './backend';
import type { ConversationsSlice, Slice } from './state';

export const convKey = (id: string) => `conversations/${id}.json`;

/** Conversations deleted this session. A refresh that was already in flight still lists them,
 *  and must not bring them back. */
export const deletedConversations = new Set<string>();

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Date.now());

export function fromApiConversation(c: ApiConversation, prev?: Conversation): Conversation {
    return {
        messages: [],
        loaded: false,
        ...prev,
        id: c.id,
        title: c.title || 'Untitled',
        createdAt: ms(c.createdAt),
        updatedAt: Math.max(ms(c.updatedAt), prev?.streaming ? prev.updatedAt : 0),
        offline: false,
    };
}

/** Stops a running turn before its conversation goes. Best effort: the process may be gone. */
async function stopTurn(c: Conversation) {
    if (!c.streaming) return;
    const api = getApi();
    try {
        if (api) {
            if (c.runId) await api.cancelRun(c.runId);
        } else if (isTauri) {
            // Tauri 2 expects top-level command arguments in camelCase.
            await call('agent_cancel', { conversationId: c.id });
        }
    } catch (e) {
        console.warn(`Could not stop the turn in ${c.id} before deleting it:`, e);
    }
}

export const conversationsSlice: Slice<ConversationsSlice> = (set, get) => ({
    conversations: {},

    async createConversation(title) {
        const now = Date.now();
        const api = getApi();
        const fresh: Conversation = {
            id: newId(),
            title,
            createdAt: now,
            updatedAt: now,
            messages: [],
        };
        let c = fresh;
        if (api) {
            try {
                c = { ...fromApiConversation(await api.createConversation(title)), loaded: true };
            } catch (e) {
                set({ api: { state: 'error', url: api.baseUrl, error: describeError(e) } });
                c = { ...fresh, loaded: true, offline: true };
            }
        }
        set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }));
        return c;
    },

    updateConversation(id, fn) {
        set((s) => {
            const current = s.conversations[id];
            if (!current) return s;
            return { conversations: { ...s.conversations, [id]: fn(current) } };
        });
    },

    async persistConversation(id) {
        if (getApi()) return;
        const c = get().conversations[id];
        if (!c) return;
        const { streaming: _s, stderr: _e, ...rest } = c;
        const messages = rest.messages.map(({ live: _l, ...m }) => m);
        await writeJSON(convKey(id), { ...rest, messages });
    },

    async deleteConversation(id) {
        const c = get().conversations[id];
        if (!c) return;
        await stopTurn(c);
        deletedConversations.add(id);
        set((s) => {
            const next = { ...s.conversations };
            delete next[id];
            return { conversations: next };
        });
        try {
            const api = getApi();
            if (api) {
                if (!c.offline) await api.deleteConversation(id);
            } else {
                await storage.del(convKey(id));
            }
        } catch (e) {
            deletedConversations.delete(id);
            set((s) => ({
                conversations: { [id]: { ...c, streaming: false }, ...s.conversations },
            }));
            throw new Error(`Could not delete "${c.title}": ${describeError(e)}`, { cause: e });
        }
    },
});
