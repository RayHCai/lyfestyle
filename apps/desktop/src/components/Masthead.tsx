import type { ReactNode } from 'react';

interface Props {
    /** Small tracked line above the title: a count, a category, a state. */
    eyebrow?: string;
    title: string;
    /** Actions aligned to the title's baseline on the right. */
    children?: ReactNode;
}

export default function Masthead({ eyebrow, title, children }: Props) {
    return (
        <header className="masthead">
            <div className="masthead-text">
                {eyebrow && <p className="eyebrow">{eyebrow}</p>}
                <h1>{title}</h1>
            </div>
            {children && <div className="masthead-actions">{children}</div>}
        </header>
    );
}
