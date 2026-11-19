/**
 * The phone layout of the web build: documents only, one screen at a time. The desktop app never
 * shows it (`MOBILE_CAPABLE` is false there, so the check compiles away); screenshot mode can, so
 * a narrow headless browser can render it.
 */
import { useSyncExternalStore } from 'react';
import type { DocMeta } from './types';
import { isWeb } from './tauri';

/** Phones: narrow portrait, or a touch screen too short for the desktop layout (landscape). */
export const MOBILE_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 500px)';

export const MOBILE_CAPABLE = isWeb || import.meta.env.MODE === 'screenshot';

const subscribe = (onChange: () => void) => {
    const mq = window.matchMedia(MOBILE_QUERY);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
};
const matches = () => window.matchMedia(MOBILE_QUERY).matches;
const never = () => () => {};
const no = () => false;

/** Whether to show the phone layout; follows the window as it resizes or rotates. */
export function useMobile(): boolean {
    return useSyncExternalStore(
        MOBILE_CAPABLE ? subscribe : never,
        MOBILE_CAPABLE ? matches : no,
        no,
    );
}

/** One screen of the phone layout. `edit` opens a document in the editor instead of the reader. */
export type MobileRoute =
    { name: 'list' } | { name: 'trash' } | { name: 'doc'; id: string; edit: boolean };

/** What each history entry holds: the screen, and how many entries this app pushed before it. */
export interface MobileEntry {
    route: MobileRoute;
    depth: number;
}

const KEY = 'lyfestyleMobile';

export const LIST: MobileRoute = { name: 'list' };

/** The entry kept in a `history.state`, or the list at depth 0 for anything else (a fresh load,
 *  or state some other code wrote). History survives a reload, so this is untrusted input. */
export function readEntry(state: unknown): MobileEntry {
    const raw: unknown =
        state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
    if (!raw || typeof raw !== 'object') return { route: LIST, depth: 0 };
    const { route, depth } = raw as { route?: unknown; depth?: unknown };
    const d = typeof depth === 'number' && Number.isInteger(depth) && depth > 0 ? depth : 0;
    if (!route || typeof route !== 'object') return { route: LIST, depth: d };
    const r = route as Record<string, unknown>;
    if (r.name === 'trash') return { route: { name: 'trash' }, depth: d };
    if (r.name === 'doc' && typeof r.id === 'string' && r.id)
        return { route: { name: 'doc', id: r.id, edit: r.edit === true }, depth: d };
    return { route: LIST, depth: d };
}

/** The `history.state` value for an entry. */
export const writeEntry = (entry: MobileEntry) => ({ [KEY]: entry });

/** Documents whose title contains every word of `query`, ignoring case. */
export function filterDocs<T extends Pick<DocMeta, 'title'>>(docs: T[], query: string): T[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return docs;
    return docs.filter((d) => {
        const title = (d.title || 'Untitled').toLowerCase();
        return words.every((w) => title.includes(w));
    });
}
