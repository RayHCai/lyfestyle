import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { isTauri, windowAction } from '../lib/tauri';
import { clock } from '../lib/time';
import { useViewLabel } from '../lib/views';
import { icons } from './icons';

/** How close (px) the pointer must come to the rail button to open the sidebar. */
const NEAR = 40;

/** Frameless window chrome drawn as a status line: wordmark, where you are, the time, the controls. */
export default function Titlebar() {
    const open = useApp((s) => s.sidebarOpen);
    const setSidebar = useApp((s) => s.setSidebar);
    const view = useApp((s) => s.view);
    const crumb = useViewLabel(view);
    const [time, setTime] = useState(() => clock(Date.now()));
    const railBtn = useRef<HTMLButtonElement>(null);
    const peeking = useRef(false);

    // Hovering near the rail button peeks the sidebar open; it closes again once the pointer
    // leaves both the button area and the sidebar. A click pins it.
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const btn = railBtn.current;
            if (!btn) return;
            const r = btn.getBoundingClientRect();
            const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
            const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
            const near = Math.hypot(dx, dy) <= NEAR;
            const { sidebarOpen } = useApp.getState();
            if (near && !sidebarOpen) {
                peeking.current = true;
                setSidebar(true);
            } else if (peeking.current && !near) {
                const target = e.target instanceof Element ? e.target : null;
                if (!target?.closest('.sidebar')) {
                    peeking.current = false;
                    setSidebar(false);
                }
            }
        };
        window.addEventListener('pointermove', onMove);
        return () => window.removeEventListener('pointermove', onMove);
    }, [setSidebar]);

    useEffect(() => {
        const t = setInterval(() => setTime(clock(Date.now())), 30_000);
        return () => clearInterval(t);
    }, []);

    return (
        <div className="titlebar" data-tauri-drag-region>
            <div className="tb-left">
                <button
                    ref={railBtn}
                    className={'rail-btn' + (open ? ' on' : '')}
                    aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
                    aria-expanded={open}
                    onClick={() => {
                        // Clicking during a peek pins the sidebar open instead of closing it.
                        if (peeking.current) peeking.current = false;
                        else setSidebar(!open);
                    }}
                >
                    {icons.rail}
                </button>
                <span className="wordmark" data-tauri-drag-region>
                    lyfestyle<i>.</i>
                </span>
            </div>
            <span className="tb-fill" data-tauri-drag-region />
            <span className="tb-crumb" data-tauri-drag-region title={crumb}>
                {crumb}
            </span>
            <span className="tb-fill" data-tauri-drag-region />
            <span data-tauri-drag-region>{time}</span>
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
