/**
 * The agent harnesses the app can drive: Claude Code (the default), Codex, or a custom
 * stream-json command. Codex prints its own JSON events, so `fromCodex` rewrites them into the
 * Claude Code stream-json lines the rest of the app already understands.
 */
import type { AgentEnv, Settings } from './types';

export type HarnessId = 'claude-code' | 'codex' | 'command';

export const HARNESSES: { id: HarnessId; label: string; setting: keyof Settings }[] = [
    { id: 'claude-code', label: 'claude code', setting: 'agentCommand' },
    { id: 'codex', label: 'codex', setting: 'codexCommand' },
    { id: 'command', label: 'custom command', setting: 'customCommand' },
];

export const isHarnessId = (v: string): v is HarnessId => HARNESSES.some((h) => h.id === v);

/** The harness new turns use. An unknown stored value falls back to Claude Code. */
export const activeHarness = (s: Settings): HarnessId =>
    isHarnessId(s.harness) ? s.harness : 'claude-code';

/** The command to launch `id` with: the Settings field, else what was found on PATH. */
export function harnessCommand(id: HarnessId, s: Settings, env: AgentEnv): string {
    const meta = HARNESSES.find((h) => h.id === id);
    const set = meta ? String(s[meta.setting]).trim() : '';
    if (set) return set;
    return env.harnesses.find((h) => h.id === id)?.path ?? '';
}

/** Why `id` cannot run here, or null when it can. */
export function harnessProblem(id: HarnessId, s: Settings, env: AgentEnv): string | null {
    if (harnessCommand(id, s, env)) return null;
    return id === 'command' ? 'no custom command set' : 'not found on PATH';
}

type Line = Record<string, unknown>;

const isRecord = (v: unknown): v is Line =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A Codex item that stands for a tool call: its Claude-style name and input. */
function codexTool(item: Line): { name: string; input: unknown } | null {
    switch (item.type) {
        case 'command_execution':
            return { name: 'Bash', input: { command: item.command } };
        case 'mcp_tool_call':
            return {
                name: `mcp__${str(item.server)}__${str(item.tool)}`,
                input: item.arguments ?? {},
            };
        case 'web_search':
            return { name: 'WebSearch', input: { query: item.query } };
        case 'file_change':
            return { name: 'Edit', input: { changes: item.changes } };
        default:
            return null;
    }
}

function codexToolOutput(item: Line): string {
    if (item.type === 'command_execution') return str(item.aggregated_output);
    if (item.type === 'mcp_tool_call') {
        const error = isRecord(item.error) ? str(item.error.message) : str(item.error);
        if (error) return error;
        return item.result === undefined ? '' : JSON.stringify(item.result);
    }
    return '';
}

/**
 * Claude Code stream-json lines for one line of `codex exec --json`, or null when the line is not
 * a Codex event (so it is read as Claude's own). `model` names usage, which Codex leaves out.
 */
export function fromCodex(line: unknown, model: string): Line[] | null {
    if (!isRecord(line) || typeof line.type !== 'string') return null;
    switch (line.type) {
        case 'thread.started':
            return [{ type: 'system', subtype: 'init', session_id: str(line.thread_id), model }];
        case 'turn.started':
        case 'item.started':
        case 'item.updated':
            return [];
        case 'item.completed': {
            const item = isRecord(line.item) ? line.item : {};
            const id = str(item.id) || 'item';
            if (item.type === 'agent_message' && str(item.text))
                return [
                    {
                        type: 'assistant',
                        message: { content: [{ type: 'text', text: str(item.text) }] },
                    },
                ];
            const tool = codexTool(item);
            if (!tool) return [];
            const failed = item.status === 'failed' || num(item.exit_code) !== 0;
            return [
                {
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', id, ...tool }] },
                },
                {
                    type: 'user',
                    message: {
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: id,
                                content: codexToolOutput(item),
                                ...(failed ? { is_error: true } : {}),
                            },
                        ],
                    },
                },
            ];
        }
        case 'turn.completed': {
            const u = isRecord(line.usage) ? line.usage : {};
            return [
                {
                    type: 'result',
                    subtype: 'success',
                    result: '',
                    modelUsage: {
                        [model]: {
                            inputTokens: num(u.input_tokens),
                            outputTokens: num(u.output_tokens),
                            cacheReadInputTokens: num(u.cached_input_tokens),
                            cacheCreationInputTokens: 0,
                            // Codex reports no price; its usage is the ChatGPT plan's.
                            costUSD: 0,
                        },
                    },
                },
            ];
        }
        case 'turn.failed':
        case 'error': {
            const message =
                str(line.message) || (isRecord(line.error) ? str(line.error.message) : '');
            return [
                {
                    type: 'result',
                    subtype: 'error_during_execution',
                    is_error: true,
                    result: message || 'Codex failed',
                    errors: [message || 'Codex failed'],
                },
            ];
        }
        default:
            return null;
    }
}
