import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useApp } from '../store/app';
import { useData } from '../store/data';
import { useAttempt } from '../hooks/useAttempt';
import { describeError } from '../lib/api';
import {
    LIST,
    filterDocs,
    readEntry,
    writeEntry,
    type MobileEntry,
    type MobileRoute,
} from '../lib/mobile';
import { isWeb } from '../lib/tauri';
import { agoLabel, relativeTime } from '../lib/time';
import { TRASH_DAYS, type DocMeta } from '../lib/types';
import Confirm, { confirmAction } from '../components/Confirm';
import ErrorBoundary from '../components/ErrorBoundary';
import Markdown from '../components/Markdown';
import { Wordmark } from '../components/Wordmark';
import { Editor, daysLeft } from './Documents';

/**
 * The phone layout: documents only, one screen at a time (list, reader or editor, trash). Every
 * screen is a history entry, so the system back gesture steps back through them, and a reload
 * lands on the same screen. Documents open in the reader, which is plain markdown and needs no
 * editor; `edit` swaps in the same BlockNote editor as the desktop.
 */
const useRoute = create<{ entry: MobileEntry; query: string }>(() => ({
    entry: readEntry(window.history.state),
    query: '',
}));

function go(route: MobileRoute) {
    const next = { route, depth: useRoute.getState().entry.depth + 1 };
    window.history.pushState(writeEntry(next), '');
    useRoute.setState({ entry: next });
}

/** Changes the current screen without a new history entry (reader to editor and back). */
function replace(route: MobileRoute) {
    const next = { route, depth: useRoute.getState().entry.depth };
    window.history.replaceState(writeEntry(next), '');
    useRoute.setState({ entry: next });
}

/** Back to the previous screen, or to the list when this entry is the first one the app made. */
function back() {
    if (useRoute.getState().entry.depth > 0) window.history.back();
    else replace(LIST);
}

const open = (id: string, edit = false) => go({ name: 'doc', id, edit });

function Notice() {
    const notice = useData((s) => s.notice);
    const notify = useData((s) => s.notify);
    if (!notice) return null;
    return (
        <div className="notice m-notice err select-text" role="alert">
            <span>{notice}</span>
            <button className="x" aria-label="Dismiss" onClick={() => notify(null)}>
                ×
            </button>
        </div>
    );
}

function Back({ label = 'docs' }: { label?: string }) {
    return (
        <button className="m-back" onClick={back}>
            ‹ {label}
        </button>
    );
}

