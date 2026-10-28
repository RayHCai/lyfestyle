import { z } from 'zod';

/** Whether `Intl` knows `zone`, e.g. `America/New_York`. */
export function isTimeZone(zone: string): boolean {
    try {
        // oxlint-disable-next-line no-new -- the constructor throws on an unknown zone
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** An IANA time zone name, for query strings and tool inputs. */
export const timeZone = z.string().refine(isTimeZone, 'Unknown IANA time zone');
