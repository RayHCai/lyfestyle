import { beforeEach, describe, expect, it, vi } from 'vitest';

// Outside Tauri, storage falls back to localStorage; a Map stands in for it.
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

describe('storage in the web build', () => {
    beforeEach(() => {
        local.clear();
        vi.resetModules();
        vi.stubEnv('MODE', 'web');
    });

    it('keeps only settings.json in the browser', async () => {
        const { storage } = await import('../src/lib/storage');
        await storage.write('settings.json', '{}');
        await storage.write('sync/api/index.json', '[]');
        expect([...local.keys()]).toEqual(['lyf:settings.json']);
        expect(await storage.read('sync/api/index.json')).toBe('[]');
        expect(await storage.list('sync/api')).toEqual(['index.json']);
    });

    it('never reads cached pages left in the browser', async () => {
        local.set('lyf:sync/api/index.json', '[]');
        local.set('lyf:settings.json', '{"name":"x"}');
        const { storage } = await import('../src/lib/storage');
        expect(await storage.read('sync/api/index.json')).toBeNull();
        expect(await storage.list('sync/api')).toEqual([]);
        expect(await storage.read('settings.json')).toBe('{"name":"x"}');
    });
});
