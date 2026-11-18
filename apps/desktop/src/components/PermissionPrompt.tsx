import { useState } from 'react';
import { useAttempt } from '../hooks/useAttempt';
import { answer, describeInput, type PermissionRequest } from '../lib/permissions';

/**
 * A tool call the agent is waiting on the user to allow, at the end of the thread. The turn stays
 * paused until it is answered or stopped.
 */
export default function PermissionPrompt({ request: r }: { request: PermissionRequest }) {
    const [busy, setBusy] = useState(false);
    const [problem, attempt] = useAttempt();
    const detail = describeInput(r.input);
    const act = async (allow: boolean) => {
        setBusy(true);
        await attempt(() => answer(r, allow));
        setBusy(false);
    };
    return (
        <article className="perm" aria-label={`Permission to use ${r.tool}`}>
            <header className="perm-head">
                <span className="eyebrow">permission</span>
                <span className="tag">{r.tool}</span>
            </header>
            {r.title && <p className="perm-note">{r.title}</p>}
            {detail && <pre className="code select-text">{detail}</pre>}
            {r.reason && <p className="perm-note">{r.reason}</p>}
            <div className="actions">
                <button className="btn" disabled={busy} onClick={() => void act(true)}>
                    allow
                </button>
                <button className="btn danger" disabled={busy} onClick={() => void act(false)}>
                    deny
                </button>
            </div>
            {problem && <div className="err select-text">{problem}</div>}
        </article>
    );
}
