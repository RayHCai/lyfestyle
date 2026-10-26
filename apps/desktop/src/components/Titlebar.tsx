import { sidebarHover, useApp } from '../store/app';
import { isTauri, windowAction } from '../lib/tauri';

export default function Titlebar() {
    const setSidebar = useApp((s) => s.setSidebar);
    const open = useApp((s) => s.sidebarOpen);
    const pinned = useApp((s) => s.sidebarPinned);
    const toggle = () => {
        if (open && pinned) setSidebar(false);
        else setSidebar(true, true);
    };
    return (
        <div className="titlebar" data-tauri-drag-region>
            <button
                className={'menu-btn' + (open && pinned ? ' on' : '')}
                aria-label="Menu"
                aria-expanded={open}
                onClick={toggle}
                onMouseEnter={sidebarHover.enter}
                onMouseLeave={sidebarHover.leave}
            >
                <span />
                <span />
                <span />
            </button>
            {isTauri && (
                <div className="win">
                    <button aria-label="Minimize" onClick={() => windowAction('minimize')}>
                        <svg viewBox="0 0 12 12">
                            <path d="M1 6h10" />
                        </svg>
                    </button>
                    <button aria-label="Maximize" onClick={() => windowAction('maximize')}>
                        <svg viewBox="0 0 12 12">
                            <rect x="1.5" y="1.5" width="9" height="9" />
                        </svg>
                    </button>
                    <button
                        className="close"
                        aria-label="Close"
                        onClick={() => windowAction('close')}
                    >
                        <svg viewBox="0 0 12 12">
                            <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}
