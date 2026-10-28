import { describeError } from '../lib/api';
import { writeJSON } from '../lib/storage';
import { call, isTauri } from '../lib/tauri';
import { defaultSettings, type AgentEnv, type Skill } from '../lib/types';
import { getApi } from './backend';
import type { SettingsSlice, Slice } from './state';

/** What `agent_env` reports outside Tauri, or when it fails. */
export const noEnv: AgentEnv = { harness: null, apiUrl: null, apiToken: null };

export const settingsSlice: Slice<SettingsSlice> = (set, get) => ({
    settings: defaultSettings,
    env: noEnv,
    dataDir: '',
    skills: [],
    skillsError: null,
    todoError: null,

    async loadSkills() {
        if (!isTauri) return;
        try {
            const skills = await call<Skill[]>('skills_load', {
                dir: get().settings.skillsDirectory || null,
            });
            set({ skills, skillsError: null });
        } catch (e) {
            set({ skills: [], skillsError: String(e) });
        }
    },

    async saveSettings(patch) {
        const settings = { ...get().settings, ...patch };
        set({ settings });
        await writeJSON('settings.json', settings);
        if ('skillsDirectory' in patch) await get().loadSkills();
        const client = getApi();
        if ('todoMcpUrl' in patch && client) {
            // API runs get their servers from the API's registry, so the todo server lives there.
            // The URL only goes out when it was typed here: the registry lists a redacted form.
            const url = settings.todoMcpUrl.trim();
            try {
                const existing = (await client.listMcpServers()).find((m) => m.name === 'todo');
                if (existing)
                    await client.updateMcpServer(
                        existing.id,
                        url ? { url, enabled: true } : { enabled: false },
                    );
                else if (url)
                    await client.createMcpServer({
                        name: 'todo',
                        transport: 'http',
                        url,
                        enabled: true,
                    });
                set({ todoError: null });
            } catch (e) {
                set({ todoError: describeError(e) });
            }
        }
        if ('apiUrl' in patch || 'apiToken' in patch) await get().load();
    },
});
