import { useState, type ChangeEvent, type FocusEvent } from 'react';
import { useData } from '../store/data';
import type { Settings } from '../lib/types';

export default function SettingsPage() {
    const settings = useData((s) => s.settings);
    const env = useData((s) => s.env);
    const dataDir = useData((s) => s.dataDir);
    const mode = useData((s) => s.mode);
    const api = useData((s) => s.api);
    const saveSettings = useData((s) => s.saveSettings);
    const [draft, setDraft] = useState<Settings>(settings);

    const commit = (patch: Partial<Settings>) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        void saveSettings(patch);
    };
    const field = (key: keyof Settings) => ({
        value: String(draft[key]),
        onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setDraft({ ...draft, [key]: e.target.value }),
        onBlur: (e: FocusEvent<HTMLInputElement>) => {
            if (e.target.value !== String(settings[key]))
                commit({ [key]: e.target.value } as Partial<Settings>);
        },
    });
    const remote = mode === 'api';
    const apiState =
        api.state === 'ok'
            ? 'connected'
            : api.state === 'error'
              ? 'unreachable'
              : api.state === 'connecting'
                ? 'connecting'
                : 'off';

    return (
        <div className="page">
            <div className="form" style={{ margin: '0 auto' }}>
                <h1 className="serif">Settings</h1>
                <div className="field">
                    <label htmlFor="s-name">Your name</label>
                    <input id="s-name" {...field('name')} placeholder="Shown in the greeting" />
                </div>

                <div className="field">
                    <label htmlFor="s-api">API</label>
                    <input
                        id="s-api"
                        {...field('apiUrl')}
                        placeholder={env.apiUrl ?? 'http://localhost:3000'}
                        spellCheck={false}
                    />
                    <input
                        id="s-token"
                        type="password"
                        {...field('apiToken')}
                        placeholder={env.apiToken ? 'token from the environment' : 'API token'}
                        autoComplete="off"
                    />
                    <span className="note">
                        With a URL and token, conversations, documents and automations live in the
                        Lyfestyle API and its runner executes the agent. Leave both empty to keep
                        everything in local files and run Claude Code from this app.
                    </span>
                </div>

                <div className="field">
                    <label htmlFor="s-cmd">Agent command</label>
                    <input
                        id="s-cmd"
                        {...field('agentCommand')}
                        placeholder="claude"
                        disabled={remote || !!env.harness}
                    />
                    <span className="note">
                        {remote ? (
                            'Not used while the API is configured: the runner decides how the agent runs.'
                        ) : env.harness ? (
                            <>
                                Overridden by LYFESTYLE_AGENT_COMMAND in the environment:{' '}
                                <b className="select-text">{env.harness}</b>
                            </>
                        ) : (
                            'Your local Claude Code. Change only if the CLI is not on PATH.'
                        )}
                    </span>
                </div>
                <div className="field">
                    <label htmlFor="s-model">Model</label>
                    <input
                        id="s-model"
                        {...field('model')}
                        placeholder="Claude Code default"
                        disabled={remote || !!env.harness}
                    />
                </div>
                <div className="field">
                    <label htmlFor="s-cwd">Working directory</label>
                    <input
                        id="s-cwd"
                        {...field('workingDirectory')}
                        placeholder={dataDir}
                        disabled={remote}
                    />
                    <span className="note">
                        Where the local agent runs. Defaults to the data folder, so it can read your
                        documents.
                    </span>
                </div>
                <label className="switch">
                    <input
                        type="checkbox"
                        checked={draft.globalShortcut}
                        onChange={(e) => commit({ globalShortcut: e.target.checked })}
                    />
                    <i />
                    Ctrl K opens Lyfestyle from anywhere
                </label>

                <div className="status">
                    {remote ? (
                        <>
                            <span>
                                <i className={'dot' + (api.state === 'ok' ? '' : ' off')} />
                                API: <b>{apiState}</b> at <b className="select-text">{api.url}</b>
                            </span>
                            {api.error && (
                                <span className="select-text" style={{ color: 'var(--danger)' }}>
                                    {api.error}
                                </span>
                            )}
                            <span>
                                Chat turns run on the API's runner. Keep <b>pnpm api:dev</b> and{' '}
                                <b>pnpm runner</b> running, or point the URL at a deployed API.
                            </span>
                        </>
                    ) : (
                        <>
                            <span>
                                <i className={'dot' + (env.harness ? '' : ' off')} />
                                Harness: <b>{env.harness ? 'environment' : 'local Claude Code'}</b>
                            </span>
                            <span>
                                Data folder: <b className="select-text">{dataDir}</b>
                            </span>
                            <span>
                                Documents are plain markdown files in that folder; conversations are
                                JSON.
                            </span>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
