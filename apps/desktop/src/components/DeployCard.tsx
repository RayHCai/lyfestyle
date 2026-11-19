import { useEffect, useState } from 'react';
import { confirmAction } from './Confirm';
import { useAttempt, type Attempt } from '../hooks/useAttempt';
import type { ApiAutomationDeploy } from '../lib/api';
import { describeCron } from '../lib/cron';
import { diffLines } from '../lib/diff';
import { relativeTime } from '../lib/time';
import { getApi, useData } from '../store/data';

/** Who proposed a deploy, when it was not the agent in a chat the user was watching. */
const origins: Partial<Record<ApiAutomationDeploy['origin'], { text: string; warn: boolean }>> = {
    automation: {
        text: 'Proposed by an unattended automation run. Read the code carefully.',
        warn: true,
    },
    user: { text: 'Proposed directly.', warn: false },
};

/** The status line that replaces the buttons once the user decides. */
const phases = {
    approving: { text: 'deploying…', live: true },
    rejecting: { text: 'rejecting…', live: true },
    approved: { text: 'deployed', live: false },
    rejected: { text: 'rejected', live: false },
};

/**
 * A proposed automation deploy: the code (as a diff against the deployed version) with approve
 * and reject. Once decided it shrinks to one line. Shown on the Automations page and in the chat
 * where the agent proposed it.
 */
export default function DeployCard({
    deploy: d,
    attempt,
    onDecided,
}: {
    deploy: ApiAutomationDeploy;
    attempt: Attempt;
    onDecided?: () => Promise<void>;
}) {
    const decide = useData((s) => s.decideDeploy);
    // Where a decision is: in flight, or made and waiting for the card to be re-fetched as
    // decided. Null shows the approve and reject buttons.
    const [phase, setPhase] = useState<keyof typeof phases | null>(null);

    if (d.status !== 'pending')
        return (
            <article className="deploy decided">
                <header className="deploy-head">
                    <h3>{d.name}</h3>
                    <span className={'tag ' + d.status}>
                        {d.status === 'approved' ? 'deployed' : 'rejected'}
                    </span>
                </header>
                <p className="deploy-meta">
                    {describeCron(d.schedule)} · {d.timezone}
                    {d.decidedAt && <> · {relativeTime(Date.parse(d.decidedAt))}</>}
                </p>
            </article>
        );

    const cur = d.current;
    const changed = cur && cur.code !== d.code ? diffLines(cur.code, d.code) : null;
    const notes: string[] = [];
    if (cur && cur.name !== d.name) notes.push(`renamed from "${cur.name}"`);
    if (cur && (cur.schedule !== d.schedule || cur.timezone !== d.timezone))
        notes.push(`was ${describeCron(cur.schedule)} · ${cur.timezone}`);
    if (cur && cur.code === d.code) notes.push('code unchanged');
    const origin = origins[d.origin];

    const act = async (approve: boolean) => {
        if (
            !approve &&
            !(await confirmAction(`Reject "${d.name}"? The proposed code is discarded.`, 'Reject'))
        )
            return;
        setPhase(approve ? 'approving' : 'rejecting');
        const ok = await attempt(() => decide(d.id, approve));
        if (!ok) {
            setPhase(null);
            return;
        }
        setPhase(approve ? 'approved' : 'rejected');
        await onDecided?.();
    };

    return (
        <article className="deploy">
            <header className="deploy-head">
                <h3>{d.name}</h3>
                <span className="tag">{cur ? `v${cur.version} → v${cur.version + 1}` : 'new'}</span>
            </header>
            {origin && (
                <p className={'deploy-origin' + (origin.warn ? ' warn' : '')}>{origin.text}</p>
            )}
            <p className="deploy-meta">
                {describeCron(d.schedule)} · {d.timezone} · proposed{' '}
                {relativeTime(Date.parse(d.createdAt))}
                {notes.map((n) => (
                    <span key={n}> · {n}</span>
                ))}
            </p>
            {d.description && <p className="deploy-desc">{d.description}</p>}
            {changed ? (
                <pre className="code select-text">
                    {changed.map((l, n) => (
                        <span
                            // oxlint-disable-next-line react/no-array-index-key -- diff lines have no identity; the list is rebuilt whole
                            key={n}
                            className={
                                'ln' + (l.kind === '+' ? ' add' : l.kind === '-' ? ' del' : '')
                            }
                        >
                            <i>{l.kind}</i>
                            {l.text}
                            {'\n'}
                        </span>
                    ))}
                </pre>
            ) : (
                <pre className="code select-text">{d.code}</pre>
            )}
            {phase ? (
                <output className={'deploy-status ' + (phases[phase].live ? 'live' : 'done')}>
                    <i />
                    {phases[phase].text}
                </output>
            ) : (
                <div className="actions">
                    <button className="btn" onClick={() => void act(true)}>
                        approve and deploy
                    </button>
                    <button className="btn danger" onClick={() => void act(false)}>
                        reject
                    </button>
                </div>
            )}
        </article>
    );
}

/** The approval prompt under the chat message where the agent proposed deploy `id`. A rejected
 *  deploy leaves nothing behind; an approved one stays as its one-line record. */
export function DeployPrompt({ id }: { id: string }) {
    // Whether the deploy is in the store's pending list: it flips when the deploy is decided
    // anywhere, the Automations page included, which is the one time to fetch it again.
    const pending = useData((s) => s.deploys.some((d) => d.id === id));
    const [deploy, setDeploy] = useState<ApiAutomationDeploy | null>(null);
    const [problem, attempt] = useAttempt();

    useEffect(() => {
        let live = true;
        void attempt(async () => {
            const api = getApi();
            const next = api ? await api.getDeploy(id) : null;
            if (live && next) setDeploy(next);
        });
        return () => {
            live = false;
        };
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `pending` flipping is the cue to fetch again
    }, [attempt, id, pending]);

    if (deploy?.status === 'rejected' && !problem) return null;
    return (
        <div className="deploy-prompt">
            {deploy && deploy.status !== 'rejected' && (
                <DeployCard deploy={deploy} attempt={attempt} />
            )}
            {problem && <div className="err select-text">{problem}</div>}
        </div>
    );
}
