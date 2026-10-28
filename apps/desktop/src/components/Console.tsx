import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
} from 'react';
import { useApp } from '../store/app';
import { recentConversations, useData } from '../store/data';
import { newDocument, startConversation } from '../lib/actions';
import { isWeb } from '../lib/tauri';
import type { Conversation, DocMeta } from '../lib/types';

interface Item {
    key: string;
    section: string;
    label: string;
    ask?: boolean;
    run: () => void;
}

/** Open the console (if it is closed) and put the cursor in its field. */
export function focusConsole() {
    useApp.getState().setConsole(true);
    setTimeout(() => document.getElementById('console-input')?.focus(), 30);
}

interface Pos {
    left: number;
    top: number;
}

const NONE: Record<string, Conversation> = {};
const NO_DOCS: DocMeta[] = [];

/** Everything the query reaches: asking it, the screens, recent conversations and documents. */
function buildItems(
    q: string,
    conversations: Record<string, Conversation>,
    docs: DocMeta[],
): Item[] {
    const query = q.trim();
    const match = (s: string) => !query || s.toLowerCase().includes(query.toLowerCase());
    const { navigate } = useApp.getState();
    const out: Item[] = [];
    if (query && !isWeb) {
        out.push({
            key: 'ask',
            section: 'Ask',
            label: query,
            ask: true,
            run: () => void startConversation(query),
        });
    }
    const actions: Item[] = [
        {
            key: 'new',
            section: 'Actions',
            label: 'New conversation',
            run: () => navigate({ name: 'home' }),
        },
        {
            key: 'newdoc',
            section: 'Actions',
            label: 'New document',
            run: () => void newDocument(),
        },
        {
            key: 'docs',
            section: 'Actions',
            label: 'Documents',
            run: () => navigate({ name: 'documents' }),
        },
        {
            key: 'convs',
            section: 'Actions',
            label: 'Conversations',
            run: () => navigate({ name: 'conversations' }),
        },
        {
            key: 'autos',
            section: 'Actions',
            label: 'Automations',
            run: () => navigate({ name: 'automations' }),
        },
        {
            key: 'views',
            section: 'Actions',
            label: 'Page views',
            run: () => navigate({ name: 'pageviews' }),
        },
        {
            key: 'settings',
            section: 'Actions',
            label: 'Settings',
            run: () => navigate({ name: 'settings' }),
        },
    ];
    // The web build has no agent, so nothing that starts or opens a conversation.
    const agentOnly = new Set(['new', 'convs']);
    out.push(...actions.filter((a) => match(a.label) && !(isWeb && agentOnly.has(a.key))));
    for (const c of recentConversations(isWeb ? {} : conversations, 40)
        .filter((c) => match(c.title))
        .slice(0, query ? 6 : 5)) {
        out.push({
            key: 'c:' + c.id,
            section: 'Conversations',
            label: c.title,
            run: () => navigate({ name: 'conversation', id: c.id }),
        });
    }
    for (const d of docs.filter((d) => match(d.title)).slice(0, query ? 6 : 4)) {
        out.push({
            key: 'd:' + d.id,
            section: 'Documents',
            label: d.title || 'Untitled',
            run: () => navigate({ name: 'documents', id: d.id }),
        });
    }
    return out;
}

/** A floating panel, like a Finder window: dragging its title bar moves it. Esc, a click outside
 *  it, or opening a page closes it. It sits centred until first dragged, then keeps its spot until
 *  reload. */
