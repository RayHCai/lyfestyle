import { useEffect, useState } from 'react';

/** A text button that copies `text()` and says so for a moment. */
export default function CopyButton({
    text,
    className = 'msg-act',
}: {
    text: () => string;
    className?: string;
}) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(t);
    }, [copied]);
    return (
        <button
            type="button"
            className={className}
            onClick={() =>
                void navigator.clipboard.writeText(text()).then(
                    () => setCopied(true),
                    () => undefined,
                )
            }
        >
            {copied ? 'copied' : 'copy'}
        </button>
    );
}
