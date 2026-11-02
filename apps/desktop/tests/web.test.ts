import { beforeEach, describe, expect, it, vi } from 'vitest';

// The web build outside a browser: localStorage is a Map and the API a fake fetch.
const local = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    key: (i: number) => [...local.keys()][i] ?? null,
    get length() {
        return local.size;
    },
});

const API = 'https://api.test';
const PASSWORD = 'correct horse battery';

/** What the fake API saw, and whether it still takes the token it handed out. */
const api = { requests: [] as { method: string; path: string; auth: string | null }[], live: true };

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refused = (message: string) => json(401, { error: { code: 'unauthorized', message } });

vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const auth = new Headers(init.headers).get('authorization');
    api.requests.push({ method, path: url.pathname, auth });
    if (url.pathname === '/auth/login') {
        const { password } = JSON.parse(String(init.body)) as { password: string };
        return password === PASSWORD ? json(200, { token: 'dash-1' }) : refused('Wrong password');
    }
    if (auth !== 'Bearer dash-1' || !api.live) return refused('Missing or invalid bearer token');
    if (url.pathname === '/sync/pull') return json(200, { pages: [], cursor: '0', hasMore: false });
    if (url.pathname === '/conversations') return json(200, { items: [], nextCursor: null });
    return json(200, { items: [] });
});

/** A fresh web build: modules read `MODE` and `VITE_API_URL` when they load. */
async function webBuild(apiUrl = API) {
    vi.resetModules();
    vi.stubEnv('MODE', 'web');
    vi.stubEnv('VITE_API_URL', apiUrl);
    return (await import('../src/store/data')).useData;
}

beforeEach(() => {
    local.clear();
    api.requests = [];
    api.live = true;
});

describe('web build sign-in', () => {
    it('stays signed out until the password buys a token, then uses only that', async () => {
        const useData = await webBuild();
        await useData.getState().load();
        expect(useData.getState()).toMatchObject({ ready: true, mode: 'local' });
        expect(api.requests).toEqual([]);

        await expect(useData.getState().signIn('a wrong guess')).rejects.toThrow('Wrong password.');
        expect(local.has('lyf:token.json')).toBe(false);

        await useData.getState().signIn(PASSWORD);
        expect(useData.getState()).toMatchObject({ mode: 'api', api: { state: 'ok', url: API } });
        const logins = api.requests.filter((r) => r.path === '/auth/login');
        expect(logins.map((r) => r.auth)).toEqual([null, null]);
        const calls = api.requests.filter((r) => r.path !== '/auth/login');
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((r) => r.auth === 'Bearer dash-1')).toBe(true);
    });

    it('comes back signed in, and drops a token pasted into an earlier build', async () => {
        local.set('lyf:token.json', JSON.stringify({ token: 'dash-1' }));
        local.set(
            'lyf:settings.json',
            JSON.stringify({ name: 'Ray', apiUrl: 'https://old.test', apiToken: 'root-token' }),
        );
        const useData = await webBuild();
        await useData.getState().load();
        expect(useData.getState()).toMatchObject({ mode: 'api', api: { url: API } });
        const settings = JSON.parse(local.get('lyf:settings.json') ?? '{}');
        expect(settings).toMatchObject({ name: 'Ray', apiUrl: '', apiToken: '' });
        expect(api.requests.some((r) => r.auth === 'Bearer root-token')).toBe(false);
    });

    it('signs out when the API stops taking the token', async () => {
        local.set('lyf:token.json', JSON.stringify({ token: 'dash-1' }));
        const useData = await webBuild();
        await useData.getState().load();
        expect(useData.getState().mode).toBe('api');

        api.live = false;
        await useData.getState().refresh();
        expect(useData.getState().mode).toBe('local');
        expect(local.has('lyf:token.json')).toBe(false);
    });

    it('cannot sign in when built without an API', async () => {
        local.set('lyf:token.json', JSON.stringify({ token: 'dash-1' }));
        const useData = await webBuild('');
        await useData.getState().load();
        expect(useData.getState().mode).toBe('local');
        expect(api.requests).toEqual([]);
    });
});
