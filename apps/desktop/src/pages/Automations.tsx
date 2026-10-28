import { useCallback, useEffect, useRef, useState } from 'react';
import Masthead from '../components/Masthead';
import DeployCard from '../components/DeployCard';
import Timeline from '../components/Timeline';
import { confirmAction } from '../components/Confirm';
import { useAttempt, type Attempt } from '../hooks/useAttempt';
import type { ApiAutomationRunSummary, ApiTimeline } from '../lib/api';
import { describeCron } from '../lib/cron';
import { addDays, dayLabel, relativeTime, startOfDay, when } from '../lib/time';
import { getApi, useData } from '../store/data';

export default function Automations() {
    const mode = useData((s) => s.mode);
    if (mode !== 'api')
        return (
            <div className="page">
                <div className="page-narrow auto">
                    <Masthead eyebrow="server only" title="Automations" />
                    <p className="note">
                        Automations run on the Lyfestyle server. Connect it in settings to see and
                        approve them.
                    </p>
                </div>
            </div>
        );
    return <Remote />;
}

function Remote() {
    const automations = useData((s) => s.automations);
    const deploys = useData((s) => s.deploys);
    const loadAutomations = useData((s) => s.loadAutomations);
    const [day, setDay] = useState(() => startOfDay(Date.now()));
    const [now, setNow] = useState(() => Date.now());
    const [timeline, setTimeline] = useState<ApiTimeline | null>(null);
    const [problem, attempt] = useAttempt();
    /** Numbers each load; a response that a newer load overtook (paging days quickly) is dropped. */
    const loads = useRef(0);

    const load = useCallback(async () => {
        const n = ++loads.current;
        await attempt(async () => {
            const api = getApi();
            if (!api) return;
            const [t] = await Promise.all([
                api.timeline(new Date(day), new Date(addDays(day, 1))),
                loadAutomations(),
            ]);
            if (n !== loads.current) return;
            setTimeline(t);
            setNow(Date.now());
        });
    }, [attempt, day, loadAutomations]);

    // Poll while the page is open: faster while something is running so its mark grows and ends.
    const running =
        automations.some((a) => a.lastRun?.status === 'running') ||
        !!timeline?.runs.some((r) => r.status === 'running');
    useEffect(() => {
        // oxlint-disable-next-line react/set-state-in-effect -- load fetches first; state is set after the await
        void load();
        const t = setInterval(
            () => {
                if (document.visibilityState === 'visible') void load();
            },
            running ? 4_000 : 15_000,
        );
        return () => clearInterval(t);
    }, [load, running]);

    const today = startOfDay(now) === day;
    const enabled = automations.filter((a) => a.enabled).length;
    const eyebrow = automations.length
        ? `${automations.length} deployed · ${enabled} scheduled`
        : 'none deployed';

    return (
        <div className="page">
            <div className="page-narrow auto">
                <Masthead eyebrow={eyebrow} title="Automations" />
                {problem && <div className="err select-text">{problem}</div>}

                {deploys.length > 0 && (
                    <section className="auto-sec">
                        <h2 className="sec-h">
                            awaiting approval <span>{deploys.length}</span>
                        </h2>
                        {deploys.map((d) => (
                            <DeployCard key={d.id} deploy={d} attempt={attempt} onDecided={load} />
                        ))}
                    </section>
                )}

                <section className="auto-sec">
                    <div className="sec-head">
                        <h2 className="sec-h">{today ? 'today' : dayLabel(day)}</h2>
                        <div className="day-nav">
                            <button
                                className="step"
                                aria-label="Previous day"
                                onClick={() => setDay((d) => addDays(d, -1))}
                            >
                                ‹
                            </button>
                            <span>{dayLabel(day)}</span>
                            <button
                                className="step"
                                aria-label="Next day"
                                onClick={() => setDay((d) => addDays(d, 1))}
                            >
                                ›
                            </button>
                            {!today && (
                                <button
                                    className="btn"
                                    onClick={() => setDay(startOfDay(Date.now()))}
                                >
                                    today
                                </button>
                            )}
                        </div>
                    </div>
                    <Timeline day={day} now={now} automations={automations} data={timeline} />
                </section>

                <section className="auto-sec">
                    <h2 className="sec-h">deployed</h2>
                    {automations.length === 0 && (
                        <p className="empty">None yet. Ask the agent to build one.</p>
                    )}
                    <div className="rows">
                        {automations.map((a) => (
                            <AutomationRow key={a.id} id={a.id} attempt={attempt} reload={load} />
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}

/** The last run in a word or two: `running`, `ok 3h`, `failed 2d`, `cancelled 5m`, `never run`. */
function lastRunLabel(last: ApiAutomationRunSummary | null | undefined): string {
    if (!last) return 'never run';
    if (last.status === 'running') return 'running';
    const word = last.status === 'succeeded' ? 'ok' : last.status;
    return `${word} ${relativeTime(Date.parse(last.startedAt))}`;
}

function AutomationRow({
    id,
    attempt,
    reload,
}: {
    id: string;
    attempt: Attempt;
    reload: () => Promise<void>;
}) {
    const a = useData((s) => s.automations.find((x) => x.id === id));
    const setEnabled = useData((s) => s.setAutomationEnabled);
    const remove = useData((s) => s.deleteAutomation);
    const trigger = useData((s) => s.triggerAutomation);
    /** The switch's request is in flight; a second flip would race it. */
    const [switching, setSwitching] = useState(false);
    if (!a) return null;

    const last = a.lastRun;
    const next = a.enabled && a.nextRunAt ? `next ${when(a.nextRunAt)}` : 'paused';
    const del = async () => {
        if (!(await confirmAction(`Delete "${a.name}"? This cannot be undone.`))) return;
        await attempt(() => remove(a.id));
    };
    const toggle = async (on: boolean) => {
        setSwitching(true);
        await attempt(() => setEnabled(a.id, on));
        setSwitching(false);
    };

    return (
        <div className="row auto-row">
            <div className="open">
                <span className="t">
                    {a.name}
                    <span className="d">{a.description || ' '}</span>
                </span>
                <span className="c sched" title={`${a.schedule} · ${a.timezone}`}>
                    {describeCron(a.schedule)}
                </span>
                <span className="c next">{next}</span>
                <span className={'c last ' + (last?.status ?? '')}>{lastRunLabel(last)}</span>
            </div>
            <span className="acts">
                <button
                    className="btn"
                    disabled={last?.status === 'running'}
                    onClick={() => void attempt(() => trigger(a.id)).then(reload)}
                >
                    run now
                </button>
                <button className="btn danger" onClick={() => void del()}>
                    delete
                </button>
            </span>
            <label className="switch" aria-label={a.enabled ? 'Pause' : 'Resume'}>
                <input
                    type="checkbox"
                    checked={a.enabled}
                    disabled={switching}
                    onChange={(e) => void toggle(e.target.checked)}
                />
                <i />
            </label>
        </div>
    );
}
