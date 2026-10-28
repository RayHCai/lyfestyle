import { useShallow } from 'zustand/shallow';
import Masthead from '../components/Masthead';
import { useApp } from '../store/app';
import { recentIds, useData } from '../store/data';
import { removeConversation } from '../lib/actions';
import { relativeTime } from '../lib/time';

const all = recentIds(Infinity);

function Row({ id }: { id: string }) {
    const title = useData((s) => s.conversations[id]?.title ?? '');
    // The label, not the timestamp, so a streaming reply re-renders the row once a minute at most.
    const ago = useData((s) => relativeTime(s.conversations[id]?.updatedAt ?? 0));
    const navigate = useApp((s) => s.navigate);
    return (
        <div className="row">
            <button className="open" onClick={() => navigate({ name: 'conversation', id })}>
                <span className="t">{title}</span>
                <span className="m">{ago}</span>
            </button>
            <button
                className="x"
                aria-label={`Delete "${title}"`}
                onClick={() => void removeConversation(id)}
            >
                ×
            </button>
        </div>
    );
}

export default function Conversations() {
    const ids = useData(useShallow(all));
    const count = ids.length === 1 ? 'one thread' : `${ids.length} threads`;

    return (
        <div className="page">
            <div className="page-narrow">
                <Masthead eyebrow={ids.length ? count : 'archive'} title="Conversations" />
                {ids.length === 0 && <p className="empty">Nothing yet.</p>}
                <div className="rows">
                    {ids.map((id) => (
                        <Row key={id} id={id} />
                    ))}
                </div>
            </div>
        </div>
    );
}
