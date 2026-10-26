import { create } from 'zustand';
import type { View } from '../lib/types';

interface AppState {
    view: View;
    sidebarOpen: boolean;
    /** Pinned = opened by click; it stays until dismissed. Unpinned = peeked by hover; it closes when the pointer leaves. */
    sidebarPinned: boolean;
    consoleOpen: boolean;
    navigate: (view: View) => void;
    setSidebar: (open: boolean, pinned?: boolean) => void;
    setConsole: (open: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
    view: { name: 'home' },
    sidebarOpen: false,
    sidebarPinned: false,
    consoleOpen: false,
    navigate: (view) => set({ view, sidebarOpen: false, sidebarPinned: false, consoleOpen: false }),
    setSidebar: (sidebarOpen, pinned = true) =>
        set({ sidebarOpen, sidebarPinned: sidebarOpen && pinned }),
    setConsole: (consoleOpen) => set({ consoleOpen }),
}));

let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** Hover behaviour shared by the menu button and the floating panel. */
export const sidebarHover = {
    enter() {
        clearTimeout(closeTimer);
        const s = useApp.getState();
        if (!s.sidebarOpen) s.setSidebar(true, false);
    },
    stay() {
        clearTimeout(closeTimer);
    },
    leave() {
        clearTimeout(closeTimer);
        const s = useApp.getState();
        if (!s.sidebarOpen || s.sidebarPinned) return;
        closeTimer = setTimeout(() => {
            const t = useApp.getState();
            if (t.sidebarOpen && !t.sidebarPinned) t.setSidebar(false);
        }, 320);
    },
};