export default function Console() {
    const open = useApp((s) => s.consoleOpen);
    const setConsole = useApp((s) => s.setConsole);
    // Only while open: a closed console has no list to keep current as replies stream in.
    const conversations = useData((s) => (open ? s.conversations : NONE));
    const docs = useData((s) => (open ? s.docs : NO_DOCS));
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const panel = useRef<HTMLElement>(null);
    const [pos, setPos] = useState<Pos | null>(null);
    const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
    const listId = useId();
    const optionId = (i: number) => `${listId}-${i}`;

    // Reset the query when the console opens; done during render so no effect has to set state.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setQ('');
            setSel(0);
        }
    }

    useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => input.current?.focus(), 30);
        return () => clearTimeout(t);
    }, [open]);

    // There is no scrim, so a click anywhere outside the panel closes it. The confirm dialog
    // counts as inside: it can open on top of the console.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: globalThis.PointerEvent) => {
            const t = e.target instanceof Element ? e.target : null;
            if (!t?.closest('.console, .confirm, .confirm-scrim')) setConsole(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [open, setConsole]);

    const items = useMemo(
        () => (open ? buildItems(q, conversations, docs) : []),
        [open, q, conversations, docs],
    );

    useEffect(() => {
        document.getElementById(`${listId}-${sel}`)?.scrollIntoView({ block: 'nearest' });
    }, [listId, sel]);

    const run = (i: Item) => {
        setConsole(false);
        i.run();
    };

    const startDrag = (e: PointerEvent<HTMLDivElement>) => {
        const el = panel.current;
        const parent = el?.offsetParent;
        if (!el || !parent || e.button !== 0 || (e.target as Element).closest('button')) return;
        const box = el.getBoundingClientRect();
        const frame = parent.getBoundingClientRect();
        drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: box.left - frame.left,
            top: box.top - frame.top,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onDrag = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        const el = panel.current;
        const parent = el?.offsetParent;
        if (!d || !el || !(parent instanceof HTMLElement)) return;
        // Keep the title bar on screen so the panel can always be dragged back.
        const maxLeft = Math.max(0, parent.clientWidth - el.offsetWidth);
        const maxTop = Math.max(0, parent.clientHeight - 40);
        setPos({
            left: Math.min(maxLeft, Math.max(0, d.left + e.clientX - d.x)),
            top: Math.min(maxTop, Math.max(0, d.top + e.clientY - d.y)),
        });
    };
    const endDrag = () => {
        drag.current = null;
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
        } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const it = items[sel];
            if (it) run(it);
        }
    };

    const place = pos
        ? ({ '--left': `${pos.left}px`, '--top': `${pos.top}px` } as CSSProperties)
        : undefined;
    return (
        <section
            ref={panel}
            className={'console' + (open ? ' on' : '') + (pos ? ' placed' : '')}
            style={place}
            aria-label="Console"
            aria-hidden={!open}
            inert={!open}
        >
            <div
                className="console-bar"
                onPointerDown={startDrag}
                onPointerMove={onDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <span className="t">console</span>
                <button
                    className="x"
                    aria-label="Close console"
                    title="Close (Esc)"
                    onClick={() => setConsole(false)}
                >
                    ×
                </button>
            </div>
            <div className="console-field">
                <span className="ic" aria-hidden="true" />
                <input
                    id="console-input"
                    ref={input}
                    value={q}
                    placeholder="Search, or ask anything"
                    aria-label="Search, or ask anything"
                    aria-controls={listId}
                    aria-activedescendant={items[sel] ? optionId(sel) : undefined}
                    aria-autocomplete="list"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                        setQ(e.target.value);
                        setSel(0);
                    }}
                    onKeyDown={onKey}
                />
            </div>
            <div
                className="console-list"
                id={listId}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a filtered list driven from the field; <select> cannot be
                role="listbox"
                aria-label="Results"
            >
                {items.map((it, i) => {
                    const head =
                        it.section !== items[i - 1]?.section ? (
                            <div className="c-section" role="presentation">
                                {it.section}
                            </div>
                        ) : null;
                    return (
                        <div key={it.key} role="presentation">
                            {head}
                            <button
                                id={optionId(i)}
                                type="button"
                                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the listbox above
                                role="option"
                                aria-selected={i === sel}
                                tabIndex={-1}
                                className={'c-item' + (i === sel ? ' sel' : '')}
                                onMouseEnter={() => setSel(i)}
                                onClick={() => run(it)}
                            >
                                <span className="ic" aria-hidden="true" />
                                <span className={'lbl' + (it.ask ? ' ask' : '')}>{it.label}</span>
                            </button>
                        </div>
                    );
                })}
                {items.length === 0 && (
                    <div className="c-section" role="presentation">
                        Nothing matches
                    </div>
                )}
            </div>
        </section>
    );
}
