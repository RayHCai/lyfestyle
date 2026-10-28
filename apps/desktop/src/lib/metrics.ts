/** Page views as the page-views screen shows them: a run of days per site. */
import type { ApiViewTotals } from './api';
import { addDays } from './time';

export interface DayViews extends ApiViewTotals {
    /** Local midnight in epoch ms. */
    day: number;
}

/** `YYYY-MM-DD` for a local midnight, the key the API's `groupBy=day` answers with. */
export function dayKey(day: number): string {
    const d = new Date(day);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The `n` days ending with `last`, oldest first, with zeros for days the API left out. */
export function fillDays(
    groups: (ApiViewTotals & { key: string | null })[],
    last: number,
    n: number,
): DayViews[] {
    const byKey = new Map(groups.map((g) => [g.key, g]));
    return Array.from({ length: n }, (_, i) => {
        const day = addDays(last, i - (n - 1));
        const g = byKey.get(dayKey(day));
        return { day, views: g?.views ?? 0, visitors: g?.visitors ?? 0 };
    });
}

/** The smallest of 1, 2, 5 × 10ⁿ at or above `max`, so the axis top is a round number. */
export function axisTop(max: number): number {
    if (max <= 1) return 1;
    const unit = 10 ** Math.floor(Math.log10(max));
    return ([1, 2, 5, 10].find((m) => m * unit >= max) ?? 10) * unit;
}

/** "980", "1,284", "12.9k", "4.2m". */
export function compactCount(n: number): string {
    if (n < 10_000) return n.toLocaleString('en-US');
    if (n < 1_000_000) return `${+(n / 1000).toFixed(1)}k`;
    return `${+(n / 1_000_000).toFixed(1)}m`;
}

/** A site as a heading: the host, and the scheme only when it is not https. */
export const siteLabel = (origin: string) => origin.replace(/^https:\/\//, '');
