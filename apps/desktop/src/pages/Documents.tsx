import { useEffect, useMemo, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { useData } from '../store/data';
import { debounce, relativeTime } from '../lib/util';

function Editor({ id }: { id: string }) {
    const meta = useData((s) => s.docs.find((d) => d.id === id));
    const readDoc = useData((s) => s.readDoc);
    const writeDoc = useData((s) => s.writeDoc);
    const renameDoc = useData((s) => s.renameDoc);
    const editor = useCreateBlockNote();
    const [title, setTitle] = useState(meta?.title ?? '');
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;
        void readDoc(id).then(async (md) => {
            if (!alive) return;
            if (md.trim()) {
                const blocks = await editor.tryParseMarkdownToBlocks(md);
                if (alive && blocks.length) editor.replaceBlocks(editor.document, blocks);
            }
            setLoaded(true);
        });
        return () => {
            alive = false;
        };
    }, [id, editor, readDoc]);

    const save = useMemo(
        () =>
            debounce(() => {
                void writeDoc(id, editor.blocksToMarkdownLossy(editor.document));
            }, 600),
        [editor, id, writeDoc],
    );
    const rename = useMemo(
        () =>
            debounce((t: string) => {
                void renameDoc(id, t.trim() || 'Untitled');
            }, 400),
        [id, renameDoc],
    );

    return (
        <div className="docs-editor">
            <input
                id={'title-' + id}
                className="doc-title"
                value={title}
                placeholder="Untitled"
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
            <div className="doc-body">
                <BlockNoteView
                    editor={editor}
                    theme="light"
                    onChange={() => {
                        if (loaded) save();
                    }}
                />
            </div>
        </div>
    );
}

export default function Documents({ id }: { id?: string }) {
    const docs = useData((s) => s.docs);
    const createDoc = useData((s) => s.createDoc);
    const deleteDoc = useData((s) => s.deleteDoc);
    const [sel, setSel] = useState<string | undefined>(
        id && docs.some((d) => d.id === id) ? id : docs[0]?.id,
    );
    const current = sel && docs.some((d) => d.id === sel) ? sel : docs[0]?.id;

    const add = () => {
        void createDoc().then((d) => setSel(d.id));
    };

    return (
        <div className="docs">
            <aside className="col-list">
                <div className="col-head">
                    <span>Documents</span>
                    <button className="plus" aria-label="New document" onClick={add}>
                        <svg viewBox="0 0 24 24">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    </button>
                </div>
                {docs.map((d) => (
                    <div
                        key={d.id}
                        className={'doc-row split' + (d.id === current ? ' active' : '')}
                    >
                        <button className="open" onClick={() => setSel(d.id)}>
                            <span className="t">{d.title || 'Untitled'}</span>
                            <span className="m">{relativeTime(d.updatedAt)}</span>
                        </button>
                        <button
                            className="x"
                            aria-label="Delete"
                            onClick={() => void deleteDoc(d.id)}
                        >
                            <svg
                                width="11"
                                height="11"
                                viewBox="0 0 12 12"
                                stroke="currentColor"
                                strokeWidth="1.3"
                                fill="none"
                            >
                                <path d="M2 2l8 8M10 2l-8 8" />
                            </svg>
                        </button>
                    </div>
                ))}
            </aside>
            {current ? (
                <Editor key={current} id={current} />
            ) : (
                <div className="docs-editor">
                    <div className="empty">
                        <button className="link" onClick={add}>
                            Create your first document
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
