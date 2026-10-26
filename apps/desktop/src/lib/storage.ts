import { call, isTauri } from './tauri';

const PREFIX = 'lyf:';

/** Browser fallback so the UI can be developed with `npm run dev` outside Tauri. */
const browser = {
    async read(key: string) {
        try {
            return localStorage.getItem(PREFIX + key);
        } catch {
            return null;
        }
    },
    async write(key: string, value: string) {
        try {
            localStorage.setItem(PREFIX + key, value);
        } catch {
            /* storage unavailable */
        }
    },
    async del(key: string) {
        try {
            localStorage.removeItem(PREFIX + key);
        } catch {
            /* storage unavailable */
        }
    },
    async list(prefix: string) {
        const out: string[] = [];
        try {
            const p = PREFIX + prefix + (prefix.endsWith('/') ? '' : '/');
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i) ?? '';
                if (k.startsWith(p)) out.push(k.slice(p.length));
            }
        } catch {
            /* storage unavailable */
        }
        return out.sort();
    },
    async dir() {
        return 'browser storage';
    },
};

export const storage = {
    read: (key: string): Promise<string | null> =>
        isTauri ? call<string | null>('storage_read', { key }) : browser.read(key),
    write: (key: string, value: string): Promise<void> =>
        isTauri ? call<void>('storage_write', { key, value }) : browser.write(key, value),
    del: (key: string): Promise<void> =>
        isTauri ? call<void>('storage_delete', { key }) : browser.del(key),
    list: (prefix: string): Promise<string[]> =>
        isTauri ? call<string[]>('storage_list', { prefix }) : browser.list(prefix),
    dir: (): Promise<string> => (isTauri ? call<string>('storage_dir') : browser.dir()),
};

export async function readJSON<T>(key: string, fallback: T): Promise<T> {
    const raw = await storage.read(key);
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function writeJSON(key: string, value: unknown) {
    return storage.write(key, JSON.stringify(value, null, 2));
}
