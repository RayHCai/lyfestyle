import { createApiClient } from '@lyfestyle/client';
import { mkdir } from 'node:fs/promises';
import { ClaudeCodeHarness } from './claude-code.js';
import { CommandHarness } from './command.js';
import { loadRunnerEnv, type RunnerEnv } from './env.js';
import type { Harness } from './harness.js';
import { Runner } from './runner.js';
import { readSoul } from './soul.js';

const harnesses: Record<string, (env: RunnerEnv) => Harness> = {
    'claude-code': (env) =>
        new ClaudeCodeHarness({
            cwd: env.cwd,
            model: env.model,
            tools: env.tools,
            connectorTools: env.connectorTools,
            maxTurns: env.maxTurns,
            maxBudgetUsd: env.maxBudgetUsd,
        }),
    command: (env) => {
        if (!env.harnessCommand)
            throw new Error('AGENT_HARNESS=command needs AGENT_HARNESS_COMMAND');
        return new CommandHarness(env.harnessCommand, {
            maxTurns: env.maxTurns,
            maxBudgetUsd: env.maxBudgetUsd,
        });
    },
};

const env = loadRunnerEnv();
const makeHarness = harnesses[env.harness];
if (!makeHarness) {
    throw new Error(
        `Unknown AGENT_HARNESS "${env.harness}"; use one of ${Object.keys(harnesses).join(', ')}`,
    );
}
await mkdir(env.cwd, { recursive: true });

const harness = makeHarness(env);
const runner = new Runner({
    api: createApiClient({ baseUrl: env.apiUrl, token: env.apiToken }),
    harness,
    runnerId: env.runnerId,
    apiUrl: env.apiUrl,
    concurrency: env.concurrency,
    runTimeoutMs: env.runTimeoutMs,
    soul: () => readSoul(),
    log: (message, data) =>
        console.log(`[runner] ${message}`, ...(data === undefined ? [] : [data])),
});

runner.start();
console.log(`[runner] ${env.runnerId} taking runs from ${env.apiUrl} with ${harness.name}`);

const shutdown = async () => {
    console.log('[runner] Stopping; failing any run in flight');
    await runner.stop();
    process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
