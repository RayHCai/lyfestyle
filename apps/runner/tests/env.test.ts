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

    it('needs a token', () => {
        expect(() => loadRunnerEnv({ LYFESTYLE_API_TOKEN: '' })).toThrow('LYFESTYLE_API_TOKEN');
    });
});
