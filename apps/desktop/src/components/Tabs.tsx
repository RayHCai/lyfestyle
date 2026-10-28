import { useRef, type KeyboardEvent } from 'react';
import { useApp, type Tab } from '../store/app';
import { useData } from '../store/data';
import { useViewLabel } from '../lib/views';

function TabItem({
    tab,
    on,
    onKeyDown,
}: {
    tab: Tab;
    on: boolean;
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
    const activateTab = useApp((s) => s.activateTab);
    const closeTab = useApp((s) => s.closeTab);
    const text = useViewLabel(tab.view);
    const { view } = tab;
    const live = useData(
        (s) => view.name === 'conversation' && !!s.conversations[view.id]?.streaming,
    );
    return (
        // The close button sits beside the tab, not in it: a tab holds no other control.
        <div role="presentation" className={'tab' + (on ? ' on' : '') + (live ? ' live' : '')}>
            <button
                className="tab-open"
                role="tab"
                data-key={tab.key}
                aria-selected={on}
                // One stop in the tab order; the arrow keys move between tabs.
                tabIndex={on ? 0 : -1}
                title={text}
                onClick={() => activateTab(tab.key)}
                onKeyDown={onKeyDown}
                onAuxClick={(e) => {
                    if (e.button === 1) closeTab(tab.key);
                }}
            >
                <span className="mark" aria-hidden="true">
                    &gt;
                </span>
                <span className="t">{text}</span>
            </button>
            <button
                className="tab-x"
                tabIndex={-1}
                aria-label={'Close ' + text}
                title="Close (Ctrl W)"
                onClick={() => closeTab(tab.key)}
            >
                ×
            </button>
        </div>
    );
}

/** The strip of open windows under the titlebar. Each screen is a tab; each conversation is its
 *  own. Left and right move between tabs, Home and End to either end, Delete closes one. */
export default function Tabs() {
    const tabs = useApp((s) => s.tabs);
    const active = useApp((s) => s.active);
    const navigate = useApp((s) => s.navigate);
    const list = useRef<HTMLDivElement>(null);

    const focusTab = (key: string) =>
        requestAnimationFrame(() =>
            list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(),
        );

    const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
        const at = tabs.findIndex((t) => t.key === e.currentTarget.dataset.key);
        if (at < 0) return;
        const step: Record<string, number> = {
            ArrowRight: at + 1,
            ArrowLeft: at - 1,
            Home: 0,
            End: tabs.length - 1,
        };
        const app = useApp.getState();
        const to = step[e.key];
        if (to !== undefined) {
            e.preventDefault();
            const next = tabs[(to + tabs.length) % tabs.length];
            if (!next) return;
            app.activateTab(next.key);
            focusTab(next.key);
        } else if (e.key === 'Delete') {
            e.preventDefault();
            app.closeTab(tabs[at]?.key ?? '');
            focusTab(useApp.getState().active);
        }
    };

    return (
        <div className="tabs">
            <div ref={list} className="tab-list" role="tablist" aria-label="Open tabs">
                {tabs.map((t) => (
                    <TabItem key={t.key} tab={t} on={t.key === active} onKeyDown={onKey} />
                ))}
            </div>
            <button
                className="tab-add"
                aria-label="New tab"
                title="New tab"
                onClick={() => navigate({ name: 'home' })}
            >
                +
            </button>
        </div>
    );
}
