import { useState, type FormEvent } from 'react';
import Masthead from '../components/Masthead';
import { useAttempt } from '../hooks/useAttempt';
import { WEB_API_URL } from '../lib/web';
import { useData } from '../store/data';

/** The web build before it has a dashboard token: the password, and nothing else. */
export default function SignIn() {
    const signIn = useData((s) => s.signIn);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, attempt] = useAttempt();

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        // Success replaces this page with the app, so this only matters after a failure.
        await attempt(() => signIn(password));
        setBusy(false);
    };

    return (
        <div className="page">
            <form className="form" onSubmit={(e) => void submit(e)}>
                <Masthead eyebrow="Lyfestyle" title="Sign in" />
                <div className="field">
                    <label htmlFor="signin-password">Password</label>
                    <input
                        id="signin-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        autoFocus
                        disabled={!WEB_API_URL}
                    />
                    {!WEB_API_URL ? (
                        <span className="note danger-text">
                            This build has no API: set VITE_API_URL and build it again.
                        </span>
                    ) : (
                        problem && <span className="note select-text danger-text">{problem}</span>
                    )}
                </div>
                <div className="field">
                    <span />
                    <div className="actions">
                        <button
                            className="btn"
                            type="submit"
                            disabled={busy || !password || !WEB_API_URL}
                        >
                            {busy ? 'signing in' : 'sign in'}
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
}
