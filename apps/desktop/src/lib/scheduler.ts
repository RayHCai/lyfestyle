/** Local mode: runs enabled automations while the app is open. Each run becomes a conversation. */
import { useData } from '../store/data';
import { sendMessage } from './agent';
import type { Automation } from './types';

export function nextRun(a: Automation, from = Date.now()): number | undefined {
    if (a.trigger.type === 'interval') return from + Math.max(1, a.trigger.minutes) * 60_000;
    if (a.trigger.type === 'daily') {
        const [h, m] = a.trigger.time.split(':').map(Number);
        const d = new Date(from);
        d.setHours(h || 0, m || 0, 0, 0);
        if (d.getTime() <= from) d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    return undefined;
}

export function describe(a: Automation): string {
    if (a.trigger.type === 'interval') {
        const n = a.trigger.minutes;
        return n >= 60 && n % 60 === 0 ? `every ${n / 60} h` : `every ${n} min`;
    }
    if (a.trigger.type === 'daily') return `daily at ${a.trigger.time}`;
    if (a.trigger.type === 'cron') return a.trigger.expr;
    return 'manual';
}

export async function runAutomation(a: Automation): Promise<string> {
    const data = useData.getState();
    const c = await data.createConversation(a.name, 'automation');
    const now = Date.now();
    await data.saveAutomation({
        ...a,
        lastRunAt: now,
        nextRunAt: nextRun(a, now),
        lastConversationId: c.id,
    });
    await sendMessage(c.id, a.prompt);
    return c.id;
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startScheduler() {
    if (timer) return;
    const tick = async () => {
        const { automations, saveAutomation, conversations, mode } = useData.getState();
        if (mode !== 'local') return;
        const now = Date.now();
        for (const a of automations) {
            if (!a.enabled || (a.trigger.type !== 'daily' && a.trigger.type !== 'interval'))
                continue;
            if (!a.nextRunAt) {
                await saveAutomation({ ...a, nextRunAt: nextRun(a, now) });
                continue;
            }
            const busy = a.lastConversationId && conversations[a.lastConversationId]?.streaming;
            if (a.nextRunAt <= now && !busy) await runAutomation(a);
        }
    };
    timer = setInterval(() => {
        void tick();
    }, 30_000);
    void tick();
}

export function stopScheduler() {
    if (timer) clearInterval(timer);
    timer = undefined;
}
