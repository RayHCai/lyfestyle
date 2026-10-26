import { z } from 'zod';

const DAY_MS = 86_400_000;

/** A calendar day in the user's own time zone, `YYYY-MM-DD`. */
export const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .refine((value) => toUtc(value).toISOString().startsWith(value), 'Not a real calendar day');

function toUtc(date: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
}

function fromUtc(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
    return fromUtc(new Date(toUtc(date).getTime() + days * DAY_MS));
}

/** The Sunday that starts the week holding `date`. */
export function weekStart(date: string): string {
    return addDays(date, -toUtc(date).getUTCDay());
}

export function monthStart(date: string): string {
    return `${date.slice(0, 7)}-01`;
}
