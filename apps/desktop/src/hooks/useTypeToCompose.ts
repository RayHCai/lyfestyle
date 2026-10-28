import { useEffect } from 'react';
import { useApp } from '../store/app';

/** Focus inside one of these keeps its keys: fields type, and Space or Enter activates a focused
 *  button, link, tab or option. */
const KEEPS_KEYS =
    'input, textarea, select, [contenteditable], button, a[href], summary, [role="tab"], [role="option"], [role="dialog"], [role="alertdialog"]';

/**
 * Typing a character anywhere on the page goes to the field `selector` names. Focus moves during
 * keydown, so the browser delivers the key itself to the field. Left alone: keys with a modifier,
 * IME composition, focus on a control, and an open dialog or console.
 */
export function useTypeToCompose(selector: string): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.isComposing || e.defaultPrevented) return;
            const at = document.activeElement;
            if (at instanceof HTMLElement && at.closest(KEEPS_KEYS)) return;
            if (useApp.getState().consoleOpen || document.querySelector('[aria-modal="true"]'))
                return;
            document.querySelector<HTMLElement>(selector)?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selector]);
}
