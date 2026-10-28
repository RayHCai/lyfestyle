/**
 * `useData`: everything the app shows that is not UI state. One zustand store built from a module
 * per domain (settings, conversations, docs, automations); this one decides the mode, local files
 * or the Lyfestyle API, and loads or refreshes everything from it.
 */
import { create } from 'zustand';
import { Api, describeError } from '../lib/api';
import { readJSON, storage } from '../lib/storage';
import { parseConversation, parseSettings } from '../lib/stored';
import { PageSync } from '../lib/sync';
import { call, isTauri } from '../lib/tauri';
import type { AgentEnv, Conversation } from '../lib/types';
import { automationsSlice } from './automations';
import { getApi, isActive, setBackend } from './backend';
import { conversationsSlice, deletedConversations, fromApiConversation } from './conversations';
import { docsSlice, loadLocalDocs, pageState, pageSyncHooks } from './docs';
import { noEnv, settingsSlice } from './settings';
import type { DataState } from './state';

export type { ApiStatus, DataState, Mode } from './state';
export { getApi } from './backend';

/** Counts `load` calls, so a load that a newer one overtook drops its results. */
let loads = 0;

export const useData = create<DataState>()((set, get, store) => ({
    ...settingsSlice(set, get, store),
    ...conversationsSlice(set, get, store),
    ...docsSlice(set, get, store),
    ...automationsSlice(set, get, store),

    ready: false,
    mode: 'local',
    api: { state: 'off', url: '' },
    notice: null,
    notify: (notice) => set({ notice }),

    async load() {
        const run = ++loads;
        const [stored, dataDir] = await Promise.all([
            readJSON<unknown>('settings.json', null),
            storage.dir(),
        ]);
        let env: AgentEnv = noEnv;
        if (isTauri) {
            try {
                env = { ...noEnv, ...(await call<AgentEnv>('agent_env')) };
            } catch (e) {
                console.warn('agent_env failed; running without its environment:', e);
            }
        }
        if (run !== loads) return;
        const settings = parseSettings(stored);
        const url = (settings.apiUrl || env.apiUrl || '').trim();
        const token = (settings.apiToken || env.apiToken || '').trim();
        set({ settings, env, dataDir });
        void get().loadSkills();

        if (url && token) {
            const client = new Api({ baseUrl: url, token });
            const pages = await PageSync.open(
                client,
                pageSyncHooks(set, client.baseUrl, () => isActive(client)),
            );
            if (run !== loads) {
                pages.close();
                return;
            }
            setBackend({ api: client, pages });
            set({
                mode: 'api',
                api: { state: 'connecting', url: client.baseUrl },
                conversations: {},
                ...pageState(pages.list()),
                docsError: null,
                trash: [],
                automations: [],
                deploys: [],
            });
            await get().refresh();
            if (run === loads) set({ ready: true });
            return;
        }

        setBackend({ api: null, pages: null });
        const [docs, convFiles] = await Promise.all([
            loadLocalDocs(),
            storage.list('conversations'),
        ]);
        const conversations: Record<string, Conversation> = {};
        await Promise.all(
            convFiles
                .filter((f) => f.endsWith('.json'))
                .map(async (f) => {
                    const c = parseConversation(
                        await readJSON<unknown>(`conversations/${f}`, null),
                    );
                    if (c) conversations[c.id] = c;
                    else console.warn(`Skipped conversations/${f}: not a conversation`);
                }),
        );
        if (run !== loads) return;
        set({
            ready: true,
            mode: 'local',
            api: { state: 'off', url: '' },
            ...docs,
            trash: [],
            unsynced: 0,
            automations: [],
            deploys: [],
            conversations,
        });
    },

    async refresh() {
        const client = getApi();
        if (!client) return;
        // Documents come from the local copy; this round brings it up to date with the server.
        const synced = get().reloadFiles();
        try {
            const [convs, automations, deploys] = await Promise.all([
                client.listConversations(),
                client.listAutomations(),
                client.listDeploys(),
            ]);
            if (!isActive(client)) return;
            set((s) => {
                const conversations: Record<string, Conversation> = {};
                for (const c of convs) {
                    if (deletedConversations.has(c.id)) continue;
                    conversations[c.id] = fromApiConversation(c, s.conversations[c.id]);
                }
                for (const [id, c] of Object.entries(s.conversations)) {
                    if ((c.streaming || c.offline) && !conversations[id]) conversations[id] = c;
                }
                return {
                    conversations,
                    automations,
                    deploys,
                    api: { state: 'ok', url: client.baseUrl },
                };
            });
        } catch (e) {
            if (isActive(client))
                set({ api: { state: 'error', url: client.baseUrl, error: describeError(e) } });
        }
        await synced;
    },
}));

/** The `limit` most recently active conversations, newest first. */
export const recentConversations = (all: Record<string, Conversation>, limit = 10) =>
    Object.values(all)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);

/** Selects the ids of the `limit` most recent conversations. Under `useShallow` a list re-renders
 *  only when its order or membership changes, not on every token a reply streams in. */
export const recentIds = (limit: number) => (s: DataState) =>
    recentConversations(s.conversations, limit).map((c) => c.id);
