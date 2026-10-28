/** Plain-words reading of the cron shapes automations usually use; anything else stays raw. */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const num = /^\d{1,2}$/;
const nums = /^\d{1,2}(,\d{1,2})*$/;

const pad = (n: string) => n.padStart(2, '0');

function days(field: string): string | null {
    if (field === '*') return 'daily';
    if (field === '1-5') return 'weekdays';
    if (field === '0,6' || field === '6,0' || field === '6,7' || field === '6-7') return 'weekends';
    if (!nums.test(field)) return null;
    // 0-7, where 7 is Sunday again; a larger number is not a day.
    const names = field.split(',').map((d) => (Number(d) <= 7 ? DAYS[Number(d) % 7] : undefined));
    return names.every(Boolean) ? names.join(', ') : null;
}

const ordinal = (n: number) =>
    n +
    (n % 10 === 1 && n !== 11
        ? 'st'
        : n % 10 === 2 && n !== 12
          ? 'nd'
          : n % 10 === 3 && n !== 13
            ? 'rd'
            : 'th');

export function describeCron(expr: string): string {
    let fields = expr.trim().split(/\s+/);
    // Six fields lead with seconds; a fixed second does not change how the schedule reads.
    if (fields.length === 6 && num.test(fields[0]!)) fields = fields.slice(1);
    if (fields.length !== 5) return expr;
    const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
    if (month !== '*') return expr;

    if (dom === '*' && dow === '*') {
        if (min === '*' && hour === '*') return 'every minute';
        let m = /^\*\/(\d{1,2})$/.exec(min);
        if (m && hour === '*') return `every ${m[1]} min`;
        if (num.test(min) && hour === '*') return `hourly at :${pad(min)}`;
        m = /^\*\/(\d{1,2})$/.exec(hour);
        if (m && num.test(min)) return `every ${m[1]} h at :${pad(min)}`;
    }
    if (!num.test(min) || !nums.test(hour)) return expr;
    const at = hour
        .split(',')
        .map((h) => `${pad(h)}:${pad(min)}`)
        .join(', ');
    if (dom === '*') {
        const d = days(dow);
        return d ? `${d} at ${at}` : expr;
    }
    if (num.test(dom) && dow === '*') return `monthly on the ${ordinal(Number(dom))} at ${at}`;
    return expr;
}
