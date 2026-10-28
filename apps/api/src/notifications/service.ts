import type { Db } from '../db/client.js';

interface NewNotification {
    title: string;
    body?: string | undefined;
    /** Who sent it, e.g. the automation's name; shown when there is no body. */
    source?: string | undefined;
    automationId?: string | undefined;
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;

/** Desktop notifications: rows the app polls for and shows with the OS's own notifications. */
export function createNotificationsService(db: Db, now: () => Date) {
    return {
        create(input: NewNotification) {
            return db.notification.create({
                data: {
                    title: input.title,
                    body: input.body ?? null,
                    source: input.source ?? null,
                    automationId: input.automationId ?? null,
                    createdAt: now(),
                },
            });
        },

        /**
         * Oldest first after `after`; with no cursor, the newest `limit`, so a client can catch up.
         * `latestId` is the newest notification overall, where a fresh client starts its cursor.
         */
        async list(options: { after?: number | undefined; limit: number }) {
            const [items, latest] = await Promise.all([
                options.after === undefined
                    ? db.notification
                          .findMany({ orderBy: { id: 'desc' }, take: options.limit })
                          .then((rows) => rows.toReversed())
                    : db.notification.findMany({
                          where: { id: { gt: options.after } },
                          orderBy: { id: 'asc' },
                          take: options.limit,
                      }),
                db.notification.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }),
            ]);
            return { items, latestId: latest?.id ?? null };
        },
    };
}
