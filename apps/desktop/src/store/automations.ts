import { getApi, isActive } from './backend';
import type { AutomationsSlice, Slice } from './state';

export const automationsSlice: Slice<AutomationsSlice> = (set, get) => ({
    automations: [],
    deploys: [],

    async loadAutomations() {
        const api = getApi();
        if (!api) return;
        const [automations, deploys] = await Promise.all([
            api.listAutomations(),
            api.listDeploys(),
        ]);
        if (isActive(api)) set({ automations, deploys });
    },

    async setAutomationEnabled(id, enabled) {
        const api = getApi();
        if (!api) return;
        const updated = await api.setAutomationEnabled(id, enabled);
        set((s) => ({
            automations: s.automations.map((a) =>
                a.id === id ? { ...updated, lastRun: a.lastRun ?? null } : a,
            ),
        }));
    },

    async deleteAutomation(id) {
        const api = getApi();
        if (!api) return;
        await api.deleteAutomation(id);
        set((s) => ({ automations: s.automations.filter((a) => a.id !== id) }));
    },

    async triggerAutomation(id) {
        const api = getApi();
        if (!api) return;
        const run = await api.triggerAutomation(id);
        set((s) => ({
            automations: s.automations.map((a) =>
                a.id === id ? { ...a, lastRunAt: run.startedAt, lastRun: run } : a,
            ),
        }));
    },

    async decideDeploy(id, approve) {
        const api = getApi();
        if (!api) return;
        if (approve) await api.approveDeploy(id);
        else await api.rejectDeploy(id);
        await get().loadAutomations();
    },
});
