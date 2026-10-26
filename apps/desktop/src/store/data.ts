import { create } from 'zustand';
import { readJSON, writeJSON, storage } from '../lib/storage';
import { call, isTauri } from '../lib/tauri';
import { id as newId } from '../lib/util';
import {
    Api,
    describeError,
    type ApiConversation,
    type ApiJob,
    type ApiPageSummary,
    type ApiRun,
} from '../lib/api';
import {
    defaultSettings,
    type AgentEnv,
    type Automation,
    type Conversation,
    type DocMeta,
    type RunSummary,
    type Settings,
    type Trigger,
} from '../lib/types';

export type Mode = 'local' | 'api';
export interface ApiStatus {
    state: 'off' | 'connecting' | 'ok' | 'error';
    url: string;
    error?: string;
}

interface DataState {
    ready: boolean;
    settings: Settings;
    env: AgentEnv;
    dataDir: string;
    /** `local`: flat files plus a locally spawned agent. `api`: the Lyfestyle API holds everything. */
    mode: Mode;
    api: ApiStatus;
    conversations: Record<string, Conversation>;
    docs: DocMeta[];
    automations: Automation[];

    load: () => Promise<void>;
    /** API mode: re-fetch the lists. Keeps in-flight streams and loaded transcripts. */
    refresh: () => Promise<void>;
    saveSettings: (patch: Partial<Settings>) => Promise<void>;

    createConversation: (title: string, source?: Conversation['source']) => Promise<Conversation>;
    updateConversation: (id: string, fn: (c: Conversation) => Conversation) => void;
    persistConversation: (id: string) => Promise<void>;
    deleteConversation: (id: string) => Promise<void>;

    createDoc: (title?: string) => Promise<DocMeta>;
    renameDoc: (id: string, title: string) => Promise<void>;
    deleteDoc: (id: string) => Promise<void>;
    readDoc: (id: string) => Promise<string>;
    writeDoc: (id: string, markdown: string) => Promise<void>;

    saveAutomation: (a: Automation) => Promise<Automation>;
    deleteAutomation: (id: string) => Promise<void>;
    /** API mode: queue a run of the job now. */
    triggerAutomation: (id: string) => Promise<void>;
    /** API mode: fetch the last run's status and output. */
    loadLastRun: (id: string) => Promise<void>;
}

const convKey = (id: string) => `conversations/${id}.json`;
const docKey = (id: string) => `documents/${id}.md`;
const noEnv: AgentEnv = { harness: null, platform: 'browser', apiUrl: null, apiToken: null };

let api: Api | null = null;
/** The API client while in API mode, else null. */
export const getApi = () => api;

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Date.now());
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function fromApiConversation(c: ApiConversation, prev?: Conversation): Conversation {
    return {
        messages: [],
        loaded: false,
        ...prev,
        id: c.id,
        title: c.title || 'Untitled',
        createdAt: ms(c.createdAt),
        updatedAt: Math.max(ms(c.updatedAt), prev?.streaming ? prev.updatedAt : 0),
        source: 'chat',
        offline: false,
    };
}

const fromPage = (p: ApiPageSummary): DocMeta => ({
    id: p.id,
    title: p.title,
    createdAt: ms(p.createdAt),
    updatedAt: ms(p.updatedAt),
});

/** Reads the three shapes the UI can edit back out of a cron string; anything else stays raw cron. */
export function triggerFromSchedule(schedule: string): Trigger {
    const s = schedule.trim();
    let m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s);
    if (m) return { type: 'daily', time: `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}` };
    m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(s);
    if (m) return { type: 'interval', minutes: Number(m[1]) };
    m = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(s);
    if (m) return { type: 'interval', minutes: Number(m[1]) * 60 };
    return { type: 'cron', expr: s };
}

export function scheduleFromTrigger(t: Trigger): string {
    if (t.type === 'daily') {
        const [h, m] = t.time.split(':').map(Number);
        return `${m || 0} ${h || 0} * * *`;
    }
    if (t.type === 'interval') {
        const n = Math.max(1, Math.round(t.minutes));
        return n < 60 ? `*/${n} * * * *` : `0 */${Math.max(1, Math.round(n / 60))} * * *`;
    }
    if (t.type === 'cron') return t.expr.trim();
    return '0 9 * * *'; // "manual" has no API equivalent; the job is saved paused and run by hand
}

function runSummary(
    r: Pick<ApiRun, 'id' | 'status' | 'createdAt' | 'finishedAt'> & Partial<ApiRun>,
): RunSummary {
    return {
        id: r.id,
        status: r.status,
        createdAt: ms(r.createdAt),
        finishedAt: r.finishedAt ? ms(r.finishedAt) : undefined,
        output: r.output ?? undefined,
        error: r.error ?? undefined,
    };
}

