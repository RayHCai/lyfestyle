import { useShallow } from 'zustand/shallow';
import { useApp } from '../store/app';
import { recentIds, useData } from '../store/data';
import { removeConversation } from '../lib/actions';
import { isWeb } from '../lib/tauri';
import { relativeTime } from '../lib/time';
import { icons } from './icons';

const recent = recentIds(12);

/** A recent conversation: opens on click, the trash can deletes it after asking. */
function Recent({ id }: { id: string }) {
    const title = useData((s) => s.conversations[id]?.title ?? '');
    // The label, not the timestamp, so a streaming reply re-renders the row once a minute at most.
    const ago = useData((s) => relativeTime(s.conversations[id]?.updatedAt ?? 0));
    const active = useApp((s) => s.view.name === 'conversation' && s.view.id === id);
    const navigate = useApp((s) => s.navigate);
    return (
        <div className={'nav-conv' + (active ? ' active' : '')}>
            <button
                className="open"
                onClick={() => navigate({ name: 'conversation', id })}
                title={title}
            >
                <span className="mark" aria-hidden="true">
                    &gt;
                </span>
                <span className="t">{title}</span>
                <span className="m">{ago}</span>
            </button>
            <button
                className="x"
                aria-label={`Delete "${title}"`}
                title="Delete"
                onClick={() => void removeConversation(id)}
            >
                {icons.trash}
            </button>
        </div>
    );
}

export default function Sidebar() {
    const open = useApp((s) => s.sidebarOpen);
    const compact = useApp((s) => s.compact);
    const setSidebar = useApp((s) => s.setSidebar);
    const navigate = useApp((s) => s.navigate);
    const viewName = useApp((s) => s.view.name);
    const convCount = useData((s) => Object.keys(s.conversations).length);
    const docCount = useData((s) => s.docs.length);
    const autoCount = useData((s) => s.automations.length);
    const ids = useData(useShallow(recent));
    const is = (name: string) => viewName === name;

    return (
        <>
            <div
                className={'scrim' + (compact && open ? ' on' : '')}
                role="presentation"
                onClick={() => setSidebar(false)}
            />
            <div className="sidebar-slot">
                <aside className="sidebar" aria-hidden={!open} inert={!open}>
                    <nav className="nav" aria-label="Sections">
                        {/* One row for both: the label opens the list, "+" starts a new one. */}
                        {!isWeb && (
                            <div
                                className={
                                    'nav-conv nav-merge' +
                                    (is('conversations') || is('home') ? ' active' : '')
                                }
                            >
                                <button
                                    className="open"
                                    onClick={() => navigate({ name: 'conversations' })}
                                >
                                    <span className="mark" aria-hidden="true">
                                        &gt;
                                    </span>
                                    <span className="t">conversations</span>
                                    <span className="count">{convCount}</span>
                                </button>
                                <button
                                    className="x"
                                    aria-label="New conversation"
                                    title="New conversation"
                                    onClick={() => navigate({ name: 'home' })}
                                >
                                    +
                                </button>
                            </div>
                        )}
                        <button
                            className={'nav-item' + (is('documents') ? ' active' : '')}
                            onClick={() => navigate({ name: 'documents' })}
                        >
                            <span className="mark" aria-hidden="true">
                                &gt;
                            </span>
                            <span className="t">documents</span>
                            <span className="count">{docCount}</span>
                        </button>
                        <button
                            className={'nav-item' + (is('automations') ? ' active' : '')}
                            onClick={() => navigate({ name: 'automations' })}
                        >
                            <span className="mark" aria-hidden="true">
                                &gt;
                            </span>
                            <span className="t">automations</span>
                            <span className="count">{autoCount}</span>
                        </button>
                        <button
                            className={'nav-item' + (is('pageviews') ? ' active' : '')}
                            onClick={() => navigate({ name: 'pageviews' })}
                        >
                            <span className="mark" aria-hidden="true">
                                &gt;
                            </span>
                            <span className="t">page views</span>
                        </button>
                    </nav>
                    {!isWeb && (
                        <>
                            <div className="nav-label">recent</div>
                            <div className="nav-recent">
                                {ids.length === 0 && <div className="sb-empty">nothing yet</div>}
                                {ids.map((id) => (
                                    <Recent key={id} id={id} />
                                ))}
                            </div>
                        </>
                    )}
                    <div className="sb-foot">
                        <button
                            className={'nav-item' + (is('settings') ? ' active' : '')}
                            onClick={() => navigate({ name: 'settings' })}
                        >
                            <span className="mark" aria-hidden="true">
                                &gt;
                            </span>
                            <span className="t">settings</span>
                        </button>
                    </div>
                </aside>
            </div>
        </>
    );
}
