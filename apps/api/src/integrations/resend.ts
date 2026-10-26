import type { Config } from '../config.js';
import { badRequest, unavailable, upstream } from '../lib/errors.js';

const RESEND_URL = 'https://api.resend.com/emails';

export interface Email {
    to: string[];
    subject: string;
    text?: string | undefined;
    html?: string | undefined;
    cc?: string[] | undefined;
    bcc?: string[] | undefined;
    replyTo?: string | undefined;
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
            const res = await deps.fetch(RESEND_URL, {
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
            });
            const text = await res.text();
            if (!res.ok) throw upstream('Resend', res.status, text);
            return { id: (JSON.parse(text) as { id: string }).id, from: resend.from, to: email.to };
        },
    };
}
