import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import Composer from '../components/Composer';
import CopyButton from '../components/CopyButton';
import { DeployPrompt } from '../components/DeployCard';
import Markdown from '../components/Markdown';
import { useQuoteSelection } from '../hooks/useQuoteSelection';
import { useTypeToCompose } from '../hooks/useTypeToCompose';
import { useApp } from '../store/app';
import { useData } from '../store/data';
import { canResend, cancel, openConversation, resend, sendMessage } from '../lib/agent';
import type { Message } from '../lib/types';

const COMPOSER = '.conv-foot textarea';

/** A user message as typed, with its `> ` lines (quoted replies) set apart. */
function UserText({ text }: { text: string }) {
    /** Runs of quoted or plain lines, keyed by the line each starts on. */
    const parts: { quote: boolean; text: string; line: number }[] = [];
    text.split('\n').forEach((line, n) => {
        const quote = /^>\s?/.test(line);
        const body = quote ? line.replace(/^>\s?/, '') : line;
        const last = parts.at(-1);
        if (last && last.quote === quote) last.text += '\n' + body;
        else parts.push({ quote, text: body, line: n });
    });
    return (
        <div className="user-text select-text">
            {parts.map((p) =>
                p.quote ? (
                    <blockquote key={p.line}>{p.text}</blockquote>
                ) : (
                    p.text.trim() && <p key={p.line}>{p.text.replace(/^\n+|\n+$/g, '')}</p>
                ),
            )}
        </div>
    );
}

function EditBox({
    initial,
    onSave,
    onCancel,
}: {
    initial: string;
    onSave: (text: string) => void;
    onCancel: () => void;
}) {
    const [text, setText] = useState(initial);
    const ref = useRef<HTMLTextAreaElement>(null);
    const resize = () => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    };
    useEffect(resize, [text]);
    useEffect(() => {
        const el = ref.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
    }, []);
    const save = () => {
        if (text.trim()) onSave(text.trim());
    };
    return (
        <div className="msg-edit">
            <textarea
                ref={ref}
                value={text}
                aria-label="Edit message"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        onCancel();
                    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        save();
                    }
                }}
            />
            <div className="msg-edit-row">
                <span className="msg-edit-note">
                    sends from here and replaces the replies after it
                </span>
                <button type="button" className="btn" onClick={onCancel}>
                    Cancel
                </button>
                <button type="button" className="btn" onClick={save}>
                    Save ⏎
                </button>
            </div>
        </div>
    );
}

interface MessageProps {
    m: Message;
    streaming: boolean;
    canEdit: boolean;
    canRetry: boolean;
    onEdit: (messageId: string) => void;
    onRetry: (messageId: string) => void;
}

/** One turn. Memoised: while a reply streams, only the last message changes, so the others keep
 *  their parsed markdown instead of re-rendering on every token. */
const MessageView = memo(function MessageView({
    m,
    streaming,
    canEdit,
    canRetry,
    onEdit,
    onRetry,
}: MessageProps) {
    const text = m.content + (m.live ?? '');
    const row = !streaming && (text || canRetry) && (
        <div className="msg-acts">
            {text && <CopyButton text={() => m.content} />}
            {canEdit && (
                <button type="button" className="msg-act" onClick={() => onEdit(m.id)}>
                    edit
                </button>
            )}
            {canRetry && (
                <button type="button" className="msg-act" onClick={() => onRetry(m.id)}>
                    retry
                </button>
            )}
        </div>
    );
    if (m.role === 'user')
        return (
            <div className="msg user">
                <UserText text={m.content} />
                {row}
            </div>
        );
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
            {m.deploys?.map((d) => (
                <DeployPrompt key={d} id={d} />
            ))}
            {m.error && <div className="err select-text">{m.error}</div>}
            {row}
        </div>
    );
});

/** Adds `text` to the end of the draft as a `> ` quote, with a blank line to reply under. */
function quoteInto(draft: string, text: string): string {
    const block = text
        .trim()
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
    return (draft.trim() ? draft.trimEnd() + '\n\n' : '') + block + '\n\n';
}

function focusComposer() {
    requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(COMPOSER);
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
    });
}

export default function ConversationPage({ id }: { id: string }) {
    const c = useData((s) => s.conversations[id]);
    const scroller = useRef<HTMLDivElement>(null);
    const size = c
        ? c.messages.reduce((n, m) => n + m.content.length + (m.live?.length ?? 0), 0)
        : 0;
    const count = c?.messages.length ?? 0;
    const draft = useApp((s) => s.drafts[id] ?? '');
    const saveDraft = useApp((s) => s.setDraft);
    const setDraft = useCallback((text: string) => saveDraft(id, text), [id, saveDraft]);
    const [editing, setEditing] = useState<string | null>(null);
    const [picked, clearPicked] = useQuoteSelection('.thread', '.msg-edit');
    useTypeToCompose(COMPOSER);

    useEffect(() => {
        void openConversation(id);
    }, [id]);

    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        if (nearBottom || size < 400 || count < 3) el.scrollTop = el.scrollHeight;
    }, [size, count]);

    const onEdit = useCallback((messageId: string) => setEditing(messageId), []);
    const onRetry = useCallback(
        (messageId: string) => {
            const messages = useData.getState().conversations[id]?.messages ?? [];
            const asked = messages[messages.findIndex((m) => m.id === messageId) - 1];
            if (asked?.role === 'user') void resend(id, asked.id, asked.content);
        },
        [id],
    );

    if (!c)
        return (
            <div className="page">
                <div className="page-narrow">
                    <p className="empty">This conversation no longer exists.</p>
                </div>
            </div>
        );
    const streaming = !!c.streaming;
    const rewind = !streaming && canResend(c);
    const last = c.messages.length - 1;
    const reply = () => {
        if (!picked) return;
        setDraft(quoteInto(draft, picked.text));
        clearPicked();
        focusComposer();
    };

    return (
        <div className="conv">
            <div className="conv-head">
                <div className="conv-head-inner">
                    <h2>{c.title}</h2>
                    {streaming && (
                        <span className="conv-state live">
                            <i />
                            Working
                        </span>
                    )}
                </div>
            </div>
            <div className="conv-scroll" ref={scroller}>
                <div className="thread">
                    {c.messages.map((m, i) =>
                        editing === m.id && rewind ? (
                            <div key={m.id} className="msg user">
                                <EditBox
                                    initial={m.content}
                                    onCancel={() => setEditing(null)}
                                    onSave={(t) => {
                                        setEditing(null);
                                        void resend(id, m.id, t);
                                    }}
                                />
                            </div>
                        ) : (
                            <MessageView
                                key={m.id}
                                m={m}
                                streaming={streaming && i === last}
                                canEdit={rewind && m.role === 'user'}
                                canRetry={
                                    rewind &&
                                    m.role === 'assistant' &&
                                    i === last &&
                                    c.messages[i - 1]?.role === 'user'
                                }
                                onEdit={onEdit}
                                onRetry={onRetry}
                            />
                        ),
                    )}
                </div>
            </div>
            {picked && (
                <button
                    type="button"
                    className="quote-reply"
                    style={{ '--x': `${picked.x}px`, '--y': `${picked.y}px` } as CSSProperties}
                    // Keep the selection until the click has read it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={reply}
                >
                    › reply
                </button>
            )}
            <div className="conv-foot">
                <Composer
                    autoFocus
                    busy={streaming}
                    onStop={() => void cancel(id)}
                    onSubmit={(t) => void sendMessage(id, t)}
                    value={draft}
                    onValueChange={setDraft}
                    placeholder="reply"
                    prompt="you ›"
                />
            </div>
        </div>
    );
}
