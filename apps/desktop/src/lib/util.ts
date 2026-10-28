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

export function titleFrom(text: string, max = 56): string {
    const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ');
    return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line || 'Untitled';
}

/** A call held back until `ms` pass without another; `flush` makes a held call now. */
export interface Debounced<A extends unknown[]> {
    (...args: A): void;
    flush(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
    let t: ReturnType<typeof setTimeout> | undefined;
    let held: A | null = null;
    const flush = () => {
        clearTimeout(t);
        const args = held;
        held = null;
        if (args) fn(...args);
    };
    return Object.assign(
        (...args: A) => {
            held = args;
            clearTimeout(t);
            t = setTimeout(flush, ms);
        },
        { flush },
    );
}
