import { useEffect, type ReactNode } from 'react';
import { useApp } from './store/app';
import { useData } from './store/data';
import { initAgent } from './lib/agent';
import { startScheduler, stopScheduler } from './lib/scheduler';
import { onEvent } from './lib/tauri';
import Aurora from './components/Aurora';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Console from './components/Console';
import Home from './pages/Home';
import ConversationPage from './pages/Conversation';
import Conversations from './pages/Conversations';
import Documents from './pages/Documents';
import Automations from './pages/Automations';
import SettingsPage from './pages/Settings';

export default function App() {
    const ready = useData((s) => s.ready);
    const load = useData((s) => s.load);
    const mode = useData((s) => s.mode);
    const view = useApp((s) => s.view);
    const setConsole = useApp((s) => s.setConsole);
    const setSidebar = useApp((s) => s.setSidebar);

    useEffect(() => {
        let un: (() => void) | undefined;
        void load().then(async () => {
            await initAgent();
            un = await onEvent('console:open', () => setConsole(true));
            if (import.meta.env.MODE === 'screenshot')
                await (await import('./lib/preview')).applyPreview();
        });
        return () => un?.();
    }, [load, setConsole]);

    useEffect(() => {
        if (!ready) return;
        if (mode === 'local') {
            startScheduler();
            return () => stopScheduler();
        }
        const t = setInterval(() => {
            void useData.getState().refresh();
        }, 45_000);
        return () => clearInterval(t);
    }, [ready, mode]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setConsole(!useApp.getState().consoleOpen);
            } else if (e.key === 'Escape') {
                const { consoleOpen, sidebarOpen } = useApp.getState();
                if (consoleOpen) setConsole(false);
                else if (sidebarOpen) setSidebar(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setConsole, setSidebar]);

    const key = view.name + ('id' in view && view.id ? ':' + view.id : '');
    let page: ReactNode = null;
    if (ready) {
        switch (view.name) {
            case 'home':
                page = <Home />;
                break;
            case 'conversation':
                page = <ConversationPage id={view.id} />;
                break;
            case 'conversations':
                page = <Conversations />;
                break;
            case 'documents':
                page = <Documents id={view.id} />;
                break;
            case 'automations':
                page = <Automations id={view.id} />;
                break;
            case 'settings':
                page = <SettingsPage />;
                break;
        }
    }

    return (
        <div className="app">
            <Aurora />
            <Titlebar />
            <Sidebar />
            <main className="view enter" key={key}>
                {page}
            </main>
            <Console />
        </div>
    );
}
