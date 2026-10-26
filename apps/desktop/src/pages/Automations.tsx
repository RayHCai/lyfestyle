import { useEffect, useState } from 'react';
import Markdown from '../components/Markdown';
import { useApp } from '../store/app';
import { localTimeZone, useData } from '../store/data';
import { describe, nextRun, runAutomation } from '../lib/scheduler';
import { id as newId, relativeTime } from '../lib/util';
import type { Automation, Trigger } from '../lib/types';

const blank = (): Automation => ({
    id: newId(),
    name: '',
    prompt: '',
    trigger: { type: 'daily', time: '08:00' },
    enabled: true,
    createdAt: Date.now(),
});

const ACTIVE = new Set(['queued', 'running']);

export default function Automations({ id }: { id?: string }) {
    const automations = useData((s) => s.automations);
    const mode = useData((s) => s.mode);
    const saveAutomation = useData((s) => s.saveAutomation);
    const deleteAutomation = useData((s) => s.deleteAutomation);
    const triggerAutomation = useData((s) => s.triggerAutomation);
    const loadLastRun = useData((s) => s.loadLastRun);
    const navigate = useApp((s) => s.navigate);
    const [sel, setSel] = useState<string>(id ?? automations[0]?.id ?? 'new');
    const existing = automations.find((a) => a.id === sel);
    const [draft, setDraft] = useState<Automation>(existing ?? blank());
    const [saved, setSaved] = useState(false);
    const [problem, setProblem] = useState<string | undefined>();
    const remote = mode === 'api';

    // Reset the form when the selection changes (not when a refresh replaces the object, which
    // would discard unsaved edits). Done during render so no effect has to set state.
    const selectionKey = sel + (existing ? ':saved' : ':new');
    const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
    if (selectionKey !== prevSelectionKey) {
        setPrevSelectionKey(selectionKey);
        setDraft(existing ?? blank());
        setSaved(false);
        setProblem(undefined);
    }

    // API mode: while the last run is queued or running, poll it; fetch its output once it ends.
    const lastRun = existing?.lastRun;
    useEffect(() => {
        if (!remote || !existing || !lastRun) return;
        if (ACTIVE.has(lastRun.status)) {
            const t = setInterval(() => {
                void loadLastRun(existing.id);
            }, 4000);
            return () => clearInterval(t);
        }
        if (lastRun.output === undefined && lastRun.error === undefined)
            void loadLastRun(existing.id);
    }, [remote, existing, lastRun, loadLastRun]);

    const set = (patch: Partial<Automation>) => {
        setDraft((d) => ({ ...d, ...patch }));
        setSaved(false);
    };
    const setTrigger = (t: Trigger) => set({ trigger: t, nextRunAt: undefined });
    const valid =
        draft.name.trim().length > 0 &&
        draft.prompt.trim().length > 0 &&
        (draft.trigger.type !== 'cron' || draft.trigger.expr.trim().length > 0);

    const attempt = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
        try {
            setProblem(undefined);
            return await fn();
        } catch (e) {
            setProblem(e instanceof Error ? e.message : String(e));
            return undefined;
        }
    };

    const save = async () => {
        if (!valid) return;
        const a: Automation = {
            ...draft,
            name: draft.name.trim(),
            nextRunAt: !remote && draft.enabled ? nextRun(draft) : undefined,
        };
        const stored = await attempt(() => saveAutomation(a));
        if (!stored) return;
        setSel(stored.id);
        setSaved(true);
    };
    const run = async () => {
        if (!valid) return;
        const a: Automation = { ...draft, name: draft.name.trim() };
        const stored = await attempt(() => saveAutomation(a));
        if (!stored) return;
        setSel(stored.id);
        if (remote) {
            await attempt(() => triggerAutomation(stored.id));
            return;
        }
        const cid = await runAutomation(stored);
        navigate({ name: 'conversation', id: cid });
    };

    const triggerKind = draft.trigger.type;
    return (
        <div className="two">
            <aside className="col-list">
                <div className="col-head">
                    <span>Automations</span>
                    <button
                        className="plus"
                        aria-label="New automation"
                        onClick={() => setSel('new')}
                    >
                        <svg viewBox="0 0 24 24">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    </button>
                </div>
                {automations.map((a) => (
                    <button
                        key={a.id}
                        className={'doc-row' + (a.id === sel ? ' active' : '')}
                        onClick={() => setSel(a.id)}
                    >
                        <i className={'dot' + (a.enabled ? '' : ' off')} />
                        <span className="t">{a.name}</span>
                        <span className="m">{describe(a)}</span>
                    </button>
                ))}
            </aside>
            <section className="col-main">
                <div className="form">
                    <h1 className="serif">{existing ? existing.name : 'New automation'}</h1>
                    <div className="field">
                        <label htmlFor="a-name">Name</label>
                        <input
                            id="a-name"
                            value={draft.name}
                            onChange={(e) => set({ name: e.target.value })}
                            placeholder="Morning briefing"
                        />
                    </div>
                    <div className="field">
                        <label htmlFor="a-prompt">Prompt</label>
                        <textarea
                            id="a-prompt"
                            value={draft.prompt}
                            onChange={(e) => set({ prompt: e.target.value })}
                            placeholder="What the agent should do each time this runs. It receives this text exactly as a new conversation."
                        />
                        <span className="note">
                            {remote
                                ? 'Each run is executed by the runner; its output shows below.'
                                : 'Each run becomes a conversation you can open from the sidebar.'}
                        </span>
                    </div>
                    <div className="field">
                        <label htmlFor="a-trigger">When</label>
                        <div className="inline">
                            <select
                                id="a-trigger"
                                value={triggerKind}
                                onChange={(e) => {
                                    const t = e.target.value as Trigger['type'];
                                    setTrigger(
                                        t === 'interval'
                                            ? { type: 'interval', minutes: 60 }
                                            : t === 'daily'
                                              ? { type: 'daily', time: '08:00' }
                                              : t === 'cron'
                                                ? { type: 'cron', expr: '0 9 * * 1-5' }
                                                : { type: 'manual' },
                                    );
                                }}
                            >
                                <option value="daily">Daily at</option>
                                <option value="interval">Every</option>
                                {remote ? (
                                    <option value="cron">Cron</option>
                                ) : (
                                    <option value="manual">Manual</option>
                                )}
                            </select>
                            {draft.trigger.type === 'daily' && (
                                <input
                                    id="a-time"
                                    type="time"
                                    value={draft.trigger.time}
                                    onChange={(e) =>
                                        setTrigger({ type: 'daily', time: e.target.value })
                                    }
                                />
                            )}
                            {draft.trigger.type === 'interval' && (
                                <>
                                    <input
                                        id="a-min"
                                        type="number"
                                        min={1}
                                        value={draft.trigger.minutes}
                                        onChange={(e) =>
                                            setTrigger({
                                                type: 'interval',
                                                minutes: Math.max(1, Number(e.target.value) || 1),
                                            })
                                        }
                                    />
                                    <span className="note">minutes</span>
                                </>
                            )}
                            {draft.trigger.type === 'cron' && (
                                <input
                                    id="a-cron"
                                    value={draft.trigger.expr}
                                    spellCheck={false}
                                    onChange={(e) =>
                                        setTrigger({ type: 'cron', expr: e.target.value })
                                    }
                                    placeholder="0 9 * * 1-5"
                                />
                            )}
                        </div>
                        <span className="note">
                            {remote
                                ? `Evaluated by the API in ${draft.timezone ?? localTimeZone()}. Intervals of an hour or more round to whole hours.`
                                : 'Scheduled runs happen while Lyfestyle is open.'}
                        </span>
                    </div>
                    <label className="switch">
                        <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(e) => set({ enabled: e.target.checked })}
                        />
                        <i />
                        {remote ? 'Scheduled' : 'Enabled'}
                    </label>
                    <div className="actions">
                        <button className="btn" disabled={!valid} onClick={() => void save()}>
                            {saved ? 'Saved' : 'Save'}
                        </button>
                        <button className="link" disabled={!valid} onClick={() => void run()}>
                            Run now
                        </button>
                        {existing && (
                            <button
                                className="link danger"
                                onClick={() => {
                                    void attempt(() => deleteAutomation(existing.id));
                                    setSel('new');
                                }}
                            >
                                Delete
                            </button>
                        )}
                    </div>
                    {problem && <div className="err select-text">{problem}</div>}
                    {existing && (
                        <div className="status">
                            {remote ? (
                                <>
                                    <span>
                                        Last run:{' '}
                                        <b>
                                            {lastRun
                                                ? `${relativeTime(lastRun.createdAt)} ago · ${lastRun.status}`
                                                : 'never'}
                                        </b>
                                    </span>
                                    <span>
                                        Next run:{' '}
                                        <b>
                                            {existing.enabled && existing.nextRunAt
                                                ? new Date(existing.nextRunAt).toLocaleString()
                                                : 'paused'}
                                        </b>
                                    </span>
                                    {lastRun?.error && (
                                        <div className="err select-text">{lastRun.error}</div>
                                    )}
                                    {lastRun?.output && (
                                        <div className="run-output select-text">
                                            <Markdown text={lastRun.output} />
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <span>
                                        Last run:{' '}
                                        <b>
                                            {existing.lastRunAt
                                                ? relativeTime(existing.lastRunAt) + ' ago'
                                                : 'never'}
                                        </b>
                                        {existing.lastConversationId && (
                                            <>
                                                {' '}
                                                ·{' '}
                                                <button
                                                    className="link"
                                                    onClick={() =>
                                                        navigate({
                                                            name: 'conversation',
                                                            id: existing.lastConversationId!,
                                                        })
                                                    }
                                                >
                                                    open
                                                </button>
                                            </>
                                        )}
                                    </span>
                                    <span>
                                        Next run:{' '}
                                        <b>
                                            {existing.enabled && existing.nextRunAt
                                                ? new Date(existing.nextRunAt).toLocaleString()
                                                : 'not scheduled'}
                                        </b>
                                    </span>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
