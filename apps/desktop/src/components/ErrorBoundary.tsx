import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
    error: Error | null;
}

/** Keeps a page that throws while rendering (say, a malformed file it shows) from blanking the
 *  whole window: the shell stays, the page says what broke and offers to try again. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: unknown): State {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    override componentDidCatch(error: unknown, info: ErrorInfo) {
        console.error('A page failed to render:', error, info.componentStack);
    }

    override render() {
        const { error } = this.state;
        if (!error) return this.props.children;
        return (
            <div className="page">
                <div className="page-narrow">
                    <p className="eyebrow">something broke</p>
                    <p className="err select-text">{error.message}</p>
                    <button className="btn" onClick={() => this.setState({ error: null })}>
                        try again
                    </button>
                </div>
            </div>
        );
    }
}
