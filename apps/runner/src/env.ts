import { runKind, trimTrailingSlashes, type RunKind } from '@lyfestyle/shared';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface RunnerEnv {
    apiUrl: string;
    apiToken: string;
    runnerId: string;
    concurrency: number;
    /** The run kinds this runner takes; undefined takes every kind. */
    kinds: RunKind[] | undefined;
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
    /** Longest one run may take, in ms. */
    runTimeoutMs: number;
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

/** A setting that must be a positive number (a whole one when `whole`), or `fallback` when unset. */
function positive(
    name: string,
    value: string | undefined,
    fallback: number,
    { whole = false, hint = '' } = {},
) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || (whole && !Number.isInteger(parsed))) {
        const kind = whole ? 'positive whole number' : 'positive number';
        throw new Error(`${name} must be a ${kind}, not "${value}"${hint}`);
    }
    return parsed;
}

const whole = { whole: true };

/** RUNNER_KINDS: a comma list of run kinds, e.g. `automation` for a runner in the cloud. */
function kindList(value: string | undefined): RunKind[] | undefined {
    const kinds = toolList(value);
    if (!kinds?.length) return undefined;
    return kinds.map((kind) => {
        const parsed = runKind.safeParse(kind);
        if (!parsed.success) {
            throw new Error(
                `RUNNER_KINDS takes ${runKind.options.join(', ')}, comma-separated, not "${kind}"`,
            );
        }
        return parsed.data;
    });
}

export function loadRunnerEnv(raw: Record<string, string | undefined> = process.env): RunnerEnv {
    // A bare `KEY=` line in .env arrives as an empty string; it means unset.
    const env = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined && value.trim() !== ''),
    ) as Record<string, string | undefined>;
    const apiToken = env.LYFESTYLE_API_TOKEN ?? env.API_TOKEN;
    if (!apiToken)
        throw new Error('Set LYFESTYLE_API_TOKEN (or API_TOKEN) to the API bearer token');
    const maxBudget = env.AGENT_MAX_BUDGET_USD;
    return {
        apiUrl: trimTrailingSlashes(
            env.LYFESTYLE_API_URL ?? `http://localhost:${env.PORT ?? 3000}`,
        ),
        apiToken,
        runnerId: env.RUNNER_ID ?? hostname(),
        concurrency: positive('RUNNER_CONCURRENCY', env.RUNNER_CONCURRENCY, 1, whole),
        kinds: kindList(env.RUNNER_KINDS),
        harness: env.AGENT_HARNESS ?? (env.AGENT_HARNESS_COMMAND ? 'command' : 'claude-code'),
        harnessCommand: env.AGENT_HARNESS_COMMAND,
        model: env.AGENT_MODEL,
        tools: toolList(env.AGENT_TOOLS),
        connectorTools: toolList(env.AGENT_CONNECTOR_TOOLS),
        cwd: env.AGENT_CWD ?? join(homedir(), '.lyfestyle', 'agent'),
        maxTurns: positive('AGENT_MAX_TURNS', env.AGENT_MAX_TURNS, 50, whole),
        // 0 is refused rather than read as "no cap": an empty line says that.
        maxBudgetUsd:
            maxBudget === undefined
                ? undefined
                : positive('AGENT_MAX_BUDGET_USD', maxBudget, 0, {
                      hint: '; leave it empty for no cap of its own',
                  }),
        runTimeoutMs: positive('RUN_TIMEOUT_MINUTES', env.RUN_TIMEOUT_MINUTES, 30) * 60_000,
    };
}
