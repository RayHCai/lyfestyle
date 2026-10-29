import { useEffect, useRef, useState } from 'react';
import { TERMINAL_RUN_STATUSES, type RunEvent } from '@lyfestyle/shared';
import type { ApiAutomationAgentRun, ApiAutomationRunDetail, ApiAutomationRun } from '../lib/api';
import { eventLines } from '../lib/run-log';
import { clock, cost, duration } from '../lib/time';
import { getApi } from '../store/data';

/** How often a run still going is fetched again. */
const POLL_MS = 2_000;
const ended = (status: string) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/**
 * One automation run as it happens (key it by `runId`): what its code logged, then each agent run it queued with
 * that agent's messages, tool calls and spend. Polls until the run and its agent runs end.
 */
export default function RunLog({
    automationId,
    runId,
    onPick,
    onClose,
}: {
    automationId: string;
    runId: string;
    onPick: (runId: string) => void;
    onClose: () => void;
}) {
    const [run, setRun] = useState<ApiAutomationRunDetail | null>(null);
    const [recent, setRecent] = useState<ApiAutomationRun[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    /** When the run was last fetched: a run still going is timed up to then. */
    const [now, setNow] = useState(() => Date.now());
    const box = useRef<HTMLElement>(null);

    // Keyed by run, so this brings each newly opened run into view.
    useEffect(() => {
        box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, []);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = async () => {
            const api = getApi();
            if (!api) return;
            try {
                const [detail, automation] = await Promise.all([
                    api.automationRun(runId),
                    api.getAutomation(automationId),
                ]);
                if (stopped) return;
                setRun(detail);
                setRecent(automation.recentRuns);
                setNow(Date.now());
                setProblem(null);
                const going =
                    detail.status === 'running' || detail.agentRuns.some((r) => !ended(r.status));
                if (going) timer = setTimeout(() => void load(), POLL_MS);
            } catch (e) {
                if (stopped) return;
                setProblem(e instanceof Error ? e.message : String(e));
                timer = setTimeout(() => void load(), POLL_MS * 3);
            }
        };
        void load();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [automationId, runId]);

    const start = run ? Date.parse(run.startedAt) : 0;
    const end = run?.finishedAt ? Date.parse(run.finishedAt) : now;
    const budget = run?.agentRuns.reduce((sum, r) => sum + r.budgetUsd, 0) ?? 0;

    return (
        <section className="auto-sec runlog" ref={box} aria-live="polite">
            <div className="sec-head">
                <h2 className="sec-h">run {run ? <span>{run.name}</span> : null}</h2>
                <button className="btn" onClick={onClose}>
                    close
                </button>
            </div>
            {recent.length > 1 && (
                <div className="rl-picks" role="tablist" aria-label="Recent runs">
                    {recent.map((r) => (
                        <button
                            key={r.id}
                            role="tab"
                            aria-selected={r.id === runId}
                            className={'rl-pick ' + r.status + (r.id === runId ? ' on' : '')}
                            onClick={() => onPick(r.id)}
                        >
                            {clock(r.startedAt)}
                        </button>
                    ))}
                </div>
            )}
            {problem && <div className="err select-text">{problem}</div>}
            {!run ? (
                <p className="empty">loading…</p>
            ) : (
                <div className="rl select-text">
                    <div className="rl-meta">
                        <span className={'rl-status ' + run.status}>{run.status}</span>
                        <span>{run.trigger === 'manual' ? 'run by hand' : 'scheduled'}</span>
                        <span>v{run.version}</span>
                        <span>
                            {clock(start)} · {duration(end - start)}
                        </span>
                        <span>
                            {cost(run.costUsd)}
                            {budget > 0 ? ` of ${cost(budget)}` : ''}
                        </span>
                    </div>
                    {run.error && <pre className="rl-error">{run.error}</pre>}
                    {run.output && (
                        <details className="rl-output">
                            <summary>output</summary>
                            <pre>{run.output}</pre>
                        </details>
                    )}

                    <h3 className="rl-h">code</h3>
                    {run.logs.length === 0 ? (
                        <p className="rl-none">
                            {run.status === 'running' ? 'nothing logged yet' : 'nothing logged'}
                        </p>
                    ) : (
                        <ol className="rl-lines">
                            {run.logs.map((l, i) => (
                                // oxlint-disable-next-line react/no-array-index-key -- logs only grow at the end and have no id
                                <li key={i} className={l.level}>
                                    <time>{clock(l.at)}</time>
                                    <span>{l.message}</span>
                                </li>
                            ))}
                        </ol>
                    )}

                    {run.agentRuns.map((a, i) => (
                        <AgentRun key={a.id} run={a} n={i + 1} />
                    ))}
                </div>
            )}
        </section>
    );
}

/** One `ctx.agent` call: its prompt, who ran it, and its events, fetched as they arrive. */
function AgentRun({ run, n }: { run: ApiAutomationAgentRun; n: number }) {
    const [events, setEvents] = useState<RunEvent[]>([]);
    /** The newest event id fetched, and the fetch in flight: one at a time, so none repeat. */
    const cursor = useRef(0);
    const queue = useRef<Promise<void>>(Promise.resolve());

    // Each poll of the parent hands over a new `run`, which fetches what arrived since the last
    // event, including once more after the run ends for its final events.
    useEffect(() => {
        const api = getApi();
        if (!api) return;
        // Kept even when a newer `run` lands meanwhile: the cursor has already moved past them.
        queue.current = queue.current.then(async () => {
            const more = await api.runEvents(run.id, cursor.current).catch(() => []);
            const last = more.at(-1);
            if (!last) return;
            cursor.current = last.id;
            setEvents((e) => [...e, ...more]);
        });
    }, [run]);

    const lines = events.flatMap(eventLines);
    return (
        <div className="rl-agent">
            <h3 className="rl-h">
                agent {n}
                <span className={'rl-status ' + run.status}>{run.status}</span>
                <span>
                    {cost(run.costUsd)} of {cost(run.budgetUsd)}
                </span>
                {run.runnerId && (
                    <span>
                        on {run.runnerId}
                        {run.harness ? ` · ${run.harness}` : ''}
                    </span>
                )}
            </h3>
            <p className="rl-prompt">{run.prompt}</p>
            {run.status === 'queued' && <p className="rl-none">waiting for a runner to claim it</p>}
            {lines.length > 0 && (
                <ol className="rl-lines">
                    {lines.map((l) => (
                        <li key={l.key} className={l.kind}>
                            <time>{clock(l.at)}</time>
                            <span>{l.text}</span>
                        </li>
                    ))}
                </ol>
            )}
            {run.error && <pre className="rl-error">{run.error}</pre>}
        </div>
    );
}
