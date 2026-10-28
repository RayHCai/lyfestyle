import type { Config } from '../config.js';
import { badRequest, unavailable, unreachable, upstream } from '../lib/errors.js';

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;

interface Email {
    to: string[];
    subject: string;
    text?: string | undefined;
    html?: string | undefined;
    cc?: string[] | undefined;
    bcc?: string[] | undefined;
    replyTo?: string | undefined;
}

function idOf(body: string): string | null {
    try {
        const { id } = JSON.parse(body) as { id?: unknown };
        return typeof id === 'string' ? id : null;
    } catch {
        return null;
    }
}

export type Resend = ReturnType<typeof createResend>;

export function createResend(deps: { config: Config; fetch: typeof fetch }) {
    return {
        get configured() {
            return deps.config.resend !== undefined;
        },

        get from() {
            return deps.config.resend?.from ?? null;
        },

        async send(email: Email) {
            const resend = deps.config.resend;
            if (!resend)
                throw unavailable('Email is not configured: set RESEND_API_KEY and RESEND_FROM');
            if (!email.text && !email.html) throw badRequest('An email needs a text or html body');
            const res = await deps
                .fetch(RESEND_URL, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${resend.apiKey}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: resend.from,
                        to: email.to,
                        subject: email.subject,
                        ...(email.text ? { text: email.text } : {}),
                        ...(email.html ? { html: email.html } : {}),
                        ...(email.cc?.length ? { cc: email.cc } : {}),
                        ...(email.bcc?.length ? { bcc: email.bcc } : {}),
                        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
                    }),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                })
                .catch((err: unknown) => {
                    throw unreachable('Resend', err);
                });
            const text = await res.text().catch(() => '');
            if (!res.ok) throw upstream('Resend', res.status, text);
            // Accepted means sent: an unreadable body must not report the email as failed.
            return { id: idOf(text), from: resend.from, to: email.to };
        },
    };
}
