import type { Config } from '../config.js';
import { safeEqual, type SecretBox } from '../lib/crypto.js';
import { forbidden, rateLimited, unauthorized } from '../lib/errors.js';
import { createRateLimiter } from '../lib/rate-limit.js';

/** How long a dashboard token lasts before the password is asked for again. */
export const DASHBOARD_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** Password attempts per minute, from anyone: one person signing in never needs more, and a
 *  shared bucket cannot be dodged by spreading guesses over many addresses. */
const ATTEMPTS_PER_MINUTE = 5;

export interface AuthDeps {
    config: Config;
    secrets: SecretBox;
    now: () => Date;
}

/**
 * Password sign-in for the web dashboard, which cannot hold the root `API_TOKEN`: the password
 * buys a signed dashboard token instead. The tokens are stateless, so they survive restarts; each
 * carries a digest of the password, so setting a new one signs every browser out.
 */
export function createAuthService({ config, secrets, now }: AuthDeps) {
    const password = config.dashboardPassword;
    const generation = password === undefined ? undefined : secrets.digest(`dashboard:${password}`);
    const attempts = createRateLimiter({ perMinute: ATTEMPTS_PER_MINUTE });

    return {
        login(input: string): { token: string } {
            if (password === undefined) {
                throw forbidden('Password sign-in is off: DASHBOARD_PASSWORD is not set');
            }
            if (!attempts.take('login', now().getTime())) {
                throw rateLimited('Too many sign-in attempts; try again in a minute');
            }
            if (!safeEqual(input, password)) throw unauthorized('Wrong password');
            return {
                token: secrets.sign({ kind: 'dashboard', generation }, DASHBOARD_TOKEN_TTL_MS),
            };
        },

        /** Whether `token` is an unexpired dashboard token from the current password. */
        authorize(token: string): boolean {
            if (generation === undefined) return false;
            const payload = secrets.verify<{ kind?: unknown; generation?: unknown }>(token);
            return (
                payload?.kind === 'dashboard' &&
                typeof payload.generation === 'string' &&
                safeEqual(payload.generation, generation)
            );
        },
    };
}

export type AuthService = ReturnType<typeof createAuthService>;
