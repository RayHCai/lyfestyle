/**
 * The hosted web build's connection. Its API is fixed when it is built (`VITE_API_URL`), and the
 * dashboard password buys a token from `POST /auth/login` that stays in the browser until it
 * expires or the password changes. The root `API_TOKEN` never reaches the browser.
 */
import { Api, ApiError } from './api';
import { readJSON, storage, writeJSON } from './storage';

/** Where the dashboard token is kept; `storage.ts` keeps it in the browser. */
export const TOKEN_FILE = 'token.json';

/** The web build's API, or '' when it was built without `VITE_API_URL`. */
export const WEB_API_URL = (import.meta.env.VITE_API_URL ?? '').trim();

/** The dashboard token, or '' before signing in. */
export async function readToken(): Promise<string> {
    const stored = await readJSON<{ token?: unknown } | null>(TOKEN_FILE, null);
    return typeof stored?.token === 'string' ? stored.token : '';
}

/** Trades the password for a dashboard token and keeps it. */
export async function signIn(password: string): Promise<void> {
    let token: string;
    try {
        ({ token } = await new Api({ baseUrl: WEB_API_URL, token: '' }).login(password));
    } catch (e) {
        // A 401 here is the password, not a token as `describeError` would put it.
        if (e instanceof ApiError && e.status === 401)
            throw new Error('Wrong password.', { cause: e });
        throw e;
    }
    await writeJSON(TOKEN_FILE, { token });
}

export const signOut = () => storage.del(TOKEN_FILE);
