import { useEffect, useState, type ChangeEvent, type FocusEvent } from 'react';
import Markdown from '../components/Markdown';
import Masthead from '../components/Masthead';
import { describeError } from '../lib/api';
import { HARNESSES, activeHarness, harnessProblem } from '../lib/harness';
import { useRunnerStatus } from '../lib/runner';
import { call, isTauri, isWeb } from '../lib/tauri';
import { useData } from '../store/data';
import type { Settings } from '../lib/types';

/** SOUL.md, the guiding doc every agent run follows. A file at ~/.lyfestyle/SOUL.md, read by both
 *  the app's local Claude Code and the runner, so it is edited through Rust in either mode. */
function Soul() {
    const [text, setText] = useState<string | null>(null);
    const [saved, setSaved] = useState('');
    const [preview, setPreview] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!isTauri) return;
        void call<string>('soul_read')
            .then((t) => {
                setText(t);
                setSaved(t);
            })
            .catch((e: unknown) => setError(String(e)));
    }, []);

    // Marked saved only once the write succeeds, so a failed one is tried again on the next blur.
    const save = () => {
        if (text === null || text === saved) return;
        void call('soul_write', { text }).then(
            () => {
                setSaved(text);
                setError('');
            },
            (e: unknown) => setError(String(e)),
        );
    };

    return (
        <div className="field soul">
            <label htmlFor="s-soul">SOUL.md</label>
            {preview ? (
                <div className="soul-preview" onDoubleClick={() => setPreview(false)}>
                    <Markdown text={text ?? ''} />
                </div>
            ) : (
                <textarea
                    id="s-soul"
                    value={text ?? ''}
                    disabled={text === null}
                    placeholder={isTauri ? 'Loading…' : 'Only editable in the desktop app'}
                    spellCheck={false}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={save}
                />
            )}
            <span className="note">
                {error ? (
                    <span className="select-text danger-text">{error}</span>
                ) : (
                    <>
                        Markdown every agent run follows: who you are and how you want it to work.
                        Saved to <b className="select-text">~/.lyfestyle/SOUL.md</b> when you leave
                        the field.{' '}
                    </>
                )}
                <button
                    className="link"
                    disabled={text === null}
                    onClick={() => {
                        save();
                        setPreview(!preview);
                    }}
                >
                    {preview ? 'edit' : 'preview'}
                </button>
            </span>
        </div>
    );
}

export default function SettingsPage() {
    const settings = useData((s) => s.settings);
    const env = useData((s) => s.env);
    const dataDir = useData((s) => s.dataDir);
    const mode = useData((s) => s.mode);
    const api = useData((s) => s.api);
    const saveSettings = useData((s) => s.saveSettings);
    const [draft, setDraft] = useState<Settings>(settings);
    const [saveError, setSaveError] = useState('');
    const runner = useRunnerStatus();
    const harness = activeHarness(draft);

    const commit = (patch: Partial<Settings>) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        saveSettings(patch).then(
            () => setSaveError(''),
            (e: unknown) => setSaveError(`Not saved: ${describeError(e)}`),
        );
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
            <div className="form">
                <Masthead eyebrow="Preferences" title="Settings" />
                <div className="field">
                    <label htmlFor="s-name">Your name</label>
                    <input id="s-name" {...field('name')} placeholder="Shown in the greeting" />
                </div>

                {isWeb ? (
                    <>
                        {/* The web build has no local files, so it works only through the API. */}
                        <div className="field">
                            <label htmlFor="s-api">API URL</label>
                            <input
                                id="s-api"
                                {...field('apiUrl')}
                                placeholder="https://api.example.com"
                                inputMode="url"
                                autoCapitalize="off"
                                spellCheck={false}
                            />
                        </div>
                        <div className="field">
                            <label htmlFor="s-token">API token</label>
                            <input
                                id="s-token"
                                type="password"
                                {...field('apiToken')}
                                autoComplete="off"
                            />
                            <span className="note">
                                Kept in this browser. Documents are not: they load from the API on
                                every visit.
                            </span>
                        </div>
                    </>
                ) : (
                    <>
                        <Soul />
                        {HARNESSES.map((h) => {
                            const found = env.harnesses.find((d) => d.id === h.id)?.path;
                            const problem = harnessProblem(h.id, draft, env);
                            return (
                                <div className="field" key={h.id}>
                                    <label htmlFor={`s-h-${h.id}`}>{h.label}</label>
                                    <input
                                        id={`s-h-${h.id}`}
                                        {...field(h.setting)}
                                        placeholder={
                                            h.id === 'command'
                                                ? 'a stream-json command'
                                                : (found ?? 'not found on PATH')
                                        }
                                        disabled={!!env.harness}
                                        spellCheck={false}
                                    />
                                    <span className="note">
                                        {h.id === 'command'
                                            ? 'Prompt on stdin, --session <id> to resume, stream-json or text out.'
                                            : found
                                              ? 'Found on PATH. Set a command only to use another install.'
                                              : 'Not found on PATH. Install it, or give its full path.'}{' '}
                                        {harness === h.id ? (
                                            <b>in use</b>
                                        ) : (
                                            <button
                                                className="link"
                                                disabled={!!env.harness || !!problem}
                                                onClick={() => commit({ harness: h.id })}
                                            >
                                                use
                                            </button>
                                        )}
                                    </span>
                                </div>
                            );
                        })}
                        {env.harness && (
                            <div className="field">
                                <span />
                                <span className="note">
                                    Overridden by LYFESTYLE_AGENT_COMMAND in the environment:{' '}
                                    <b className="select-text">{env.harness}</b>
                                </span>
                            </div>
                        )}
                    </>
                )}
                <div className="status">
                    {saveError && <span className="select-text danger-text">{saveError}</span>}
                    {isWeb && !remote ? (
                        <span>
                            <i className="dot off" />
                            API: <b>not connected</b>
                        </span>
                    ) : remote ? (
                        <>
                            <span>
                                <i className={'dot' + (api.state === 'ok' ? '' : ' off')} />
                                API: <b>{apiState}</b> at <b className="select-text">{api.url}</b>
                            </span>
                            {api.error && (
                                <span className="select-text danger-text">{api.error}</span>
                            )}
                            {!isWeb && (
                                <span>
                                    <i
                                        className={
                                            'dot' +
                                            (runner.state === 'off' || runner.error ? ' off' : '')
                                        }
                                    />
                                    Runner:{' '}
                                    <b>
                                        {env.harness
                                            ? 'off (LYFESTYLE_AGENT_COMMAND)'
                                            : runner.state === 'running'
                                              ? `running ${runner.runs}`
                                              : runner.state}
                                    </b>{' '}
                                    on <b>{harness}</b>
                                    {runner.error && (
                                        <span className="select-text danger-text">
                                            {' '}
                                            {runner.error}
                                        </span>
                                    )}
                                </span>
                            )}
                        </>
                    ) : (
                        <>
                            <span>
                                <i className={'dot' + (env.harness ? '' : ' off')} />
                                Harness: <b>{env.harness ? 'environment' : harness}</b>
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
