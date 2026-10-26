export function id(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function greeting(name: string, date = new Date()): string {
    const h = date.getHours();
    const part =
        h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return name.trim() ? `${part}, ${name.trim()}` : part;
}

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

export function titleFrom(text: string, max = 56): string {
    const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
    return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line || 'Untitled';
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
    let t: ReturnType<typeof setTimeout> | undefined;
    return (...args: A) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}
