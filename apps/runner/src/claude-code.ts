import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import {
    INT4_MAX,
    type ContentBlock,
    type ModelUsageTotals,
    type RunEventInput,
} from '@lyfestyle/shared';
import { readFileSync } from 'node:fs';
import {
    agentEnv,
    budgetFor,
    isRecord,
    mcpConfig,
    promptFor,
    resultOutcome,
    type Harness,
    type HarnessInput,
    type HarnessResult,
} from './harness.js';

/** Built-in Claude Code tools the agent gets; file and shell tools stay off by default. */
const DEFAULT_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * Tools from the claude.ai connectors (the account Claude Code is logged in with) the agent may
 * call: Gmail read-only, Calendar read and write. Every other connector tool is denied.
 */
export const DEFAULT_CONNECTOR_TOOLS = [
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__get_thread',
    'mcp__claude_ai_Gmail__get_message',
    'mcp__claude_ai_Gmail__list_labels',
    'mcp__claude_ai_Google_Calendar__list_calendars',
    'mcp__claude_ai_Google_Calendar__list_events',
    'mcp__claude_ai_Google_Calendar__search_events',
    'mcp__claude_ai_Google_Calendar__get_event',
    'mcp__claude_ai_Google_Calendar__suggest_time',
    'mcp__claude_ai_Google_Calendar__create_event',
    'mcp__claude_ai_Google_Calendar__update_event',
    'mcp__claude_ai_Google_Calendar__delete_event',
];

const MAX_TOOL_RESULT = 20_000;

const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** How the runner names itself in Claude Code's User-Agent. */
const CLIENT_APP = `lyfestyle-runner/${version}`;

/**
 * What Claude Code prints (to stderr, which the SDK puts in its exit error) when `resume` names a
 * session it has no transcript for: cleaned up, another AGENT_CWD, or another machine.
 */
const MISSING_SESSION = /No conversation found/i;

export interface ClaudeCodeOptions {
    /** Working directory for the Claude Code process, kept apart from any real project. */
    cwd: string;
    model?: string | undefined;
    tools?: string[] | undefined;
    /** claude.ai connector tools to allow; empty keeps claude.ai connectors from loading at all. */
    connectorTools?: string[] | undefined;
    maxTurns?: number | undefined;
    maxBudgetUsd?: number | undefined;
    /** The SDK's `query`, swappable in tests. */
    query?: typeof sdkQuery | undefined;
}

function systemPrompt(input: HarnessInput): string {
    const now = new Date();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = now.toLocaleDateString('en-CA', { timeZone: zone });
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: zone });
    const lines = [
        "You are the agent inside Lyfestyle, the user's personal knowledge and productivity hub.",
        `Today is ${weekday} ${today}; the user's time zone is ${zone}. Planner tools take dates as YYYY-MM-DD in that zone.`,
        "The lyfestyle tools reach the user's pages, planner, automations and connected accounts. Look things up with them rather than guessing, and record what is worth keeping in pages.",
        'Pages are markdown. Link one page to another with [label](page:<page id>).',
        'Anything that sends, deletes or invites on the user’s behalf needs their clear go-ahead first.',
    ];
    if (input.automation) {
        lines.push(
            `The automation "${input.automation.name}" started this run, and the user is not watching. Do the task, then end with exactly the text the automation asked for: your final message is returned to its code.`,
        );
    }
    if (input.soul) {
        lines.push(
            '',
            "The user's SOUL.md follows. It describes who they are and how they want you to work; follow it in every reply.",
            `<soul>\n${input.soul}\n</soul>`,
        );
    }
    return lines.join('\n');
}

type Block = Record<string, unknown> & { type: string };

const isBlock = (value: unknown): value is Block =>
    isRecord(value) && typeof value.type === 'string';

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** A count the API can store; anything that is not a non-negative number counts as 0. */
const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Math.round(value), INT4_MAX)
        : 0;

const usd = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const unreadable = (what: string): RunEventInput => ({
    type: 'log',
    level: 'warn',
    message: `Ignored ${what} from the agent`,
});

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? null);
    return content
        .map((part) =>
            isBlock(part) ? (part.type === 'text' ? String(part.text) : `[${part.type}]`) : '',
        )
        .join('\n');
}

