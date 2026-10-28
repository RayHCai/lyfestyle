import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useData } from '../src/store/data';
import type { DocMeta } from '../src/lib/types';

// Local mode outside Tauri: storage falls back to localStorage, and a Map stands in for the disk.
const disk = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => void disk.set(k, v),
    removeItem: (k: string) => void disk.delete(k),
    key: (i: number) => [...disk.keys()][i] ?? null,
    get length() {
        return disk.size;
    },
});

const INDEX = 'lyf:documents/index.json';
const body = (id: string) => disk.get(`lyf:documents/${id}.md`);
const index = (): DocMeta[] => JSON.parse(disk.get(INDEX) ?? '[]') as DocMeta[];
/** What the agent's tool server does mid-turn: rewrite the index behind the app's back. */
const agentWrites = (change: (list: DocMeta[]) => DocMeta[]) =>
    disk.set(INDEX, JSON.stringify(change(index())));

beforeEach(() => {
    disk.clear();
    useData.setState({ docs: [], docRevisions: {}, docsError: null, notice: null });
});

describe('local documents', () => {
    it('keeps documents the agent added when the app writes the index', async () => {
        const { createDoc, renameDoc } = useData.getState();
        const a = await createDoc('Mine');
        agentWrites((list) => [
            { id: 'b', title: 'From the agent', createdAt: 1, updatedAt: Date.now() },
            ...list,
        ]);
        await renameDoc(a.id, 'Mine, renamed');
        expect(
            index()
                .map((d) => d.title)
                .sort(),
        ).toEqual(['From the agent', 'Mine, renamed']);
        expect(useData.getState().docs).toHaveLength(2);
    });

    it('saves over an edit the agent made meanwhile as a conflicted copy', async () => {
        const { createDoc, writeDoc } = useData.getState();
        const a = await createDoc('Notes');
        await writeDoc(a.id, 'mine, first');
        agentWrites((list) =>
            list.map((d) => (d.id === a.id ? { ...d, updatedAt: d.updatedAt + 1000 } : d)),
        );
        disk.set(`lyf:documents/${a.id}.md`, 'the agent wrote this');

        await useData.getState().writeDoc(a.id, 'mine, second');
        expect(body(a.id)).toBe('the agent wrote this');
        const copy = index().find((d) => d.title === 'Notes (conflicted copy)');
        expect(copy && body(copy.id)).toBe('mine, second');
        expect(useData.getState().docRevisions[a.id]).toBe(1);
        expect(useData.getState().notice).toMatch(/conflicted copy/);
    });

    it('drops a pending save for a document deleted here', async () => {
        const { createDoc, deleteDoc, writeDoc } = useData.getState();
        const a = await createDoc('Gone');
        await deleteDoc(a.id);
        await writeDoc(a.id, 'typed just before the delete');
        expect(index()).toEqual([]);
        expect(body(a.id)).toBeUndefined();
    });

    it('refuses to write over an index that does not parse', async () => {
        disk.set(INDEX, '[{"id": "a",');
        await expect(useData.getState().createDoc('New')).rejects.toThrow(/not valid JSON/);
        expect(disk.get(INDEX)).toBe('[{"id": "a",');
    });

    it('reports an unreadable index on reload and keeps the list it had', async () => {
        const a = await useData.getState().createDoc('Kept');
        disk.set(INDEX, 'garbage');
        await useData.getState().reloadFiles();
        expect(useData.getState().docsError).toMatch(/not valid JSON/);
        expect(useData.getState().docs.map((d) => d.id)).toEqual([a.id]);
    });

    it('bumps the revision of a document the agent changed, so the editor reloads it', async () => {
        const a = await useData.getState().createDoc('Plan');
        agentWrites((list) =>
            list.map((d) => (d.id === a.id ? { ...d, updatedAt: d.updatedAt + 1000 } : d)),
        );
        await useData.getState().reloadFiles();
        expect(useData.getState().docRevisions[a.id]).toBe(1);
    });
});
