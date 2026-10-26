import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface RunnerEnv {
    apiUrl: string;
    apiToken: string;
    runnerId: string;
    concurrency: number;
    /** `claude-code` (default) or `command`, which runs AGENT_HARNESS_COMMAND. */
    harness: string;
    harnessCommand: string | undefined;
    model: string | undefined;
    tools: string[] | undefined;
    /** claude.ai connector tool names; `none` turns the connectors off. */
    connectorTools: string[] | undefined;
    cwd: string;
    maxTurns: number;
    maxBudgetUsd: number | undefined;
}

/** A comma list, `none` for an empty list, or undefined to keep the default. */
const toolList = (value: string | undefined) =>
    value === undefined
        ? undefined
        : value.trim() === 'none'
          ? []
          : value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean);

const number = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadRunnerEnv(raw: Record<string, string | undefined> = process.env): RunnerEnv {
    // A bare `KEY=` line in .env arrives as an empty string; it means unset.
    const env = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined && value.trim() !== ''),
    ) as Record<string, string | undefined>;
    const apiToken = env.LYFESTYLE_API_TOKEN ?? env.API_TOKEN;
    if (!apiToken)
        throw new Error('Set LYFESTYLE_API_TOKEN (or API_TOKEN) to the API bearer token');
    return {
        apiUrl: (env.LYFESTYLE_API_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(
            /\/+$/,
            '',
        ),
        apiToken,
        runnerId: env.RUNNER_ID ?? hostname(),
        concurrency: number(env.RUNNER_CONCURRENCY, 1),
        harness: env.AGENT_HARNESS ?? (env.AGENT_HARNESS_COMMAND ? 'command' : 'claude-code'),
        harnessCommand: env.AGENT_HARNESS_COMMAND,
        model: env.AGENT_MODEL,
        tools: toolList(env.AGENT_TOOLS),
        connectorTools: toolList(env.AGENT_CONNECTOR_TOOLS),
        cwd: env.AGENT_CWD ?? join(homedir(), '.lyfestyle', 'agent'),
        maxTurns: number(env.AGENT_MAX_TURNS, 50),
        maxBudgetUsd: env.AGENT_MAX_BUDGET_USD
            ? number(env.AGENT_MAX_BUDGET_USD, 0) || undefined
            : undefined,
    };
}
