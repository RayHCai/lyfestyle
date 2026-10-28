import { useCallback, useEffect, useState } from 'react';

/** Text selected on the page, and the point (viewport px) to float its reply button at. */
export interface Picked {
    text: string;
    x: number;
    y: number;
}

/**
 * The text the user selected inside `within`, outside `except`, as on claude.ai, where a
 * selection offers to quote it into the reply. Clears when the selection collapses or the page
 * scrolls; `clear` drops it too.
 */
export function useQuoteSelection(within: string, except: string): [Picked | null, () => void] {
    const [picked, setPicked] = useState<Picked | null>(null);

    useEffect(() => {
        const read = () => {
            const s = window.getSelection();
            const text = s?.toString().trim() ?? '';
            const range = s && s.rangeCount > 0 && text ? s.getRangeAt(0) : null;
            const node = range?.commonAncestorContainer;
            const el = node instanceof Element ? node : node?.parentElement;
            if (!range || !el?.closest(within) || el.closest(except)) {
                setPicked(null);
                return;
            }
            const box = range.getBoundingClientRect();
            setPicked({ text, x: box.left + box.width / 2, y: box.top });
        };
        // Wait for mouseup so the button appears once the selection is made, not while dragging.
        const onUp = () => requestAnimationFrame(read);
        const onChange = () => {
            if (window.getSelection()?.isCollapsed) setPicked(null);
        };
        // Capture, since scroll does not bubble: the thread scrolls, not the document.
        const hide = () => setPicked(null);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('selectionchange', onChange);
        document.addEventListener('scroll', hide, true);
        return () => {
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('selectionchange', onChange);
            document.removeEventListener('scroll', hide, true);
        };
    }, [within, except]);

    const clear = useCallback(() => {
        window.getSelection()?.removeAllRanges();
        setPicked(null);
    }, []);
    return [picked, clear];
}
