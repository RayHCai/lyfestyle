import { useApp } from '../store/app';
import { recentConversations, useData } from '../store/data';
import { relativeTime } from '../lib/util';

export default function Conversations() {
    const conversations = useData((s) => s.conversations);
    const deleteConversation = useData((s) => s.deleteConversation);
    const navigate = useApp((s) => s.navigate);
    const list = recentConversations(conversations, Infinity);

    return (
        <div className="page">
            <div className="page-narrow">
                <div className="head-row">
                    <h1 className="serif">Conversations</h1>
                </div>
                {list.length === 0 && (
                    <div className="empty">
                        Nothing yet. Ask something from the front page or press Ctrl K.
                    </div>
                )}
                <div className="rows">
                    {list.map((c) => (
                        <div className="row" key={c.id}>
                            <button
                                className="open"
                                onClick={() => navigate({ name: 'conversation', id: c.id })}
                            >
                                <span className="t">{c.title}</span>
                                <span className="m">
                                    {c.source === 'automation' ? 'automation · ' : ''}
                                    {relativeTime(c.updatedAt)}
                                </span>
                            </button>
                            <button
                                className="x"
                                aria-label="Delete"
                                onClick={() => void deleteConversation(c.id)}
                            >
                                <svg
                                    width="12"
                                    height="12"
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
                </div>
            </div>
        </div>
    );
}