const clip = (text: string) =>
    text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}…[truncated]` : text;

function assistantBlocks(content: Block[]): ContentBlock[] {
    return content.flatMap((block): ContentBlock[] => {
        switch (block.type) {
            case 'text':
                return block.text ? [{ type: 'text', text: String(block.text) }] : [];
            case 'thinking':
                return block.thinking ? [{ type: 'thinking', text: String(block.thinking) }] : [];
            case 'tool_use':
            case 'server_tool_use':
            case 'mcp_tool_use':
                return [
                    {
                        type: 'tool_use',
                        id: String(block.id),
                        name: String(block.name),
                        input: block.input,
                    },
                ];
            default:
                return block.type.endsWith('_tool_result') && typeof block.tool_use_id === 'string'
                    ? [
                          {
                              type: 'tool_result',
                              toolUseId: block.tool_use_id,
                              content: clip(toolResultText(block.content)),
                          },
                      ]
                    : [];
        }
    });
}

/**
 * A run records only what it added. A resumed Claude Code session reports totals that continue
 * from what its transcript saved, so the session's earlier spend is subtracted. A transcript
 * without saved totals reports this run alone; any figure below the baseline means exactly that.
 */
function usageDelta(
    reported: ModelUsageTotals,
    before: ModelUsageTotals | undefined,
): ModelUsageTotals {
    const keys = [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'costUsd',
    ] as const;
    const cumulative = before && keys.every((key) => reported[key] >= before[key]);
    const delta = { ...reported };
    if (cumulative) for (const key of keys) delta[key] = reported[key] - before[key];
    delta.costUsd = Math.round(delta.costUsd * 1e8) / 1e8;
    return delta;
}

/**
 * Translates one Agent SDK / stream-json message into the API's run events. It is the trust
 * boundary for a command's output, so it checks every field it reads and turns a line it cannot
 * use into a warning instead of throwing.
 */
export function mapSdkMessage(
    message: unknown,
    harness: string,
    baseline: ModelUsageTotals[] = [],
): RunEventInput[] {
    if (!isRecord(message) || typeof message.type !== 'string')
        return [unreadable('a line that is not a stream-json message')];
    switch (message.type) {
        case 'system': {
            if (message.subtype !== 'init') return [];
            const sessionId = str(message.session_id);
            if (!sessionId) return [unreadable('an init line without a session id')];
            const servers = Array.isArray(message.mcp_servers)
                ? message.mcp_servers.filter(isRecord)
                : [];
            const version = str(message.claude_code_version);
            const model = str(message.model) ?? 'its default model';
            return [
                { type: 'session', harness, sessionId },
                {
                    type: 'log',
                    level: 'info',
                    message: version
                        ? `Claude Code ${version} using ${model}`
                        : `Agent started using ${model}`,
                    data: { tools: message.tools, mcpServers: servers },
                },
                ...servers
                    .filter((s) => s.status !== 'connected')
                    .map((s): RunEventInput => ({
                        type: 'log',
                        level: 'warn',
                        message: `MCP server "${String(s.name)}" is ${String(s.status)}`,
                    })),
            ];
        }
        case 'assistant': {
            if (message.parent_tool_use_id) return [];
            const body = isRecord(message.message) ? message.message.content : undefined;
            if (typeof body !== 'string' && !Array.isArray(body))
                return [unreadable('an assistant line without content')];
            const content =
                typeof body === 'string'
                    ? body
                        ? [{ type: 'text' as const, text: body }]
                        : []
                    : assistantBlocks(body.filter(isBlock));
            const events: RunEventInput[] = content.length
                ? [{ type: 'message', role: 'assistant', content }]
                : [];
            if (message.error)
                events.push({
                    type: 'log',
                    level: 'error',
                    message: `Claude API error: ${String(message.error)}`,
                });
            return events;
        }
        case 'user': {
            const body = isRecord(message.message) ? message.message.content : undefined;
            // A string is the prompt itself echoed back; only tool results are worth recording.
            if (message.parent_tool_use_id || !Array.isArray(body)) return [];
            const results = body
                .filter(isBlock)
                .filter((block) => block.type === 'tool_result')
                .map((block): ContentBlock => ({
                    type: 'tool_result',
                    toolUseId: String(block.tool_use_id),
                    content: clip(toolResultText(block.content)),
                    ...(block.is_error ? { isError: true } : {}),
                }));
            return results.length ? [{ type: 'message', role: 'tool', content: results }] : [];
        }
        case 'result': {
            const subtype = str(message.subtype);
            if (!subtype) return [unreadable('a result line without a subtype')];
            const sessionId = str(message.session_id);
            const models = isRecord(message.modelUsage) ? Object.entries(message.modelUsage) : [];
            const usage = models
                .filter((entry): entry is [string, Record<string, unknown>] =>
                    Boolean(entry[0] && isRecord(entry[1])),
                )
                .map(([model, u], index): RunEventInput => ({
                    type: 'usage',
                    ...usageDelta(
                        {
                            model,
                            inputTokens: count(u.inputTokens),
                            outputTokens: count(u.outputTokens),
                            cacheReadTokens: count(u.cacheReadInputTokens),
                            cacheWriteTokens: count(u.cacheCreationInputTokens),
                            costUsd: usd(u.costUSD),
                        },
                        baseline.find((b) => b.model === model),
                    ),
                    ...(sessionId ? { sessionId } : {}),
                    ...(index === 0 ? { durationMs: count(message.duration_ms) } : {}),
                }));
            const failed = subtype !== 'success' || message.is_error === true;
            return [
                ...usage,
                {
                    type: 'log',
                    level: failed ? 'error' : 'info',
                    message: failed
                        ? `Run ended with ${subtype}`
                        : typeof message.num_turns === 'number'
                          ? `Finished in ${message.num_turns} turns`
                          : 'Finished',
                    data: {
                        subtype,
                        numTurns: message.num_turns,
                        durationMs: message.duration_ms,
                        totalCostUsd: message.total_cost_usd,
                        ...(subtype === 'success' ? {} : { errors: message.errors }),
                    },
                },
            ];
        }
        default:
            return [];
    }
}

/** A resume that failed because Claude Code no longer has the session. */
class MissingSession extends Error {}

/** Runs turns through the locally installed Claude Code, via the Agent SDK. */
export class ClaudeCodeHarness implements Harness {
    readonly name = 'claude-code';
    readonly #options: ClaudeCodeOptions;

    constructor(options: ClaudeCodeOptions) {
        this.#options = options;
    }

    async run(input: HarnessInput): Promise<HarnessResult> {
        const session = input.session?.harness === this.name ? input.session : null;
        if (session) {
            try {
                return await this.#turn(input, session);
            } catch (err) {
                if (!(err instanceof MissingSession)) throw err;
                input.emit({
                    type: 'log',
                    level: 'warn',
                    message: `Claude Code no longer has session ${session.sessionId}; starting a new one with the conversation so far`,
                });
            }
        }
        return this.#turn(input, null);
    }

    async #turn(
        input: HarnessInput,
        resume: NonNullable<HarnessInput['session']> | null,
    ): Promise<HarnessResult> {
        // An abort that landed before this point has no listener to reach.
        if (input.signal.aborted) throw new Error('Run stopped before Claude Code started');
        const opts = this.#options;
        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        input.signal.addEventListener('abort', onAbort, { once: true });

        const tools = opts.tools ?? DEFAULT_TOOLS;
        const connectorTools = opts.connectorTools ?? DEFAULT_CONNECTOR_TOOLS;
        const mcpServers = mcpConfig(input.mcpServers);
        const options: Options = {
            abortController,
            cwd: opts.cwd,
            tools,
            allowedTools: [
                ...tools,
                ...Object.keys(mcpServers).map((name) => `mcp__${name}`),
                ...connectorTools,
            ],
            permissionMode: 'dontAsk',
            mcpServers,
            // Strict mode also drops claude.ai connectors; with settingSources [] they are the only
            // extra servers that load, and dontAsk denies any of their tools not allowed above.
            strictMcpConfig: connectorTools.length === 0,
            settingSources: [],
            systemPrompt: systemPrompt(input),
            env: agentEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }),
            ...(resume ? { resume: resume.sessionId } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
            // Claude Code checks this against what the process itself spent, not the session total
            // a resumed transcript restores (see `total_cost_usd` in the SDK's sdk.d.ts), so the
            // run's own budget is right for a resumed session too.
            maxBudgetUsd: budgetFor(input, opts.maxBudgetUsd),
        };
        const baseline = resume?.usage ?? [];
        const prompt = promptFor(input, { resumed: resume !== null });

        let output: string | null = null;
        let started = false;
        try {
            for await (const message of (opts.query ?? sdkQuery)({ prompt, options })) {
                const outcome = resultOutcome(message);
                if (
                    resume &&
                    !started &&
                    outcome &&
                    'error' in outcome &&
                    MISSING_SESSION.test(outcome.error)
                )
                    throw new MissingSession(outcome.error);
                if (message.type === 'system' && message.subtype === 'init') started = true;
                for (const event of mapSdkMessage(message, this.name, baseline)) input.emit(event);
                if (!outcome) continue;
                if ('error' in outcome) throw new Error(outcome.error);
                output = outcome.output;
            }
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            if (resume && !started && !input.signal.aborted && MISSING_SESSION.test(text))
                throw new MissingSession(text);
            throw err;
        } finally {
            input.signal.removeEventListener('abort', onAbort);
        }
        if (output === null && input.signal.aborted) throw new Error('Claude Code was stopped');
        return { output };
    }
}
