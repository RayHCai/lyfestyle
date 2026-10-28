import { call, isTauri, isWeb } from './tauri';

const PREFIX = 'lyf:';

/** Browser fallback so the UI can be developed with `pnpm dev` outside Tauri. */
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
        return isWeb ? 'memory' : 'browser storage';
    },
};

const disk = {
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

/** The one file the web build keeps between visits: the API connection. */
const SETTINGS = 'settings.json';

/** Screenshot mode's writes, by key (null: deleted), once `keepInMemory` is on. The web build
 *  starts with it on and never reads other keys from disk, so nothing is cached offline. */
let memory: Map<string, string | null> | null = isWeb ? new Map() : null;

const inMemory = (key: string) => !!memory && !(isWeb && key === SETTINGS);

/** From now on writes stay in memory, over what is on disk, until the page reloads. Screenshot
 *  mode turns this on so seeding and pointing at a preview API never change the real data. */
export function keepInMemory(): void {
    memory ??= new Map();
}

export const storage = {
    read: async (key: string): Promise<string | null> =>
        memory?.has(key) && inMemory(key)
            ? (memory.get(key) ?? null)
            : isWeb && key !== SETTINGS
              ? null
              : disk.read(key),
    write: async (key: string, value: string): Promise<void> => {
        if (inMemory(key)) memory?.set(key, value);
        else await disk.write(key, value);
    },
    del: async (key: string): Promise<void> => {
        if (inMemory(key)) memory?.set(key, null);
        else await disk.del(key);
    },
    list: async (prefix: string): Promise<string[]> => {
        const names = new Set(isWeb ? [] : await disk.list(prefix));
        const dir = prefix.endsWith('/') ? prefix : prefix + '/';
        for (const [key, value] of memory ?? []) {
            if (!key.startsWith(dir)) continue;
            const name = key.slice(dir.length);
            if (value === null) names.delete(name);
            else names.add(name);
        }
        return [...names].sort();
    },
    dir: disk.dir,
};

/** A JSON file, or `fallback` when it is missing or does not parse. */
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