function ListScreen() {
    const docs = useData((s) => s.docs);
    const createDoc = useData((s) => s.createDoc);
    const hasTrash = useData((s) => s.mode === 'api');
    const unsynced = useData((s) => s.unsynced);
    const docsError = useData((s) => s.docsError);
    const reloadFiles = useData((s) => s.reloadFiles);
    const signOut = useData((s) => s.signOut);
    const query = useRoute((s) => s.query);
    const [problem, attempt] = useAttempt();
    const shown = filterDocs(docs, query);

    const add = () =>
        void attempt(async () => {
            open((await createDoc()).id, true);
        });

    return (
        <>
            <header className="m-bar">
                <span className="m-brand">
                    <Wordmark />
                </span>
                <span className="m-fill" />
                {unsynced > 0 && (
                    <span className="m-unsynced" title="Saved here, not yet on the server">
                        {unsynced} unsynced
                    </span>
                )}
                <button className="m-act" aria-label="New document" onClick={add}>
                    + new
                </button>
            </header>
            <div className="m-scroll">
                <label className="m-search">
                    <span aria-hidden="true">&gt;</span>
                    <input
                        type="search"
                        value={query}
                        placeholder="filter"
                        aria-label="Filter documents"
                        spellCheck={false}
                        autoCapitalize="off"
                        enterKeyHint="search"
                        onChange={(e) => useRoute.setState({ query: e.target.value })}
                    />
                </label>
                {problem && <p className="col-err select-text">{problem}</p>}
                {docsError && (
                    <p className="col-err select-text">
                        {docsError}{' '}
                        <button className="link" onClick={() => void reloadFiles()}>
                            retry
                        </button>
                    </p>
                )}
                {shown.length > 0 ? (
                    <ul className="m-rows">
                        {shown.map((d) => (
                            <li key={d.id}>
                                <button className="m-row" onClick={() => open(d.id)}>
                                    <span className="t">{d.title || 'Untitled'}</span>
                                    <span className="m">{relativeTime(d.updatedAt)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : docs.length > 0 ? (
                    <p className="empty m-empty">No titles match.</p>
                ) : (
                    <div className="empty-stage m-empty">
                        <p className="empty">Nothing written yet.</p>
                        <button className="btn" onClick={add}>
                            create a document
                        </button>
                    </div>
                )}
                {(hasTrash || isWeb) && (
                    <footer className="m-foot">
                        {hasTrash && (
                            <button className="plus" onClick={() => go({ name: 'trash' })}>
                                trash
                            </button>
                        )}
                        {isWeb && (
                            <button className="plus" onClick={() => void signOut()}>
                                sign out
                            </button>
                        )}
                    </footer>
                )}
            </div>
        </>
    );
}

/** A document as rendered markdown: quick to open, and nothing to tap by mistake. */
function Reader({ doc, onEdit }: { doc: DocMeta; onEdit: () => void }) {
    const readDoc = useData((s) => s.readDoc);
    const deleteDoc = useData((s) => s.deleteDoc);
    const notify = useData((s) => s.notify);
    const hasTrash = useData((s) => s.mode === 'api');
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Bumped by the retry after a failed read, which reads again. */
    const [reads, setReads] = useState(0);
    const title = doc.title || 'Untitled';

    useEffect(() => {
        let alive = true;
        readDoc(doc.id).then(
            (md) => {
                if (alive) setText(md);
            },
            (e: unknown) => {
                if (alive) setError(describeError(e));
            },
        );
        return () => {
            alive = false;
        };
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reads` changing is the retry
    }, [doc.id, readDoc, reads]);

    const remove = async () => {
        const ok = await confirmAction(
            hasTrash
                ? `Move "${title}" to the trash? It is deleted for good after ${TRASH_DAYS} days.`
                : `Delete "${title}"? This cannot be undone.`,
        );
        if (!ok) return;
        // Leave first, so the screen never shows the document vanishing under it.
        back();
        deleteDoc(doc.id).catch((e: unknown) => notify(describeError(e)));
    };

    return (
        <article className="m-read">
            <p className="eyebrow doc-meta">Edited {agoLabel(doc.updatedAt)}</p>
            <h1 className="m-title select-text">
                <span className="hash" aria-hidden="true">
                    #{' '}
                </span>
                {title}
            </h1>
            {error && (
                <div className="err select-text doc-err">
                    Could not open this document: {error}{' '}
                    <button
                        className="link"
                        onClick={() => {
                            setError(null);
                            setReads((n) => n + 1);
                        }}
                    >
                        retry
                    </button>
                </div>
            )}
            {text !== null &&
                (text.trim() ? (
                    <Markdown text={text} />
                ) : (
                    <div className="empty-stage">
                        <p className="empty">Nothing here yet.</p>
                        <button className="btn" onClick={onEdit}>
                            write
                        </button>
                    </div>
                ))}
            <footer className="m-foot">
                <button className="plus m-delete" onClick={() => void remove()}>
                    {hasTrash ? 'move to trash' : 'delete'}
                </button>
            </footer>
        </article>
    );
}

function DocScreen({ doc, edit }: { doc: DocMeta; edit: boolean }) {
    const revision = useData((s) => s.docRevisions[doc.id] ?? 0);
    const toggle = () => replace({ name: 'doc', id: doc.id, edit: !edit });
    const key = doc.id + ':' + revision;
    return (
        <>
            <header className="m-bar">
                <Back />
                <span className="m-fill" />
                <button className="btn" onClick={toggle}>
                    {edit ? 'done' : 'edit'}
                </button>
            </header>
            <div className={'m-scroll' + (edit ? ' m-edit' : '')}>
                {edit ? (
                    <Editor key={key} id={doc.id} touch />
                ) : (
                    <Reader key={key} doc={doc} onEdit={toggle} />
                )}
            </div>
        </>
    );
}

function TrashScreen() {
    const trash = useData((s) => s.trash);
    const loadTrash = useData((s) => s.loadTrash);
    const restoreDoc = useData((s) => s.restoreDoc);
    const [problem, attempt] = useAttempt();

    useEffect(() => {
        void attempt(loadTrash);
    }, [attempt, loadTrash]);

    const restore = (id: string) =>
        void attempt(async () => {
            const d = await restoreDoc(id);
            // The restored document takes the trash's place, so back returns to the list.
            replace({ name: 'doc', id: d.id, edit: false });
        });

    return (
        <>
            <header className="m-bar">
                <Back />
                <span className="m-fill" />
                <span className="m-crumb">trash</span>
            </header>
            <div className="m-scroll">
                {problem && <p className="col-err select-text">{problem}</p>}
                {trash.length > 0 ? (
                    <ul className="m-rows">
                        {trash.map((d) => {
                            const left = daysLeft(d.deletedAt);
                            return (
                                <li key={d.id} className="m-row m-trashed">
                                    <span className="t">{d.title || 'Untitled'}</span>
                                    <span className="m">{left ? `${left}d left` : 'today'}</span>
                                    {d.excerpt.trim() && <span className="ex">{d.excerpt}</span>}
                                    <button className="btn" onClick={() => restore(d.id)}>
                                        restore
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                ) : (
                    <p className="empty m-empty">
                        The trash is empty. Deleted documents stay here for {TRASH_DAYS} days.
                    </p>
                )}
            </div>
        </>
    );
}

function Missing() {
    return (
        <>
            <header className="m-bar">
                <Back />
            </header>
            <div className="m-scroll">
                <p className="empty m-empty">
                    This document is not here. It may have been deleted.
                </p>
            </div>
        </>
    );
}

export default function Mobile() {
    const route = useRoute((s) => s.entry.route);
    const docs = useData((s) => s.docs);
    const mode = useData((s) => s.mode);

    useEffect(() => {
        const onPop = (e: PopStateEvent) => useRoute.setState({ entry: readEntry(e.state) });
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    // `page:` links in a document call `navigate`; here that opens the linked document.
    useEffect(
        () =>
            useApp.subscribe((s, prev) => {
                if (s.view !== prev.view && s.view.name === 'documents' && s.view.id)
                    open(s.view.id);
            }),
        [],
    );

    // A phone may freeze or kill a hidden app at any moment, and the web build keeps documents in
    // memory: push edits as it is hidden, and catch up as it comes back.
    useEffect(() => {
        if (mode !== 'api') return;
        const onVisibility = () => void useData.getState().refresh();
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [mode]);

    let screen;
    if (route.name === 'trash' && mode === 'api') screen = <TrashScreen />;
    else if (route.name === 'doc') {
        const doc = docs.find((d) => d.id === route.id);
        screen = doc ? <DocScreen key={doc.id} doc={doc} edit={route.edit} /> : <Missing />;
    } else screen = <ListScreen />;

    const key = route.name === 'doc' ? 'doc:' + route.id : route.name;
    return (
        <div className="m-app">
            <Notice />
            <main className="m-screen enter" key={key}>
                <ErrorBoundary>{screen}</ErrorBoundary>
            </main>
            <Confirm />
        </div>
    );
}

/** The phone layout before the web build is signed in. */
export function MobileSignIn({ children }: { children: ReactNode }) {
    return (
        <div className="m-app">
            <header className="m-bar">
                <span className="m-brand">
                    <Wordmark />
                </span>
            </header>
            <div className="m-scroll m-signin">{children}</div>
        </div>
    );
}
