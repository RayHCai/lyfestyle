/** API mode: shows new `/notifications` items (sent by automations and agent runs) as system
 *  notifications. The cursor is kept per API URL, so switching servers and back neither replays
 *  old items nor skips the ones that arrived meanwhile. */
import { getApi } from '../store/data';
import type { Api, ApiNotification } from './api';
import { readJSON, writeJSON } from './storage';
import { call, isTauri } from './tauri';

const CURSORS = 'notifications.json';
const PAGE = 100;
/** More than this in one poll collapses the rest into a single summary notification. */
const BURST = 5;

/** The id of the last notification shown, by API base URL. */
export type Cursors = Record<string, number>;

/** The stored cursors. Reads the older single-server `{ url, after }` form too. */
export function parseCursors(raw: unknown): Cursors {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const obj = raw as Record<string, unknown>;
    if (typeof obj.url === 'string' && typeof obj.after === 'number')
        return { [obj.url]: obj.after };
    const out: Cursors = {};
    for (const [url, after] of Object.entries(obj))
        if (typeof after === 'number' && Number.isFinite(after)) out[url] = after;
    return out;
}

async function saveCursor(url: string, after: number) {
    const cursors = parseCursors(await readJSON<unknown>(CURSORS, null));
    await writeJSON(CURSORS, { ...cursors, [url]: after });
}

async function show(title: string, body: string | null) {
    if (isTauri) {
        try {
            await call('notify', { title, body });
        } catch (e) {
            // The poll goes on; the item still counts as seen, so it is not shown twice.
            console.error('Could not show a notification:', e);
        }
        return;
    }
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;
    const shown = new Notification(title, body ? { body } : {});
    shown.addEventListener('click', () => window.focus());
}

/** Everything after `after`, oldest first. */
async function since(api: Api, after: number): Promise<ApiNotification[]> {
    const out: ApiNotification[] = [];
    for (;;) {
        const { items } = await api.notifications(out.at(-1)?.id ?? after, PAGE);
        out.push(...items);
        if (items.length < PAGE) return out;
    }
}

let polling = false;

export async function pollNotifications(): Promise<void> {
    const api = getApi();
    if (!api || polling) return;
    polling = true;
    try {
        const after = parseCursors(await readJSON<unknown>(CURSORS, null))[api.baseUrl];
        if (after === undefined) {
            // First contact with this server: start from its newest instead of replaying history.
            const { latestId } = await api.notifications(null, 1);
            await saveCursor(api.baseUrl, latestId ?? 0);
            return;
        }
        const fresh = await since(api, after);
        const last = fresh.at(-1);
        if (!last) return;
        await saveCursor(api.baseUrl, last.id);
        for (const n of fresh.slice(0, BURST)) {
            await show(n.title || n.source || 'Lyfestyle', n.body ?? n.source);
        }
        if (fresh.length > BURST)
            await show('Lyfestyle', `${fresh.length - BURST} more notifications`);
    } catch {
        // An unreachable API or a failed read; the API refresh already reports an unreachable
        // server, and the next poll tries again from the same cursor.
    } finally {
        polling = false;
    }
}
