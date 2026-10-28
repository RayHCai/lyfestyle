import { create } from 'zustand';

export interface PendingConfirm {
    message: string;
    action: string;
    resolve: (ok: boolean) => void;
}

/** The question `components/Confirm.tsx` is showing, if any. */
export const useConfirm = create<{ pending: PendingConfirm | null }>(() => ({ pending: null }));

/** Ask before doing something that cannot be undone. Resolves true when the user confirms.
 *  An in-app dialog rather than `window.confirm`, which the Tauri webview does not reliably show. */
export function confirmAction(message: string, action = 'Delete'): Promise<boolean> {
    useConfirm.getState().pending?.resolve(false);
    return new Promise((resolve) => useConfirm.setState({ pending: { message, action, resolve } }));
}

/** Settles the open question; the dialog closes. */
export function answerConfirm(ok: boolean): void {
    useConfirm.getState().pending?.resolve(ok);
    useConfirm.setState({ pending: null });
}
