import type { ReactElement } from 'react';

export type IconName = 'ask' | 'chat' | 'doc' | 'plus' | 'auto' | 'settings' | 'list' | 'compose';

/** Hairline icons; stroke, fill and size come from the surrounding CSS. */
export const icons: Record<IconName, ReactElement> = {
    ask: (
        <svg viewBox="0 0 24 24">
            <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
    ),
    chat: (
        <svg viewBox="0 0 24 24">
            <path d="M4 5h16v11H9l-5 4z" />
        </svg>
    ),
    doc: (
        <svg viewBox="0 0 24 24">
            <path d="M6 3h9l5 5v13H6zM15 3v5h5M9 13h6M9 17h6" />
        </svg>
    ),
    plus: (
        <svg viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
        </svg>
    ),
    auto: (
        <svg viewBox="0 0 24 24">
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
    ),
    settings: (
        <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
        </svg>
    ),
    list: (
        <svg viewBox="0 0 24 24">
            <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
    ),
    compose: (
        <svg viewBox="0 0 24 24">
            <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
    ),
};
