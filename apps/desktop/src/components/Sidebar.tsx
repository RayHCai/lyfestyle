import { sidebarHover, useApp } from '../store/app';
import { recentConversations, useData } from '../store/data';
import { icons } from './icons';

export default function Sidebar() {
    const open = useApp((s) => s.sidebarOpen);
    const setSidebar = useApp((s) => s.setSidebar);
    const navigate = useApp((s) => s.navigate);
    const view = useApp((s) => s.view);
    const conversations = useData((s) => s.conversations);
    const recent = recentConversations(conversations, 10);
    const is = (name: string) => view.name === name;

    return (
        <>
            <div
                className={'scrim' + (open ? ' on' : '')}
                role="presentation"
                onClick={() => setSidebar(false)}
            />
            <div
                className="sidebar-hover"
                role="presentation"
                onMouseEnter={sidebarHover.stay}
                onMouseLeave={sidebarHover.leave}
            >
                <aside className={'sidebar' + (open ? ' on' : '')} aria-hidden={!open}>
                    <button
                        className={'sb-item' + (is('home') ? ' active' : '')}
                        onClick={() => navigate({ name: 'home' })}
                    >
                        {icons.compose}
                        <span className="t">New conversation</span>
                    </button>
                    <div className="sb-section">Recent</div>
                    {recent.length === 0 && <div className="sb-empty">Nothing yet</div>}
                    {recent.map((c) => (
                        <button
                            key={c.id}
                            className={
                                'sb-item sb-conv' +
                                (view.name === 'conversation' && view.id === c.id ? ' active' : '')
                            }
                            onClick={() => navigate({ name: 'conversation', id: c.id })}
                            title={c.title}
                        >
                            <span className="t">{c.title}</span>
                        </button>
                    ))}
                    <button
                        className="sb-item sb-more"
                        onClick={() => navigate({ name: 'conversations' })}
                    >
                        <span className="t">All conversations</span>
                    </button>
                    <div className="sb-gap" />
                    <div className="sb-foot">
                        <button
                            className={'sb-item' + (is('documents') ? ' active' : '')}
                            onClick={() => navigate({ name: 'documents' })}
                        >
                            {icons.doc}
                            <span className="t">Documents</span>
                        </button>
                        <button
                            className={'sb-item' + (is('automations') ? ' active' : '')}
                            onClick={() => navigate({ name: 'automations' })}
                        >
                            {icons.auto}
                            <span className="t">Automations</span>
                        </button>
                        <button
                            className={'sb-item' + (is('settings') ? ' active' : '')}
                            onClick={() => navigate({ name: 'settings' })}
                        >
                            {icons.settings}
                            <span className="t">Settings</span>
                        </button>
                    </div>
                </aside>
            </div>
        </>
    );
}
