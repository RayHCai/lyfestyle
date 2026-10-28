import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type {
    ContentBlock,
    MessageRole,
    ModelUsageTotals,
    RunEventInput,
    RunKind,
} from '@lyfestyle/shared';

export type McpServerSpec =
    | { name: string; transport: 'http' | 'sse'; url: string; headers: Record<string, string> }
    | {
          name: string;
          transport: 'stdio';
          command: string;
          args: string[];
          env: Record<string, string>;
      };

export interface HarnessInput {
    runId: string;
    kind: RunKind;
    prompt: string;
    /** The conversation's session with whichever harness ran it last, and what it has spent. */
    session: { harness: string; sessionId: string; usage: ModelUsageTotals[] } | null;
    /** Earlier turns, for a harness that cannot resume `session`. */
    history: { role: MessageRole; content: ContentBlock[] }[];
    /** Set when an automation's code started the run rather than a chat turn. */
    automation: { id: string; name: string } | null;
    /** The user's SOUL.md, followed on every run; '' when there is none. */
    soul: string;
    /**
     * Most the run may spend, in USD. The harness must enforce it itself: the API only cancels a
     * run once a usage report shows it over budget, and a stream-json agent reports usage at the end.
     */
    budgetUsd: number;
    /** The API's own tool server first (with the run's agent token), then every enabled server. */
    mcpServers: McpServerSpec[];
    /**
     * Aborted when the run must stop: a cancel, a deleted run, the runner's time limit or shutdown.
     * It may already be aborted when `run` is called.
     */
    signal: AbortSignal;
    emit(event: RunEventInput): void;
}

export interface HarnessResult {
    output: string | null;
}

/**
 * An agent loop the runner can hand a claimed run to. `run` resolves once the agent finished its
 * turn, and rejects when it failed or `input.signal` stopped it before it finished.
 */
export interface Harness {
    readonly name: string;
    run(input: HarnessInput): Promise<HarnessResult>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Earlier turns as plain text, for a harness starting a fresh session mid-conversation. */
function transcript(history: HarnessInput['history']): string {
    const lines = history.flatMap(({ role, content }) =>
        content.flatMap((block) => {
            if (block.type === 'text')
                return [`${role === 'user' ? 'User' : 'Assistant'}: ${block.text}`];
            if (block.type === 'tool_use') return [`Assistant used tool ${block.name}`];
            return [];
        }),
    );
    return lines.join('\n\n');
}

/**
 * The prompt to send. A fresh session gets the earlier turns first; `withSoul` also puts the
 * user's SOUL.md at the top of it, for a harness with no system prompt to carry it.
 */
export function promptFor(
    input: HarnessInput,
    options: { resumed: boolean; withSoul?: boolean },
): string {
    if (options.resumed) return input.prompt;
    const earlier = transcript(input.history);
    return [
        options.withSoul && input.soul ? `<soul>\n${input.soul}\n</soul>` : '',
        earlier ? `<conversation_so_far>\n${earlier}\n</conversation_so_far>` : '',
        input.prompt,
    ]
        .filter(Boolean)
        .join('\n\n');
}

/** The run's MCP servers as Claude Code's config, the shape `--mcp-config` files use too. */
export function mcpConfig(servers: McpServerSpec[]): Record<string, McpServerConfig> {
    return Object.fromEntries(
        servers.map((spec): [string, McpServerConfig] => [
            spec.name,
            spec.transport === 'stdio'
                ? { type: 'stdio', command: spec.command, args: spec.args, env: spec.env }
                : { type: spec.transport, url: spec.url, headers: spec.headers },
        ]),
    );
}

/** Most a run may spend: its own budget, or the runner's lower cap. */
export const budgetFor = (input: HarnessInput, cap: number | undefined) =>
    Math.min(cap ?? Infinity, input.budgetUsd);

/**
 * What a stream-json `result` line says about the turn: its output, or why it failed. Null for any
 * other line. Command output is untrusted, so the shape is checked rather than assumed.
 */
export function resultOutcome(message: unknown): { output: string } | { error: string } | null {
    if (!isRecord(message) || message.type !== 'result') return null;
    const subtype = typeof message.subtype === 'string' ? message.subtype : 'unknown result';
    const text = typeof message.result === 'string' ? message.result : '';
    if (subtype !== 'success') {
        const errors = Array.isArray(message.errors)
            ? message.errors.filter((e): e is string => typeof e === 'string')
            : [];
        return { error: errors.join('\n') || subtype };
    }
    if (message.is_error === true) return { error: text || 'The agent reported an error' };
    return { output: text };
}

/**
 * Variables in the root `.env` that only the API reads. The runner loads that file too, and an
 * agent (with every MCP server it starts) inherits the runner's environment, so these never reach
 * one: the production database URL, the encryption key, mail and API tokens.
 */
const API_ONLY_ENV = new Set([
    'API_TOKEN',
    'LYFESTYLE_API_TOKEN',
    'ENCRYPTION_KEY',
    'DATABASE_URL',
    'SHADOW_DATABASE_URL',
    'DIRECT_URL',
    'RESEND_API_KEY',
    'RESEND_FROM',
    'NOTIFY_EMAIL',
    'PUBLIC_URL',
    'CORS_ORIGINS',
    'METRICS_ORIGINS',
    'METRICS_RETENTION_DAYS',
    'RUN_BUDGET_USD',
    'RUN_STALE_AFTER_MS',
    'AUTOMATION_TIMEOUT_MS',
    'SCHEDULER_TICK_MS',
]);

/** The environment for an agent process: the runner's own minus API-only secrets, plus `extra`. */
export function agentEnv(
    extra: Record<string, string> = {},
    env: Record<string, string | undefined> = process.env,
): Record<string, string> {
    const kept = Object.entries(env).filter(
        // Windows variable names ignore case, so `database_url` is the same variable.
        (entry): entry is [string, string] =>
            entry[1] !== undefined && !API_ONLY_ENV.has(entry[0].toUpperCase()),
    );
    return { ...Object.fromEntries(kept), ...extra };
}