function fromJob(j: ApiJob, prev?: Automation): Automation {
    const last = j.lastRun ?? j.recentRuns?.[0] ?? null;
    const lastRun = last
        ? {
              ...runSummary(last),
              ...(prev?.lastRun?.id === last.id
                  ? { output: prev.lastRun.output, error: prev.lastRun.error }
                  : {}),
          }
        : undefined;
    return {
        id: j.id,
        name: j.name,
        prompt: j.prompt,
        trigger: triggerFromSchedule(j.schedule),
        timezone: j.timezone,
        enabled: j.enabled,
        createdAt: ms(j.createdAt),
        lastRunAt: j.lastRunAt ? ms(j.lastRunAt) : undefined,
        nextRunAt: j.nextRunAt ? ms(j.nextRunAt) : undefined,
        lastRun,
    };
}

const toJobInput = (a: Automation) => ({
    name: a.name,
    prompt: a.prompt,
    schedule: scheduleFromTrigger(a.trigger),
    timezone: a.timezone ?? localTimeZone(),
    enabled: a.trigger.type === 'manual' ? false : a.enabled,
});

export const useData = create<DataState>((set, get) => ({
    ready: false,
    settings: defaultSettings,
    env: noEnv,
    dataDir: '',
    mode: 'local',
    api: { state: 'off', url: '' },
    conversations: {},
    docs: [],
    automations: [],

    async load() {
        const [stored, dataDir] = await Promise.all([
            readJSON<Settings>('settings.json', defaultSettings),
            storage.dir(),
        ]);
        let env: AgentEnv = noEnv;
        if (isTauri) {
            try {
                env = { ...noEnv, ...(await call<AgentEnv>('agent_env')) };
            } catch {
                /* keep default */
            }
        }
        const settings = { ...defaultSettings, ...stored };
        const url = (settings.apiUrl || env.apiUrl || '').trim();
        const token = (settings.apiToken || env.apiToken || '').trim();
        set({ settings, env, dataDir });

        if (url && token) {
            api = new Api({ baseUrl: url, token });
            set({
                mode: 'api',
                api: { state: 'connecting', url: api.baseUrl },
                conversations: {},
                docs: [],
                automations: [],
            });
            await get().refresh();
            set({ ready: true });
            return;
        }

        api = null;
        const [docs, automations, convFiles] = await Promise.all([
            readJSON<DocMeta[]>('documents/index.json', []),
            readJSON<Automation[]>('automations.json', []),
            storage.list('conversations'),
        ]);
        const conversations: Record<string, Conversation> = {};
        await Promise.all(
            convFiles
                .filter((f) => f.endsWith('.json'))
                .map(async (f) => {
                    const c = await readJSON<Conversation | null>(`conversations/${f}`, null);
                    if (c && c.id) conversations[c.id] = { ...c, streaming: false };
                }),
        );
        set({
            ready: true,
            mode: 'local',
            api: { state: 'off', url: '' },
            docs: docs.sort((a, b) => b.updatedAt - a.updatedAt),
            automations,
            conversations,
        });
    },

    async refresh() {
        if (!api) return;
        const client = api;
        try {
            const [convs, pages, jobs] = await Promise.all([
                client.listConversations(),
                client.listPages(),
                client.listJobs(),
            ]);
            set((s) => {
                const conversations: Record<string, Conversation> = {};
                for (const c of convs)
                    conversations[c.id] = fromApiConversation(c, s.conversations[c.id]);
                for (const [id, c] of Object.entries(s.conversations)) {
                    if ((c.streaming || c.offline) && !conversations[id]) conversations[id] = c;
                }
                return {
                    conversations,
                    docs: pages.map(fromPage),
                    automations: jobs.map((j) =>
                        fromJob(
                            j,
                            s.automations.find((a) => a.id === j.id),
                        ),
                    ),
                    api: { state: 'ok', url: client.baseUrl },
                };
            });
        } catch (e) {
            set({ api: { state: 'error', url: client.baseUrl, error: describeError(e) } });
        }
    },

    async saveSettings(patch) {
        const settings = { ...get().settings, ...patch };
        set({ settings });
        await writeJSON('settings.json', settings);
        if (isTauri && 'globalShortcut' in patch) {
            try {
                await call('set_global_shortcut', { enabled: settings.globalShortcut });
            } catch {
                /* ignore */
            }
        }
        if ('apiUrl' in patch || 'apiToken' in patch) await get().load();
    },

    async createConversation(title, source = 'chat') {
        const now = Date.now();
        if (api) {
            try {
                const c = fromApiConversation(await api.createConversation(title));
                const created = { ...c, loaded: true };
                set((s) => ({ conversations: { ...s.conversations, [created.id]: created } }));
                return created;
            } catch (e) {
                set({ api: { state: 'error', url: api.baseUrl, error: describeError(e) } });
                const c: Conversation = {
                    id: newId(),
                    title,
                    createdAt: now,
                    updatedAt: now,
                    messages: [],
                    source,
                    loaded: true,
                    offline: true,
                };
                set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }));
                return c;
            }
        }
        const c: Conversation = {
            id: newId(),
            title,
            createdAt: now,
            updatedAt: now,
            messages: [],
            source,
        };
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
        if (api) return;
        const c = get().conversations[id];
        if (!c) return;
        const { streaming: _s, stderr: _e, ...rest } = c;
        const messages = rest.messages.map(({ live: _l, ...m }) => m);
        await writeJSON(convKey(id), { ...rest, messages });
    },

    async deleteConversation(id) {
        const wasOffline = get().conversations[id]?.offline;
        set((s) => {
            const next = { ...s.conversations };
            delete next[id];
            return { conversations: next };
        });
        if (api) {
            if (!wasOffline) await api.deleteConversation(id).catch(() => undefined);
            return;
        }
        await storage.del(convKey(id));
    },

    async createDoc(title = 'Untitled') {
        if (api) {
            const meta = fromPage(await api.createPage({ id: newId(), title, content: '' }));
            set((s) => ({ docs: [meta, ...s.docs] }));
            return meta;
        }
        const now = Date.now();
        const meta: DocMeta = { id: newId(), title, createdAt: now, updatedAt: now };
        const docs = [meta, ...get().docs];
        set({ docs });
        await Promise.all([
            storage.write(docKey(meta.id), ''),
            writeJSON('documents/index.json', docs),
        ]);
        return meta;
    },

    async renameDoc(id, title) {
        const docs = get().docs.map((d) =>
            d.id === id ? { ...d, title, updatedAt: Date.now() } : d,
        );
        set({ docs });
        if (api) {
            await api.updatePage(id, { title });
            return;
        }
        await writeJSON('documents/index.json', docs);
    },

    async deleteDoc(id) {
        const docs = get().docs.filter((d) => d.id !== id);
        set({ docs });
        if (api) {
            await api.deletePage(id);
            return;
        }
        await Promise.all([storage.del(docKey(id)), writeJSON('documents/index.json', docs)]);
    },

    async readDoc(id) {
        if (api) return (await api.getPage(id)).content;
        return (await storage.read(docKey(id))) ?? '';
    },

    async writeDoc(id, markdown) {
        const docs = get()
            .docs.map((d) => (d.id === id ? { ...d, updatedAt: Date.now() } : d))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        set({ docs });
        if (api) {
            await api.updatePage(id, { content: markdown });
            return;
        }
        await Promise.all([
            storage.write(docKey(id), markdown),
            writeJSON('documents/index.json', docs),
        ]);
    },

    async saveAutomation(a) {
        const list = get().automations;
        const exists = list.some((x) => x.id === a.id);
        if (api) {
            const job = exists
                ? await api.updateJob(a.id, toJobInput(a))
                : await api.createJob(toJobInput(a));
            const saved = fromJob(
                job,
                list.find((x) => x.id === job.id),
            );
            set((s) => ({
                automations: exists
                    ? s.automations.map((x) => (x.id === saved.id ? saved : x))
                    : [saved, ...s.automations],
            }));
            return saved;
        }
        const automations = exists ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list];
        set({ automations });
        await writeJSON('automations.json', automations);
        return a;
    },

    async deleteAutomation(id) {
        const automations = get().automations.filter((a) => a.id !== id);
        set({ automations });
        if (api) {
            await api.deleteJob(id);
            return;
        }
        await writeJSON('automations.json', automations);
    },

    async triggerAutomation(id) {
        if (!api) return;
        const run = await api.triggerJob(id);
        set((s) => ({
            automations: s.automations.map((a) =>
                a.id === id ? { ...a, lastRunAt: Date.now(), lastRun: runSummary(run) } : a,
            ),
        }));
    },

    async loadLastRun(id) {
        if (!api) return;
        const a = get().automations.find((x) => x.id === id);
        if (!a?.lastRun) return;
        const run = await api.getRun(a.lastRun.id);
        set((s) => ({
            automations: s.automations.map((x) =>
                x.id === id ? { ...x, lastRun: runSummary(run) } : x,
            ),
        }));
    },
}));

export const recentConversations = (all: Record<string, Conversation>, limit = 10) =>
    Object.values(all)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
