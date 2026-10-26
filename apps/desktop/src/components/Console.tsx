import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from '../store/app';
import { recentConversations, useData } from '../store/data';
import { sendMessage } from '../lib/agent';
import { titleFrom } from '../lib/util';
import { icons, type IconName } from './icons';

interface Item {
    key: string;
    section: string;
    label: string;
    icon: IconName;
    hint?: string;
    ask?: boolean;
    run: () => void;
}

export default function Console() {
    const open = useApp((s) => s.consoleOpen);
    const setConsole = useApp((s) => s.setConsole);
    const navigate = useApp((s) => s.navigate);
    const conversations = useData((s) => s.conversations);
    const docs = useData((s) => s.docs);
    const createConversation = useData((s) => s.createConversation);
    const createDoc = useData((s) => s.createDoc);
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

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

    const items = useMemo<Item[]>(() => {
        const query = q.trim();
        const match = (s: string) => !query || s.toLowerCase().includes(query.toLowerCase());
        const out: Item[] = [];
        if (query) {
            out.push({
                key: 'ask',
                section: 'Ask',
                label: query,
                icon: 'ask',
                ask: true,
                hint: 'enter',
                run: () => {
                    void (async () => {
                        const c = await createConversation(titleFrom(query));
                        navigate({ name: 'conversation', id: c.id });
                        void sendMessage(c.id, query);
                    })();
                },
            });
        }
        const actions: Item[] = [
            {
                key: 'new',
                section: 'Actions',
                label: 'New conversation',
                icon: 'plus',
                run: () => navigate({ name: 'home' }),
            },
            {
                key: 'newdoc',
                section: 'Actions',
                label: 'New document',
                icon: 'plus',
                run: () => {
                    void createDoc().then((d) => navigate({ name: 'documents', id: d.id }));
                },
            },
            {
                key: 'docs',
                section: 'Actions',
                label: 'Documents',
                icon: 'doc',
                run: () => navigate({ name: 'documents' }),
            },
            {
                key: 'convs',
                section: 'Actions',
                label: 'Conversations',
                icon: 'list',
                run: () => navigate({ name: 'conversations' }),
            },
            {
                key: 'autos',
                section: 'Actions',
                label: 'Automations',
                icon: 'auto',
                run: () => navigate({ name: 'automations' }),
            },
            {
                key: 'newauto',
                section: 'Actions',
                label: 'New automation',
                icon: 'plus',
                run: () => navigate({ name: 'automations', id: 'new' }),
            },
            {
                key: 'settings',
                section: 'Actions',
                label: 'Settings',
                icon: 'settings',
                run: () => navigate({ name: 'settings' }),
            },
        ];
        out.push(...actions.filter((a) => match(a.label)));
        recentConversations(conversations, 40)
            .filter((c) => match(c.title))
            .slice(0, query ? 6 : 5)
            .forEach((c) =>
                out.push({
                    key: 'c:' + c.id,
                    section: 'Conversations',
                    label: c.title,
                    icon: 'chat',
                    run: () => navigate({ name: 'conversation', id: c.id }),
                }),
            );
        docs.filter((d) => match(d.title))
            .slice(0, query ? 6 : 4)
            .forEach((d) =>
                out.push({
                    key: 'd:' + d.id,
                    section: 'Documents',
                    label: d.title || 'Untitled',
                    icon: 'doc',
                    run: () => navigate({ name: 'documents', id: d.id }),
                }),
            );
        return out;
    }, [q, conversations, docs, createConversation, createDoc, navigate]);

    useEffect(() => {
        const el = listRef.current?.querySelectorAll<HTMLElement>('.c-item')[sel];
        el?.scrollIntoView({ block: 'nearest' });
    }, [sel]);

    const run = (i: Item) => {
        setConsole(false);
        i.run();
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const it = items[sel];
            if (it) run(it);
        }
    };

    let lastSection = '';
    return (
        <>
            <div
                className={'console-scrim' + (open ? ' on' : '')}
                role="presentation"
                onClick={() => setConsole(false)}
            />
            <section
                className={'console' + (open ? ' on' : '')}
                aria-label="Console"
                aria-hidden={!open}
            >
                <input
                    id="console-input"
                    ref={input}
                    value={q}
                    placeholder="Search or ask anything"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                        setQ(e.target.value);
                        setSel(0);
                    }}
                    onKeyDown={onKey}
                />
                <div className="console-list" ref={listRef}>
                    {items.map((it, i) => {
                        const head =
                            it.section !== lastSection ? (
                                <div className="c-section" key={'s:' + it.section}>
                                    {it.section}
                                </div>
                            ) : null;
                        lastSection = it.section;
                        return (
                            <div key={it.key}>
                                {head}
                                <button
                                    className={'c-item' + (i === sel ? ' sel' : '')}
                                    onMouseEnter={() => setSel(i)}
                                    onClick={() => run(it)}
                                >
                                    <span className="ic">{icons[it.icon]}</span>
                                    <span className={'lbl' + (it.ask ? ' ask' : '')}>
                                        {it.label}
                                    </span>
                                    {it.hint && <span className="hint">{it.hint}</span>}
                                </button>
                            </div>
                        );
                    })}
                    {items.length === 0 && <div className="c-section">Nothing matches</div>}
                </div>
                <div className="console-foot">
                    <span>
                        <kbd>↑</kbd>
                        <kbd>↓</kbd> move
                    </span>
                    <span>
                        <kbd>↵</kbd> open
                    </span>
                    <span>
                        <kbd>esc</kbd> close
                    </span>
                </div>
            </section>
        </>
    );
}
