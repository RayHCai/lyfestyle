import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from './store/app';
import { useData } from './store/data';
import { initAgent } from './lib/agent';
import { describeError } from './lib/api';
import { pollNotifications } from './lib/notifications';
import { startRunner } from './lib/runner';
import { getApi } from './store/backend';
import { isWeb } from './lib/tauri';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Tabs from './components/Tabs';
import Console, { focusConsole } from './components/Console';
import Confirm from './components/Confirm';
import ErrorBoundary from './components/ErrorBoundary';
import Home from './pages/Home';
import ConversationPage from './pages/Conversation';
import Conversations from './pages/Conversations';
import Documents from './pages/Documents';
import Automations from './pages/Automations';
import PageViews from './pages/PageViews';
import SettingsPage from './pages/Settings';

/** Below this width the rail would crowd the page, so the sidebar becomes a drawer. */
const COMPACT = '(max-width: 900px)';

export default function App() {
    const ready = useData((s) => s.ready);
    const load = useData((s) => s.load);
    const mode = useData((s) => s.mode);
    const apiUrl = useData((s) => s.api.url);
    const view = useApp((s) => s.view);
    const sidebarOpen = useApp((s) => s.sidebarOpen);
    const compact = useApp((s) => s.compact);
    const setConsole = useApp((s) => s.setConsole);
    const setSidebar = useApp((s) => s.setSidebar);
    const setCompact = useApp((s) => s.setCompact);
    const notice = useData((s) => s.notice);
    const notify = useData((s) => s.notify);
    /** Why startup failed (an unreadable data folder, say), shown with a retry. */
    const [failed, setFailed] = useState<string | null>(null);
    /** Bumped by that retry, which starts over. */
    const [boots, setBoots] = useState(0);

    useEffect(() => {
        let alive = true;
        load()
            .then(async () => {
                await initAgent();
                if (import.meta.env.MODE === 'screenshot')
                    await (await import('./lib/preview')).applyPreview();
            })
            .catch((e: unknown) => {
                if (alive) setFailed(describeError(e));
            });
        return () => {
            alive = false;
        };
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `boots` changing is the retry
    }, [load, boots]);

    useEffect(() => {
        if (!ready || mode !== 'api') return;
        const refresh = () => void useData.getState().refresh();
        const t = setInterval(refresh, 45_000);
        // Push documents edited offline as soon as the network is back.
        window.addEventListener('online', refresh);
        void pollNotifications();
        const n = setInterval(() => void pollNotifications(), 20_000);
        return () => {
            clearInterval(t);
            clearInterval(n);
            window.removeEventListener('online', refresh);
        };
    }, [ready, mode]);

    // API mode: this app is the runner for its own chat turns, through the local harness.
    useEffect(() => {
        const client = getApi();
        if (!ready || mode !== 'api' || !client) return;
        return startRunner(client);
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new API URL means a new client to claim from
    }, [ready, mode, apiUrl]);

    useEffect(() => {
        const mq = window.matchMedia(COMPACT);
        const apply = () => setCompact(mq.matches);
        apply();
        mq.addEventListener('change', apply);
        return () => mq.removeEventListener('change', apply);
    }, [setCompact]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key.toLowerCase();
            // In-app only: no system-wide shortcut, so Ctrl K in other apps is left alone.
            if (mod && !e.altKey && k === 'k') {
                e.preventDefault();
                if (useApp.getState().consoleOpen) setConsole(false);
                else focusConsole();
            } else if (mod && !e.altKey && k === 't') {
                e.preventDefault();
                focusConsole();
            } else if (mod && k === 'w') {
                e.preventDefault();
                const s = useApp.getState();
                s.closeTab(s.active);
            } else if (mod && !e.altKey && /^[1-9]$/.test(e.key)) {
                // Ctrl 1-8 picks that tab, Ctrl 9 the last one, as in a browser.
                e.preventDefault();
                const s = useApp.getState();
                const n = Number(e.key);
                const tab = n === 9 ? s.tabs[s.tabs.length - 1] : s.tabs[n - 1];
                if (tab) s.activateTab(tab.key);
            } else if (e.ctrlKey && e.key === 'Tab') {
                e.preventDefault();
                useApp.getState().cycleTab(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                const s = useApp.getState();
                if (s.consoleOpen) setConsole(false);
                else if (s.compact && s.sidebarOpen) setSidebar(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setConsole, setSidebar]);

    const key = view.name + ('id' in view && view.id ? ':' + view.id : '');
    let page: ReactNode = null;
    if (ready && isWeb && mode !== 'api') {
        // The web build has no local files to fall back on: it needs the API first.
        page = <SettingsPage />;
    } else if (ready) {
        switch (view.name) {
            case 'home':
                page = <Home />;
                break;
            case 'conversation':
                page = isWeb ? <Home /> : <ConversationPage id={view.id} />;
                break;
            case 'conversations':
                page = isWeb ? <Home /> : <Conversations />;
                break;
            case 'documents':
                page = <Documents id={view.id} />;
                break;
            case 'automations':
                page = <Automations />;
                break;
            case 'pageviews':
                page = <PageViews />;
                break;
            case 'settings':
                page = <SettingsPage />;
                break;
        }
    }

    const shell =
        'app' + (sidebarOpen ? ' rail-open' : ' rail-closed') + (compact ? ' compact' : '');
    if (failed)
        return (
            <div className={shell}>
                <Titlebar />
                <main className="view">
                    <div className="page">
                        <div className="page-narrow">
                            <p className="eyebrow">startup</p>
                            <p className="err select-text">Lyfestyle could not load: {failed}</p>
                            <button
                                className="btn"
                                onClick={() => {
                                    setFailed(null);
                                    setBoots((n) => n + 1);
                                }}
                            >
                                retry
                            </button>
                        </div>
                    </div>
                </main>
            </div>
        );
    return (
        <div className={shell}>
            <Titlebar />
            <Sidebar />
            <Tabs />
            <main className="view enter" key={key}>
                {notice && (
                    <div className="notice err select-text" role="alert">
                        <span>{notice}</span>
                        <button className="x" aria-label="Dismiss" onClick={() => notify(null)}>
                            ×
                        </button>
                    </div>
                )}
                <ErrorBoundary>{page}</ErrorBoundary>
            </main>
            <Console />
            <Confirm />
        </div>
    );
}
