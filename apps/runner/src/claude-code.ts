import {
    query as sdkQuery,
    type McpServerConfig,
    type Options,
    type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock, ModelUsageTotals, RunEventInput } from '@lyfestyle/shared';
import {
    transcript,
    type Harness,
    type HarnessInput,
    type HarnessResult,
    type McpServerSpec,
} from './harness.js';

/** Built-in Claude Code tools the agent gets; file and shell tools stay off by default. */
export const DEFAULT_TOOLS = ['WebSearch', 'WebFetch'];

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

export interface ClaudeCodeOptions {
    /** Working directory for the Claude Code process, kept apart from any real project. */
    cwd: string;
    model?: string | undefined;
    tools?: string[] | undefined;
    /** claude.ai connector tools to allow; empty keeps claude.ai connectors from loading at all. */
    connectorTools?: string[] | undefined;
    maxTurns?: number | undefined;
    maxBudgetUsd?: number | undefined;
    /** Replaces the default system prompt builder. */
    systemPrompt?: ((input: HarnessInput) => string) | undefined;
    /** The SDK's `query`, swappable in tests. */
    query?: typeof sdkQuery | undefined;
}

export function defaultSystemPrompt(input: HarnessInput, now = new Date()): string {
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
    if (input.job) {
        lines.push(
            `This run is the scheduled automation "${input.job.name}", and the user is not watching. Do the task, then end with a short summary of what you did.`,
        );
    }
    return lines.join('\n');
}

function sdkServer(spec: McpServerSpec): McpServerConfig {
    if (spec.transport === 'stdio') {
        return { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
    }
    return { type: spec.transport, url: spec.url, headers: spec.headers };
}

type Block = { type: string; [key: string]: unknown };

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? null);
    return (content as Block[])
        .map((part) => (part.type === 'text' ? String(part.text) : `[${part.type}]`))
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

/** Claude Code reports totals for the whole session; a run records only what it added. */
function usageDelta(
    cumulative: ModelUsageTotals,
    before: ModelUsageTotals | undefined,
): ModelUsageTotals {
    const less = (key: Exclude<keyof ModelUsageTotals, 'model'>) =>
        Math.max(0, cumulative[key] - (before?.[key] ?? 0));
    return {
        model: cumulative.model,
        inputTokens: less('inputTokens'),
        outputTokens: less('outputTokens'),
        cacheReadTokens: less('cacheReadTokens'),
        cacheWriteTokens: less('cacheWriteTokens'),
        costUsd: Math.round(less('costUsd') * 1e8) / 1e8,
    };
}

/** Translates one Agent SDK message into the API's run events. */
export function mapSdkMessage(
    message: SDKMessage,
    harness: string,
    baseline: ModelUsageTotals[] = [],
): RunEventInput[] {
    switch (message.type) {
        case 'system': {
            if (message.subtype !== 'init') return [];
            const failed = message.mcp_servers.filter((s) => s.status !== 'connected');
            return [
                { type: 'session', harness, sessionId: message.session_id },
                {
                    type: 'log',
                    level: 'info',
                    message: `Claude Code ${message.claude_code_version} using ${message.model}`,
                    data: { tools: message.tools, mcpServers: message.mcp_servers },
                },
                ...failed.map((s) => ({
                    type: 'log' as const,
                    level: 'warn' as const,
                    message: `MCP server "${s.name}" is ${s.status}`,
                })),
            ];
        }
        case 'assistant': {
            if (message.parent_tool_use_id) return [];
            const content = assistantBlocks(message.message.content as unknown as Block[]);
            const events: RunEventInput[] = content.length
                ? [{ type: 'message', role: 'assistant', content }]
                : [];
            if (message.error)
                events.push({
                    type: 'log',
                    level: 'error',
                    message: `Claude API error: ${message.error}`,
                });
            return events;
        }
        case 'user': {
            if (message.parent_tool_use_id || typeof message.message.content === 'string')
                return [];
            const results = (message.message.content as unknown as Block[])
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
            const usage = Object.entries(message.modelUsage).map(
                ([model, u], index): RunEventInput => ({
                    type: 'usage',
                    ...usageDelta(
                        {
                            model,
                            inputTokens: u.inputTokens,
                            outputTokens: u.outputTokens,
                            cacheReadTokens: u.cacheReadInputTokens,
                            cacheWriteTokens: u.cacheCreationInputTokens,
                            costUsd: u.costUSD,
                        },
                        baseline.find((b) => b.model === model),
                    ),
                    sessionId: message.session_id,
                    ...(index === 0 ? { durationMs: Math.round(message.duration_ms) } : {}),
                }),
            );
            const failed = message.subtype !== 'success' || message.is_error;
            return [
                ...usage,
                {
                    type: 'log',
                    level: failed ? 'error' : 'info',
                    message: failed
                        ? `Run ended with ${message.subtype}`
                        : `Finished in ${message.num_turns} turns`,
                    data: {
                        subtype: message.subtype,
                        numTurns: message.num_turns,
                        durationMs: message.duration_ms,
                        totalCostUsd: message.total_cost_usd,
                        ...(message.subtype === 'success' ? {} : { errors: message.errors }),
                    },
                },
            ];
        }
        default:
            return [];
    }
}

export class HarnessError extends Error {}

/** Runs turns through the locally installed Claude Code, via the Agent SDK. */
export class ClaudeCodeHarness implements Harness {
    readonly name = 'claude-code';
    readonly #options: ClaudeCodeOptions;

    constructor(options: ClaudeCodeOptions) {
        this.#options = options;
    }

    async run(input: HarnessInput): Promise<HarnessResult> {
        const opts = this.#options;
        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        input.signal.addEventListener('abort', onAbort, { once: true });

        const resume = input.session?.harness === this.name ? input.session.sessionId : undefined;
        const baseline = resume ? (input.session?.usage ?? []) : [];
        const tools = opts.tools ?? DEFAULT_TOOLS;
        const connectorTools = opts.connectorTools ?? DEFAULT_CONNECTOR_TOOLS;
        const mcpServers = Object.fromEntries(input.mcpServers.map((s) => [s.name, sdkServer(s)]));
        const earlier = resume ? '' : transcript(input.history);

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
            systemPrompt: (opts.systemPrompt ?? defaultSystemPrompt)(input),
            env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'lyfestyle-runner/0.1.0' },
            ...(resume ? { resume } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
            ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
        };
        const prompt = earlier
            ? `<conversation_so_far>\n${earlier}\n</conversation_so_far>\n\n${input.prompt}`
            : input.prompt;

        let output: string | null = null;
        try {
            for await (const message of (opts.query ?? sdkQuery)({ prompt, options })) {
                for (const event of mapSdkMessage(message, this.name, baseline)) input.emit(event);
                if (message.type !== 'result') continue;
                if (message.subtype !== 'success') {
                    throw new HarnessError(message.errors.join('\n') || message.subtype);
                }
                if (message.is_error)
                    throw new HarnessError(message.result || 'Claude Code reported an error');
                output = message.result;
            }
        } finally {
            input.signal.removeEventListener('abort', onAbort);
        }
        return { output };
    }
}
