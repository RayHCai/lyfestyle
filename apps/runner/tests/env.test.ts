import { describe, expect, it } from 'vitest';
import { loadRunnerEnv } from '../src/env.js';

describe('loadRunnerEnv', () => {
    it('treats an empty .env line as unset', () => {
        const env = loadRunnerEnv({
            API_TOKEN: 'secret-token',
            LYFESTYLE_API_TOKEN: '',
            AGENT_HARNESS: '',
            AGENT_HARNESS_COMMAND: '',
            AGENT_MODEL: '',
            AGENT_TOOLS: '',
            AGENT_CONNECTOR_TOOLS: '',
            AGENT_MAX_BUDGET_USD: '',
        });
        expect(env).toMatchObject({
            apiToken: 'secret-token',
            harness: 'claude-code',
            harnessCommand: undefined,
            model: undefined,
            tools: undefined,
            connectorTools: undefined,
            maxBudgetUsd: undefined,
        });
    });

    it('turns built-in tools off with "none"', () => {
        expect(loadRunnerEnv({ API_TOKEN: 't', AGENT_TOOLS: 'none' }).tools).toEqual([]);
        expect(loadRunnerEnv({ API_TOKEN: 't', AGENT_TOOLS: 'WebFetch, Read' }).tools).toEqual([
            'WebFetch',
            'Read',
        ]);
        expect(
            loadRunnerEnv({ API_TOKEN: 't', AGENT_CONNECTOR_TOOLS: 'none' }).connectorTools,
        ).toEqual([]);
    });

    it('picks the command harness when only a command is given', () => {
        expect(loadRunnerEnv({ API_TOKEN: 't', AGENT_HARNESS_COMMAND: 'my-agent' }).harness).toBe(
            'command',
        );
    });

    it('rejects counts that are not positive whole numbers instead of guessing', () => {
        expect(() => loadRunnerEnv({ API_TOKEN: 't', RUNNER_CONCURRENCY: '1.5' })).toThrow(
            'RUNNER_CONCURRENCY must be a positive whole number',
        );
        expect(() => loadRunnerEnv({ API_TOKEN: 't', AGENT_MAX_TURNS: 'lots' })).toThrow(
            'AGENT_MAX_TURNS',
        );
        expect(loadRunnerEnv({ API_TOKEN: 't', RUNNER_CONCURRENCY: '3' }).concurrency).toBe(3);
    });

    it('refuses a budget cap of 0 rather than reading it as no cap', () => {
        expect(() => loadRunnerEnv({ API_TOKEN: 't', AGENT_MAX_BUDGET_USD: '0' })).toThrow(
            'leave it empty for no cap',
        );
        expect(loadRunnerEnv({ API_TOKEN: 't', AGENT_MAX_BUDGET_USD: '0.5' }).maxBudgetUsd).toBe(
            0.5,
        );
    });

    it('limits a run to RUN_TIMEOUT_MINUTES, 30 by default', () => {
        expect(loadRunnerEnv({ API_TOKEN: 't' }).runTimeoutMs).toBe(30 * 60_000);
        expect(loadRunnerEnv({ API_TOKEN: 't', RUN_TIMEOUT_MINUTES: '5' }).runTimeoutMs).toBe(
            5 * 60_000,
        );
    });

    it('drops trailing slashes from the API URL', () => {
        expect(
            loadRunnerEnv({ API_TOKEN: 't', LYFESTYLE_API_URL: 'https://api.test//' }).apiUrl,
        ).toBe('https://api.test');
    });

    it('needs a token', () => {
        expect(() => loadRunnerEnv({ LYFESTYLE_API_TOKEN: '' })).toThrow('LYFESTYLE_API_TOKEN');
    });
});
