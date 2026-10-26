import { useEffect, useRef, useState } from 'react';

interface Props {
    onSubmit: (text: string) => void;
    busy?: boolean;
    onStop?: () => void;
    autoFocus?: boolean;
    placeholder?: string;
}

export default function Composer({
    onSubmit,
    busy,
    onStop,
    autoFocus,
    placeholder = 'How can I help you today?',
}: Props) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState('');

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

    const submit = () => {
        const text = value.trim();
        if (!text || busy) return;
        setValue('');
        onSubmit(text);
        requestAnimationFrame(() => ref.current?.focus());
    };

    const has = value.trim().length > 0;
    return (
        <div className="composer">
            <div className="composer-wrap">
                <textarea
                    id="composer"
                    ref={ref}
                    rows={1}
                    value={value}
                    placeholder={placeholder}
                    aria-label="Message"
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            submit();
                        }
                    }}
                />
                {busy ? (
                    <button className="send stop" type="button" aria-label="Stop" onClick={onStop}>
                        <i />
                    </button>
                ) : (
                    <button
                        className={'send' + (has ? ' on' : '')}
                        type="button"
                        aria-label="Send"
                        onClick={submit}
                    >
                        <svg viewBox="0 0 24 24">
                            <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
}
