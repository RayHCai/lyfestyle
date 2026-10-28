import type { ReactElement } from 'react';

/** The only icons in the app (see the design rules): the rail toggle and the trash can on a
 *  recent conversation. The window controls draw their own. Stroke, fill and size come from the
 *  surrounding CSS. */
export const icons: Record<'rail' | 'trash', ReactElement> = {
    trash: (
        <svg viewBox="0 0 24 24">
            <path d="M4 7h16M10 3h4M6 7l1 13h10l1-13M10 11v6M14 11v6" />
        </svg>
    ),
    rail: (
        <svg viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M9 4v16" />
        </svg>
    ),
};
