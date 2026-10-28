import { create } from 'zustand';
import type { View } from '../lib/types';

/** An open window in the tab strip. */
export interface Tab {
    /** Stable identity: the view name, plus the conversation id for conversation tabs. */
    key: string;
    view: View;
}

/** One tab per screen, except conversations, which each get their own. Documents select inside
 *  their single tab, so document ids are not part of the key. */
export const tabKey = (view: View): string =>
    view.name === 'conversation' ? 'conversation:' + view.id : view.name;

const HOME: Tab = { key: 'home', view: { name: 'home' } };

interface AppState {
    /** The view of the active tab; what the router renders. */
    view: View;
    tabs: Tab[];
    /** Key of the active tab. */
    active: string;
    /** Wide windows: the rail is expanded beside the page. Compact windows: the drawer is open over it. */
    sidebarOpen: boolean;
    /** The window is too narrow for the rail layout, so the sidebar becomes a drawer. */
    compact: boolean;
    /** The floating console; opening a page, Esc or a click outside it closes it. */
    consoleOpen: boolean;
    /** Unsent replies by conversation id. Here rather than in the page, which remounts on every
     *  tab switch. */
    drafts: Record<string, string>;
    /** Open a view: focus its tab if it has one, otherwise open one beside the active tab. */
    navigate: (view: View) => void;
    activateTab: (key: string) => void;
    closeTab: (key: string) => void;
    /** Move to the next (+1) or previous (-1) tab, wrapping around. */
    cycleTab: (dir: 1 | -1) => void;
    /** Record a selection made inside the active tab (which document) so the
     *  tab reopens on it, without re-rendering the page the way `navigate` would. */
    rememberSelection: (view: View) => void;
    setSidebar: (open: boolean) => void;
    setCompact: (compact: boolean) => void;
    setConsole: (open: boolean) => void;
    /** Sets a conversation's draft; an empty one is dropped. */
    setDraft: (conversationId: string, text: string) => void;
}

export const useApp = create<AppState>((set) => ({
    view: HOME.view,
    tabs: [HOME],
    active: HOME.key,
    // Starts closed in every window size; the titlebar toggle opens it.
    sidebarOpen: false,
    compact: false,
    consoleOpen: false,
    drafts: {},
    // A drawer closes when you pick something in it; the rail stays where it is.
    navigate: (view) =>
        set((s) => {
            const key = tabKey(view);
            const tabs = s.tabs.slice();
            const at = tabs.findIndex((t) => t.key === key);
            if (at >= 0) tabs[at] = { key, view };
            else {
                const cur = tabs.findIndex((t) => t.key === s.active);
                const current = tabs[cur];
                // A fresh home tab becomes whatever is opened from it, like a browser's new-tab
                // page; anything else opens in a new tab beside the current one.
                if (current && current.view.name === 'home') tabs[cur] = { key, view };
                else tabs.splice(cur + 1, 0, { key, view });
            }
            return {
                view,
                tabs,
                active: key,
                consoleOpen: false,
                sidebarOpen: s.compact ? false : s.sidebarOpen,
            };
        }),
    activateTab: (key) =>
        set((s) => {
            const tab = s.tabs.find((t) => t.key === key);
            return tab ? { view: tab.view, active: key } : {};
        }),
    closeTab: (key) =>
        set((s) => {
            const at = s.tabs.findIndex((t) => t.key === key);
            if (at < 0) return {};
            const tabs = s.tabs.filter((t) => t.key !== key);
            if (tabs.length === 0) tabs.push(HOME);
            if (s.active !== key) return { tabs };
            const next = tabs[Math.min(at, tabs.length - 1)] ?? HOME;
            return { tabs, active: next.key, view: next.view };
        }),
    cycleTab: (dir) =>
        set((s) => {
            if (s.tabs.length < 2) return {};
            const at = s.tabs.findIndex((t) => t.key === s.active);
            const next = s.tabs[(at + dir + s.tabs.length) % s.tabs.length];
            return next ? { active: next.key, view: next.view } : {};
        }),
    rememberSelection: (view) =>
        set((s) => {
            const key = tabKey(view);
            if (key !== s.active) return {};
            return { tabs: s.tabs.map((t) => (t.key === key ? { key, view } : t)) };
        }),
    setSidebar: (sidebarOpen) => set({ sidebarOpen }),
    // Crossing the breakpoint closes the sidebar, so a drawer never opens over the page by itself.
    setCompact: (compact) =>
        set((s) => (s.compact === compact ? {} : { compact, sidebarOpen: false })),
    setConsole: (consoleOpen) => set({ consoleOpen }),
    setDraft: (conversationId, text) =>
        set((s) => {
            const drafts = { ...s.drafts };
            if (text) drafts[conversationId] = text;
            else delete drafts[conversationId];
            return { drafts };
        }),
}));
