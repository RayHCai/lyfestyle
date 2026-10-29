import { useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { DAY_MS } from '@lyfestyle/shared';
import type { ApiAutomation, ApiTimeline } from '../lib/api';
import { clock, cost, duration } from '../lib/time';

const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

type Run = ApiTimeline['runs'][number];
type Slot = ApiTimeline['upcoming'][number];
type Hover = { x: number; y: number; right: boolean; run?: Run; slot?: Slot };

/** Custom properties the stylesheet positions marks with: `--at` (left), `--w` (width). */
const place = (vars: Record<string, string>) => vars as CSSProperties;

interface Lane {
    id: string;
    name: string;
    runs: Run[];
    slots: Slot[];
}

/** One lane per automation, so lanes keep their order (and empty ones still show) from day to day. */
function lanes(automations: ApiAutomation[], data: ApiTimeline | null): Lane[] {
    const byId = new Map<string, Lane>();
    for (const a of automations) byId.set(a.id, { id: a.id, name: a.name, runs: [], slots: [] });
    const lane = (id: string, name: string) => {
        let l = byId.get(id);
        if (!l) byId.set(id, (l = { id, name, runs: [], slots: [] }));
        return l;
    };
    for (const r of data?.runs ?? []) lane(r.automationId, r.name).runs.push(r);
    for (const s of data?.upcoming ?? []) lane(s.automationId, s.name).slots.push(s);
    return [...byId.values()];
}

/** A 24-hour day: hour ticks along the top, a lane per automation, a mark per run. */
export default function Timeline(props: {
    day: number;
    now: number;
    automations: ApiAutomation[];
    data: ApiTimeline | null;
    /** Opens a run's log when its mark is clicked. */
    onOpen: (automationId: string, runId: string) => void;
}) {
    const { day, now, automations, data, onOpen } = props;
    const box = useRef<HTMLDivElement>(null);
    const [hover, setHover] = useState<Hover | null>(null);
    const pct = (t: number) => `${(Math.min(Math.max(t - day, 0), DAY_MS) / DAY_MS) * 100}%`;
    const width = (from: number, to: number) => `${(Math.max(0, to - from) / DAY_MS) * 100}%`;
    const today = now >= day && now < day + DAY_MS;
    const all = lanes(automations, data);

    const point = (e: MouseEvent, item: Omit<Hover, 'x' | 'y' | 'right'>) => {
        const r = box.current?.getBoundingClientRect();
        if (!r) return;
        const x = e.clientX - r.left;
        setHover({ ...item, x, y: e.clientY - r.top, right: x > r.width * 0.6 });
    };

    return (
        <div className="tl" ref={box} onMouseLeave={() => setHover(null)}>
            <div className="tl-row tl-axis" aria-hidden="true">
                <span className="tl-name" />
                <div className="tl-track">
                    {HOURS.map((h) => (
                        <span
                            key={h}
                            className={'tl-hour' + (h % 6 ? ' minor' : '')}
                            style={place({ '--at': `${(h / 24) * 100}%` })}
                        >
                            {String(h).padStart(2, '0')}
                        </span>
                    ))}
                </div>
            </div>
            {all.length === 0 && <p className="empty tl-empty">No automations yet.</p>}
            {all.map((l) => (
                <div className="tl-row" key={l.id}>
                    <span className="tl-name" title={l.name}>
                        {l.name}
                    </span>
                    <div className="tl-track lane">
                        {HOURS.slice(1).map((h) => (
                            <i
                                key={h}
                                className="tl-grid"
                                style={place({ '--at': `${(h / 24) * 100}%` })}
                            />
                        ))}
                        {l.slots.map((s) => (
                            <span
                                key={s.at}
                                className="tl-mark upcoming"
                                style={place({ '--at': pct(Date.parse(s.at)) })}
                                onMouseEnter={(e) => point(e, { slot: s })}
                                onMouseMove={(e) => point(e, { slot: s })}
                            />
                        ))}
                        {l.runs.map((r) => {
                            const start = Date.parse(r.startedAt);
                            const end = r.finishedAt ? Date.parse(r.finishedAt) : now;
                            return (
                                <button
                                    key={r.id}
                                    className={'tl-mark ' + r.status}
                                    aria-label={`${r.name} at ${clock(start)}: ${r.status}. Show its log`}
                                    style={place({ '--at': pct(start), '--w': width(start, end) })}
                                    onMouseEnter={(e) => point(e, { run: r })}
                                    onMouseMove={(e) => point(e, { run: r })}
                                    onClick={() => onOpen(r.automationId, r.id)}
                                />
                            );
                        })}
                        {today && <i className="tl-now" style={place({ '--at': pct(now) })} />}
                    </div>
                </div>
            ))}
            {hover && (
                <div
                    className={'tl-tip' + (hover.right ? ' right' : '')}
                    style={place({ '--x': `${hover.x}px`, '--y': `${hover.y}px` })}
                >
                    {hover.run ? <RunTip run={hover.run} now={now} /> : null}
                    {hover.slot ? (
                        <>
                            <b>{hover.slot.name}</b>
                            <span>scheduled {clock(hover.slot.at)}</span>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function RunTip({ run, now }: { run: Run; now: number }) {
    const start = Date.parse(run.startedAt);
    const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
    const error = run.error?.split('\n')[0];
    return (
        <>
            <b>{run.name}</b>
            <span>
                {clock(start)} · {run.trigger === 'manual' ? 'run by hand' : 'scheduled'} · v
                {run.version}
            </span>
            <span className={run.status}>
                {run.status} · {duration(end - start)} · {cost(run.costUsd)}
            </span>
            {/* A cancelled run says why (deleted, paused, shut down) without reading as a failure. */}
            {error && (
                <span className={run.status === 'failed' ? 'failed' : undefined}>{error}</span>
            )}
        </>
    );
}
