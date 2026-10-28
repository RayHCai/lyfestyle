/** Times and days as the app shows them. Days are local midnights in epoch ms. */

/** "14:05" (or the locale's form of it). */
export const clock = (t: string | number | Date) =>
    new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** The midnight `n` calendar days from `day`, which is not always n × 24 h (daylight saving). */
export function addDays(day: number, n: number): number {
    const d = new Date(day);
    d.setDate(d.getDate() + n);
    return d.getTime();
}

/** A time today, or the weekday and time for any other day: "14:05", "tue 09:00". */
export function when(iso: string, now = Date.now()): string {
    const t = Date.parse(iso);
    if (startOfDay(t) === startOfDay(now)) return clock(t);
    const weekday = new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday.toLowerCase()} ${clock(t)}`;
}

/** "tue 27 oct". */
export const dayLabel = (day: number) =>
    new Date(day)
        .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
        .toLowerCase();

/** "27 oct". */
export const shortDay = (day: number) =>
    new Date(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).toLowerCase();

/** The front page's date line, e.g. "Tuesday 27 October". */
export function todayLabel(date = new Date()): string {
    return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** "now", "5m", "3h", "2d", then the date. */
export function relativeTime(ts: number, now = Date.now()): string {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d}d`;
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "just now", "5m ago", or "on 20 Oct" once relativeTime falls back to a date. */
export function agoLabel(ts: number, now = Date.now()): string {
    const t = relativeTime(ts, now);
    return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
}

/** "42s", "3m 5s", "1h 20m". */
export function duration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const cost = (usd: number) =>
    usd === 0 ? '$0' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
