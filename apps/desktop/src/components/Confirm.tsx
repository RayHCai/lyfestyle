import { useEffect, useId, useRef } from 'react';
import { answerConfirm, useConfirm } from '../lib/confirm';

export { confirmAction } from '../lib/confirm';

/** The modal question behind `confirmAction`. Focus starts on Cancel, the safe answer, stays in
 *  the dialog while it is open, and goes back to where it was once it is answered. */
export default function Confirm() {
    const pending = useConfirm((s) => s.pending);
    const box = useRef<HTMLDivElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const messageId = useId();

    useEffect(() => {
        if (!pending) return;
        const before =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        cancel.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                // Capture phase, so Esc answers the dialog instead of also closing the console.
                e.stopPropagation();
                answerConfirm(false);
                return;
            }
            if (e.key !== 'Tab') return;
            const buttons = [...(box.current?.querySelectorAll('button') ?? [])];
            const first = buttons[0];
            const last = buttons.at(-1);
            const at = document.activeElement;
            if (!first || !last) return;
            const inside = !!at && !!box.current?.contains(at);
            if (e.shiftKey && (at === first || !inside)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (at === last || !inside)) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            // The button that asked may be gone (the row it deleted); then focus stays put.
            if (before?.isConnected) before.focus();
        };
    }, [pending]);

    if (!pending) return null;
    return (
        <>
            <div
                className="confirm-scrim"
                role="presentation"
                onClick={() => answerConfirm(false)}
            />
            <div
                ref={box}
                className="confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={messageId}
            >
                <p id={messageId}>{pending.message}</p>
                <div className="confirm-actions">
                    <button ref={cancel} className="btn" onClick={() => answerConfirm(false)}>
                        Cancel
                    </button>
                    <button className="btn danger" onClick={() => answerConfirm(true)}>
                        {pending.action}
                    </button>
                </div>
            </div>
        </>
    );
}
