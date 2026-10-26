// Only reachable when Vite runs with `--mode screenshot`; the import in App.tsx is compiled out otherwise.
// Lets a headless browser open any surface directly: #view=settings, #sidebar, #console, #seed.
import { useApp } from '../store/app';
import { recentConversations, useData } from '../store/data';
import type { View } from './types';

const sampleReply = `Here is a short plan for the week.

## Monday
Review the **quarterly notes** and draft the summary. Keep it under a page.

## Tuesday
- Call the studio about the print run
- Move the sketches into the shared folder

> Small steps, taken daily, compound faster than anyone expects.

Let me know if you want this turned into an automation.`;

let applied = false;

export async function applyPreview(): Promise<void> {
    if (applied) return; // StrictMode runs the mount effect twice in dev
    applied = true;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('api'))
        await useData
            .getState()
            .saveSettings({ apiUrl: p.get('api') ?? '', apiToken: p.get('token') ?? '' });
    const data = useData.getState();
    const app = useApp.getState();
    let convId: string | undefined = recentConversations(data.conversations, 1)[0]?.id;
    let docId: string | undefined = data.docs[0]?.id;

    if (p.has('seed')) {
        await data.saveSettings({ name: 'Hunter' });
        const titles = [
            'Plan the week',
            'Draft the studio email',
            'Summarise quarterly notes',
            'Trip packing list',
            'Reading list for autumn',
        ];
        for (const [i, t] of titles.entries()) {
            const c = await data.createConversation(t);
            data.updateConversation(c.id, (x) => ({
                ...x,
                updatedAt: Date.now() - i * 3_600_000 * 5,
                messages: [
                    {
                        id: c.id + 'u',
                        role: 'user',
                        content: 'Help me ' + t.toLowerCase() + '.',
                        createdAt: Date.now(),
                    },
                    {
                        id: c.id + 'a',
                        role: 'assistant',
                        content: sampleReply,
                        createdAt: Date.now(),
                        tools: i === 0 ? ['Read', 'Write'] : undefined,
                    },
                ],
            }));
            if (i === 0) convId = c.id;
        }
        const d = await data.createDoc('Weekly review');
        await data.writeDoc(
            d.id,
            '# Weekly review\n\nA few notes from this week, kept short.\n\n## What moved\n\n- The desktop app now runs against local Claude Code\n- Documents save as plain markdown\n\n## What is next\n\n1. Floating sidebar\n2. Notion-style spacing\n\n> Keep the chrome quiet and let the type carry it.',
        );
        await data.createDoc('Reading notes');
        await data.createDoc('Studio contacts');
        docId = d.id;
        await data.saveAutomation({
            id: 'auto-1',
            name: 'Morning briefing',
            prompt: 'Summarise my documents folder and list anything that looks like a todo.',
            trigger: { type: 'daily', time: '08:00' },
            enabled: true,
            createdAt: Date.now(),
        });
        await data.saveAutomation({
            id: 'auto-2',
            name: 'Inbox sweep',
            prompt: 'Check for new files and file them.',
            trigger: { type: 'interval', minutes: 120 },
            enabled: false,
            createdAt: Date.now(),
        });
    }

    const v = p.get('view');
    if (v) {
        const views: Record<string, View> = {
            conversation: { name: 'conversation', id: convId ?? '' },
            conversations: { name: 'conversations' },
            documents: { name: 'documents', id: docId },
            automations: { name: 'automations', id: data.automations[0]?.id ?? 'auto-1' },
            settings: { name: 'settings' },
        };
        const target = views[v];
        if (target) app.navigate(target);
    }
    if (p.has('sidebar')) app.setSidebar(true, true);
    if (p.has('console')) app.setConsole(true);
}
