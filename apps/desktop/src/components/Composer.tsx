import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useData } from '../store/data';
import { runAppCommand, slashOptions, type SlashOption } from '../lib/commands';

interface Props {
    onSubmit: (text: string) => void;
    busy?: boolean;
    onStop?: () => void;
    autoFocus?: boolean;
    placeholder?: string;
    /** The prompt glyph before the field: `›` on the front page, `you ›` in a thread. */
    prompt?: string;
    /** Set both to own the draft, e.g. to quote a selection into it; otherwise the field keeps it. */
    value?: string;
    onValueChange?: (value: string) => void;
}

export default function Composer({
    onSubmit,
    busy,
    onStop,
    autoFocus,
    placeholder = 'how can I help you today?',
    prompt = '›',
    value: draft,
    onValueChange,
}: Props) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const skills = useData((s) => s.skills);
    const [own, setOwn] = useState('');
    const value = draft ?? own;
    const setValue = onValueChange ?? setOwn;
    /** The reply to `/model` or `/effort`, shown under the field until the next keystroke. */
    const [note, setNote] = useState('');
    const [sel, setSel] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const menuId = useId();

    const options = useMemo(() => slashOptions(value, skills), [value, skills]);
    const menuOpen = options.length > 0 && !dismissed;
    const cur = Math.min(sel, options.length - 1);

    const resize = () => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 240) + 'px';
    };
    useEffect(resize, [value]);
    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);
    useEffect(() => {
        document.getElementById(`${menuId}-${cur}`)?.scrollIntoView({ block: 'nearest' });
    }, [menuId, cur]);

    const change = (next: string) => {
        setValue(next);
        setNote('');
        setSel(0);
        setDismissed(false);
    };
    const complete = (o: SlashOption) => {
        change(o.insert);
        ref.current?.focus();
    };

    const submit = async () => {
        const text = value.trim();
        if (!text) return;
        // App commands work mid-turn: they only affect the next launch of the agent.
        const reply = await runAppCommand(text);
        if (reply !== null) {
            setValue('');
            setNote(reply);
            return;
        }
        if (busy) return;
        setValue('');
        onSubmit(text);
        requestAnimationFrame(() => ref.current?.focus());
    };

    const has = value.trim().length > 0;
    return (
        <div className="composer">
            {menuOpen && (
                <div
                    className="slash"
                    id={menuId}
                    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a menu driven from the field; <select> cannot be
                    role="listbox"
                    aria-label="Commands and skills"
                >
                    {options.map((o, i) => (
                        <button
                            key={o.insert}
                            id={`${menuId}-${i}`}
                            type="button"
                            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the listbox above
                            role="option"
                            aria-selected={i === cur}
                            tabIndex={-1}
                            className={'slash-item' + (i === cur ? ' sel' : '')}
                            // Keep focus in the field so typing carries on after a click.
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setSel(i)}
                            onClick={() => complete(o)}
                        >
                            <span className="mark" aria-hidden="true">
                                &gt;
                            </span>
                            <span className="t">{o.label}</span>
                            <span className="d">{o.description}</span>
                        </button>
                    ))}
                </div>
            )}
            <div className="composer-wrap">
                <span className="prompt" aria-hidden="true">
                    {prompt}
                </span>
                <textarea
                    ref={ref}
                    rows={1}
                    value={value}
                    placeholder={placeholder}
                    aria-label="Message"
                    aria-controls={menuOpen ? menuId : undefined}
                    aria-activedescendant={menuOpen ? `${menuId}-${cur}` : undefined}
                    aria-autocomplete="list"
                    onChange={(e) => change(e.target.value)}
                    onKeyDown={(e) => {
                        // Keys that finish an IME composition belong to the IME, not the composer.
                        if (e.nativeEvent.isComposing) return;
                        const pick = menuOpen ? options[cur] : undefined;
                        if (pick && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                            e.preventDefault();
                            const step = e.key === 'ArrowDown' ? 1 : -1;
                            setSel((cur + step + options.length) % options.length);
                        } else if (pick && e.key === 'Tab') {
                            e.preventDefault();
                            complete(pick);
                        } else if (pick && e.key === 'Escape') {
                            setDismissed(true);
                        } else if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            // Enter completes a partial name first; on a full one it sends.
                            if (pick && pick.insert.trimEnd() !== value.trimEnd()) complete(pick);
                            else void submit();
                        }
                    }}
                />
                {busy ? (
                    <button className="send stop" type="button" onClick={onStop}>
                        stop
                    </button>
                ) : (
                    <button
                        className={'send' + (has ? ' on' : '')}
                        type="button"
                        onClick={() => void submit()}
                    >
                        send ⏎
                    </button>
                )}
            </div>
            {note && <p className="composer-note">{note}</p>}
        </div>
    );
}
