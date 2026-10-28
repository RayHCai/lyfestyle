import { useCallback, useEffect, useRef, useState } from 'react';
import Masthead from '../components/Masthead';
import CopyButton from '../components/CopyButton';
import ViewsChart from '../components/ViewsChart';
import { useAttempt } from '../hooks/useAttempt';
import type { ApiViewTotals } from '../lib/api';
import { compactCount, fillDays, siteLabel, type DayViews } from '../lib/metrics';
import { addDays, startOfDay } from '../lib/time';
import { getApi, useData } from '../store/data';

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

/** Each chart costs a request per load, so only the busiest sites get one; the table lists all. */
const CHARTED = 12;

interface Site extends ApiViewTotals {
    origin: string;
    /** Only for charted sites. */
    days?: DayViews[];
}

interface Report {
    range: Range;
    totals: ApiViewTotals;
    sites: Site[];
}

export default function PageViews() {
    const mode = useData((s) => s.mode);
    if (mode !== 'api')
        return (
            <div className="page">
                <div className="page-narrow auto pv">
                    <Masthead eyebrow="server only" title="Page views" />
                    <p className="note">
                        Page views are collected by the Lyfestyle server. Connect it in settings to
                        see them.
                    </p>
                </div>
            </div>
        );
    return <Remote />;
}

function Remote() {
    const [range, setRange] = useState<Range>(30);
    const [report, setReport] = useState<Report | null>(null);
    const [problem, attempt] = useAttempt();
    /** Numbers each load; one a newer load overtook (switching ranges quickly) is dropped. */
    const loads = useRef(0);

    const load = useCallback(async () => {
        const n = ++loads.current;
        await attempt(async () => {
            const api = getApi();
            if (!api) return;
            const last = startOfDay(Date.now());
            const from = new Date(addDays(last, 1 - range));
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const bySite = await api.viewSummary('origin', { from, timezone });
            const sites = bySite.groups.flatMap(({ key, views, visitors }) =>
                key ? [{ origin: key, views, visitors }] : [],
            );
            const daily = await Promise.all(
                sites
                    .slice(0, CHARTED)
                    .map((s) => api.viewSummary('day', { from, timezone, origin: s.origin })),
            );
            if (n !== loads.current) return;
            setReport({
                range,
                totals: bySite.totals,
                sites: sites.map((s, i) => {
                    const groups = daily[i]?.groups;
                    return groups ? { ...s, days: fillDays(groups, last, range) } : s;
                }),
            });
        });
    }, [attempt, range]);

    useEffect(() => {
        // oxlint-disable-next-line react/set-state-in-effect -- load fetches first; state is set after the await
        void load();
        const t = setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, 60_000);
        return () => clearInterval(t);
    }, [load]);

    const eyebrow = report?.sites.length
        ? `${compactCount(report.totals.views)} views · ${compactCount(report.totals.visitors)} visitors · ${report.range} days`
        : `last ${range} days`;
    const charted = report?.sites.filter((s) => s.days) ?? [];
    const uncharted = (report?.sites.length ?? 0) - charted.length;

    return (
        <div className="page">
            <div className="page-narrow auto pv">
                <Masthead eyebrow={eyebrow} title="Page views">
                    <div className="range">
                        {RANGES.map((r) => (
                            <button
                                key={r}
                                className={r === range ? 'on' : undefined}
                                aria-pressed={r === range}
                                onClick={() => setRange(r)}
                            >
                                {r}d
                            </button>
                        ))}
                    </div>
                </Masthead>
                {problem && <div className="err select-text">{problem}</div>}

                {report?.sites.length === 0 && <Empty days={report.range} />}

                {report && report.sites.length > 0 && (
                    <>
                        <section className="auto-sec">
                            <h2 className="sec-h">
                                sites <span>{report.sites.length}</span>
                            </h2>
                            <table className="pv-table">
                                <thead>
                                    <tr>
                                        <th className="n">#</th>
                                        <th>site</th>
                                        <th className="num">today</th>
                                        <th className="num">views</th>
                                        <th className="num">visitors</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.sites.map((s, i) => (
                                        <tr key={s.origin}>
                                            <td className="n">{String(i + 1).padStart(2, '0')}</td>
                                            <td className="site" title={s.origin}>
                                                {siteLabel(s.origin)}
                                            </td>
                                            <td className="num">
                                                {s.days
                                                    ? compactCount(s.days.at(-1)?.views ?? 0)
                                                    : ''}
                                            </td>
                                            <td className="num">{compactCount(s.views)}</td>
                                            <td className="num">{compactCount(s.visitors)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>

                        <section className="auto-sec">
                            <h2 className="sec-h">views per day</h2>
                            {charted.map((s) => (
                                <div className="pv-site" key={s.origin}>
                                    <div className="pv-site-head">
                                        <span className="t" title={s.origin}>
                                            {siteLabel(s.origin)}
                                        </span>
                                        <span className="m">
                                            {compactCount(s.views)} views ·{' '}
                                            {compactCount(s.visitors)} visitors
                                        </span>
                                    </div>
                                    <ViewsChart days={s.days ?? []} />
                                </div>
                            ))}
                            {uncharted > 0 && (
                                <p className="empty">
                                    {uncharted} quieter {uncharted === 1 ? 'site is' : 'sites are'}{' '}
                                    in the table only.
                                </p>
                            )}
                        </section>
                    </>
                )}
            </div>
        </div>
    );
}

/** No views yet: the one line a site needs to start reporting. */
function Empty({ days }: { days: number }) {
    const snippet = `<script src="${getApi()?.baseUrl ?? ''}/metrics/script.js" defer></script>`;
    return (
        <section className="auto-sec">
            <p className="empty">No views in the last {days} days. Add the tracker to a site:</p>
            <div className="pv-snippet">
                <code className="select-text">{snippet}</code>
                <CopyButton text={() => snippet} className="btn" />
            </div>
        </section>
    );
}
