import { useEffect, useRef } from 'react';
import Composer from '../components/Composer';
import Markdown from '../components/Markdown';
import { useData } from '../store/data';
import { cancel, openConversation, sendMessage } from '../lib/agent';
import type { Message } from '../lib/types';

function MessageView({ m, streaming }: { m: Message; streaming: boolean }) {
    if (m.role === 'user') return <div className="msg user select-text">{m.content}</div>;
    const text = m.content + (m.live ?? '');
    const waiting = streaming && !text;
    return (
        <div className="msg assistant">
            {m.tools && m.tools.length > 0 && (
                <div className="tools">
                    {[...new Set(m.tools)].map((t) => (
                        <span key={t}>{t}</span>
                    ))}
                </div>
            )}
            {waiting && (
                <div className="thinking">
                    <i />
                    <i />
                    <i />
                </div>
            )}
            {text && <Markdown text={text} />}
            {streaming && text && <span className="cursor" aria-hidden="true" />}
            {m.error && <div className="err select-text">{m.error}</div>}
        </div>
    );
}

export default function ConversationPage({ id }: { id: string }) {
    const c = useData((s) => s.conversations[id]);
    const scroller = useRef<HTMLDivElement>(null);
    const size = c
        ? c.messages.reduce((n, m) => n + m.content.length + (m.live?.length ?? 0), 0)
        : 0;
    const count = c?.messages.length ?? 0;

    useEffect(() => {
        void openConversation(id);
    }, [id]);

    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        if (nearBottom || size < 400 || count < 3) el.scrollTop = el.scrollHeight;
    }, [size, count]);

    if (!c)
        return (
            <div className="page">
                <div className="empty">This conversation no longer exists.</div>
            </div>
        );
    const streaming = !!c.streaming;

    return (
        <div className="conv">
            <div className="conv-head">
                <h2>{c.title}</h2>
            </div>
            <div className="conv-scroll" ref={scroller}>
                <div className="thread">
                    {c.messages.map((m, i) => (
                        <MessageView
                            key={m.id}
                            m={m}
                            streaming={streaming && i === c.messages.length - 1}
                        />
                    ))}
                </div>
            </div>
            <div className="conv-foot">
                <Composer
                    autoFocus
                    busy={streaming}
                    onStop={() => cancel(id)}
                    onSubmit={(t) => void sendMessage(id, t)}
                    placeholder="Reply"
                />
            </div>
        </div>
    );
}
