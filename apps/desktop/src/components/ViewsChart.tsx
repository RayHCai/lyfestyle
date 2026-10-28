import { useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { axisTop, compactCount, type DayViews } from '../lib/metrics';
import { dayLabel, shortDay } from '../lib/time';

type Hover = { x: number; y: number; right: boolean; day: DayViews };

/** Custom properties the stylesheet places with: `--n` (columns), `--h` (height), `--at` (left). */
const place = (vars: Record<string, string>) => vars as CSSProperties;

/** Views per day for one site: a column per day up from a dashed baseline, a tooltip per column. */
export default function ViewsChart({ days }: { days: DayViews[] }) {
    const box = useRef<HTMLElement>(null);
    const [hover, setHover] = useState<Hover | null>(null);
    const first = days[0];
    if (!first) return null;
    const peak = days.reduce((a, b) => (b.views > a.views ? b : a), first);
    const top = axisTop(peak.views);
    const mid = Math.floor((days.length - 1) / 2);
    const middle = days[mid];
    const centre = (i: number) => `${((i + 0.5) / days.length) * 100}%`;

    const point = (e: MouseEvent, day: DayViews) => {
        const r = box.current?.getBoundingClientRect();
        if (!r) return;
        const x = e.clientX - r.left;
        setHover({ day, x, y: e.clientY - r.top, right: x > r.width * 0.6 });
    };

    return (
        <figure
            className="vc"
            ref={box}
            aria-label={`Views per day since ${dayLabel(first.day)}; peak ${peak.views} on ${dayLabel(peak.day)}`}
        >
            <div className="vc-plot">
                <div className="vc-y" aria-hidden="true">
                    <span className="top">{compactCount(top)}</span>
                    {top > 1 && <span className="mid">{compactCount(top / 2)}</span>}
                    <span className="zero">0</span>
                </div>
                <div
                    className="vc-cols"
                    aria-hidden="true"
                    style={place({ '--n': String(days.length) })}
                    onMouseLeave={() => setHover(null)}
                >
                    <i className="vc-grid top" />
                    {top > 1 && <i className="vc-grid" />}
                    {days.map((d) => (
                        <span
                            key={d.day}
                            className={
                                'vc-col' +
                                (d.views ? '' : ' zero') +
                                (hover?.day.day === d.day ? ' on' : '')
                            }
                            onMouseEnter={(e) => point(e, d)}
                            onMouseMove={(e) => point(e, d)}
                        >
                            <i style={place({ '--h': `${(d.views / top) * 100}%` })} />
                        </span>
                    ))}
                </div>
            </div>
            <div className="vc-x" aria-hidden="true">
                <span>{shortDay(first.day)}</span>
                {middle && days.length > 2 && (
                    <span className="mid" style={place({ '--at': centre(mid) })}>
                        {shortDay(middle.day)}
                    </span>
                )}
                <span className="end">today</span>
            </div>
            {hover && (
                <div
                    className={'tl-tip' + (hover.right ? ' right' : '')}
                    style={place({ '--x': `${hover.x}px`, '--y': `${hover.y}px` })}
                >
                    <b>{dayLabel(hover.day.day)}</b>
                    <span>
                        {hover.day.views.toLocaleString('en-US')} views ·{' '}
                        {hover.day.visitors.toLocaleString('en-US')} visitors
                    </span>
                </div>
            )}
        </figure>
    );
}
