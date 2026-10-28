import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
    BlockNoteEditor,
    BlockSchema,
    InlineContentSchema,
    StyleSchema,
} from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { DAY_MS } from '@lyfestyle/shared';
import { useApp } from '../store/app';
import { useData } from '../store/data';
import { trackPendingSave } from '../store/docs';
import { useAttempt } from '../hooks/useAttempt';
import { describeError } from '../lib/api';
import { agoLabel, relativeTime } from '../lib/time';
import { debounce } from '../lib/util';
import { TRASH_DAYS, type TrashedDoc } from '../lib/types';
import { confirmAction } from '../components/Confirm';

/** Whole days until the API purges a trashed document; 0 in its last day. */
const daysLeft = (deletedAt: number, now = Date.now()) =>
    Math.max(0, Math.floor((deletedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS));

function TrashPane({ doc, onRestore }: { doc: TrashedDoc; onRestore: () => void }) {
    const left = daysLeft(doc.deletedAt);
    return (
        <div className="docs-editor">
            <p className="eyebrow doc-meta">
                Deleted {agoLabel(doc.deletedAt)} · gone for good {left ? `in ${left}d` : 'today'}
            </p>
            <div className="doc-title-row">
                <span className="hash" aria-hidden="true">
                    #
                </span>
                <h2 className="doc-title trashed">{doc.title || 'Untitled'}</h2>
            </div>
            {doc.excerpt.trim() && <p className="trash-excerpt">{doc.excerpt}</p>}
            <button className="btn" onClick={onRestore}>
                restore
            </button>
        </div>
    );
}

/**
 * One document. Edits save after a pause; a save that fails keeps the text in the editor and
 * offers a retry, and nothing is marked edited until a save succeeds. A pending save runs early
 * when the store reloads or syncs, and when the editor closes.
 */
function Editor({ id }: { id: string }) {
    const meta = useData((s) => s.docs.find((d) => d.id === id));
    const readDoc = useData((s) => s.readDoc);
    const writeDoc = useData((s) => s.writeDoc);
    const renameDoc = useData((s) => s.renameDoc);
    const editor = useCreateBlockNote();
    const [title, setTitle] = useState(meta?.title ?? '');
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Bumped by the retry after a failed read, which reads again. */
    const [reads, setReads] = useState(0);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        readDoc(id).then(
            async (md) => {
                if (!alive) return;
                if (md.trim()) {
                    const blocks = await editor.tryParseMarkdownToBlocks(md);
                    if (alive && blocks.length) editor.replaceBlocks(editor.document, blocks);
                }
                if (alive) setLoaded(true);
            },
            (e: unknown) => {
                if (alive) setLoadError(describeError(e));
            },
        );
        return () => {
            alive = false;
        };
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reads` changing is the retry
    }, [id, editor, readDoc, reads]);

    /** Runs a save, keeping its failure on screen until one succeeds. */
    const store = useCallback(async (fn: () => Promise<void>) => {
        try {
            await fn();
            setSaveError(null);
        } catch (e) {
            setSaveError(describeError(e));
        }
    }, []);
    const saveBody = useCallback(
        () => store(() => writeDoc(id, editor.blocksToMarkdownLossy(editor.document))),
        [store, writeDoc, id, editor],
    );
    const saveTitle = useCallback(
        (t: string) => store(() => renameDoc(id, t.trim() || 'Untitled')),
        [store, renameDoc, id],
    );
    const save = useMemo(() => debounce(() => void saveBody(), 600), [saveBody]);
    const rename = useMemo(() => debounce((t: string) => void saveTitle(t), 400), [saveTitle]);
    useEffect(() => {
        const untrack = [trackPendingSave(save.flush), trackPendingSave(rename.flush)];
        return () => {
            for (const u of untrack) u();
            // Closing the editor (another document, another tab) saves what was typed.
            save.flush();
            rename.flush();
        };
    }, [save, rename]);

    const status = saveError ? 'Not saved' : meta && `Edited ${agoLabel(meta.updatedAt)}`;
    return (
        <div className="docs-editor">
            {status && (
                <p className={'eyebrow doc-meta' + (saveError ? ' danger-text' : '')}>{status}</p>
            )}
            <div className="doc-title-row">
                <span className="hash" aria-hidden="true">
                    #
                </span>
                <input
                    id={'title-' + id}
                    className="doc-title"
                    value={title}
                    placeholder="Untitled"
                    aria-label="Title"
                    spellCheck={false}
                    onChange={(e) => {
                        setTitle(e.target.value);
                        rename(e.target.value);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            editor.focus();
                        }
                    }}
                />
            </div>
            {loadError && (
                <div className="err select-text doc-err">
                    Could not open this document: {loadError}{' '}
                    <button
                        className="link"
                        onClick={() => {
                            setLoadError(null);
                            setReads((n) => n + 1);
                        }}
                    >
                        retry
                    </button>
                </div>
            )}
            {saveError && (
                <div className="err select-text doc-err" role="alert">
                    {saveError} Your text is still here.{' '}
                    <button className="link" onClick={() => void saveBody()}>
                        retry
                    </button>
                </div>
            )}
            <div className="doc-body">
                <BlockNoteView
                    // BlockNote's types are not written for exactOptionalPropertyTypes: its default
                    // schema fails its own generic constraint there, so widen to the constraint.
                    editor={
                        editor as unknown as BlockNoteEditor<
                            BlockSchema,
                            InlineContentSchema,
                            StyleSchema
                        >
                    }
                    theme="light"
                    // Until the text is in, typing would be lost when it arrives.
                    editable={loaded}
                    onChange={() => {
                        if (loaded) save();
                    }}
                />
            </div>
        </div>
    );
}

export default function Documents({ id }: { id?: string | undefined }) {
    const docs = useData((s) => s.docs);
    const createDoc = useData((s) => s.createDoc);
    const deleteDoc = useData((s) => s.deleteDoc);
    const trash = useData((s) => s.trash);
    const loadTrash = useData((s) => s.loadTrash);
    const restoreDoc = useData((s) => s.restoreDoc);
    const reloadFiles = useData((s) => s.reloadFiles);
    const hasTrash = useData((s) => s.mode === 'api');
    const unsynced = useData((s) => s.unsynced);
    const docsError = useData((s) => s.docsError);
    const docRevisions = useData((s) => s.docRevisions);
    const rememberSelection = useApp((s) => s.rememberSelection);
    const [problem, attempt] = useAttempt();
    const [sel, setSel] = useState<string | undefined>(
        id && docs.some((d) => d.id === id) ? id : docs[0]?.id,
    );
    const [inTrash, setInTrash] = useState(false);
    const [trashSel, setTrashSel] = useState<string | undefined>();
    const current = sel && docs.some((d) => d.id === sel) ? sel : docs[0]?.id;
    const trashed = trash.find((d) => d.id === trashSel) ?? trash[0];
    // Selecting in the list also updates this tab, so switching away and back lands on the same one.
    const pick = (next: string) => {
        setSel(next);
        rememberSelection({ name: 'documents', id: next });
    };

    const add = () =>
        void attempt(async () => {
            pick((await createDoc()).id);
        });

    const openTrash = () => {
        setInTrash(true);
        void attempt(loadTrash);
    };

    const restore = (doc: TrashedDoc) =>
        void attempt(async () => {
            const d = await restoreDoc(doc.id);
            setInTrash(false);
            pick(d.id);
        });

    const remove = async (id: string, title: string) => {
        const ok = await confirmAction(
            hasTrash
                ? `Move "${title}" to the trash? It is deleted for good after ${TRASH_DAYS} days.`
                : `Delete "${title}"? This cannot be undone.`,
        );
        if (ok) await attempt(() => deleteDoc(id));
    };

    const errors = (
        <>
            {problem && <p className="col-err select-text">{problem}</p>}
            {docsError && (
                <p className="col-err select-text">
                    {docsError}{' '}
                    <button className="link" onClick={() => void reloadFiles()}>
                        retry
                    </button>
                </p>
            )}
        </>
    );

    if (hasTrash && inTrash) {
        return (
            <div className="two">
                <aside className="col-list">
                    <div className="col-head">
                        <span>Trash</span>
                        <button className="plus" onClick={() => setInTrash(false)}>
                            back
                        </button>
                    </div>
                    {errors}
                    <div className="col-rows">
                        {trash.map((d) => (
                            <button
                                key={d.id}
                                className={'doc-row' + (d.id === trashed?.id ? ' active' : '')}
                                onClick={() => setTrashSel(d.id)}
                            >
                                <span className="t">{d.title || 'Untitled'}</span>
                                <span className="m">
                                    {daysLeft(d.deletedAt)
                                        ? `${daysLeft(d.deletedAt)}d left`
                                        : 'today'}
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>
                {trashed ? (
                    <TrashPane doc={trashed} onRestore={() => restore(trashed)} />
                ) : (
                    <div className="docs-editor">
                        <div className="empty-stage">
                            <p className="empty">
                                The trash is empty. Deleted documents stay here for {TRASH_DAYS}{' '}
                                days.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="two">
            <aside className="col-list">
                <div className="col-head">
                    <span>Documents</span>
                    <span className="col-actions">
                        {unsynced > 0 && (
                            <span className="unsynced" title="Saved here, not yet on the server">
                                {unsynced} unsynced
                            </span>
                        )}
                        {hasTrash && (
                            <button className="plus" onClick={openTrash}>
                                trash
                            </button>
                        )}
                        <button className="plus" aria-label="New document" onClick={add}>
                            + new
                        </button>
                    </span>
                </div>
                {errors}
                <div className="col-rows">
                    {docs.map((d) => (
                        <div
                            key={d.id}
                            className={'doc-row split' + (d.id === current ? ' active' : '')}
                        >
                            <button className="open" onClick={() => pick(d.id)}>
                                <span className="t">{d.title || 'Untitled'}</span>
                                <span className="m">{relativeTime(d.updatedAt)}</span>
                            </button>
                            <button
                                className="x"
                                aria-label={`Delete "${d.title || 'Untitled'}"`}
                                onClick={() => void remove(d.id, d.title || 'Untitled')}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            </aside>
            {current ? (
                <Editor key={current + ':' + (docRevisions[current] ?? 0)} id={current} />
            ) : (
                <div className="docs-editor">
                    <div className="empty-stage">
                        <p className="empty">Nothing written yet.</p>
                        <button className="btn" onClick={add}>
                            Create a document
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
