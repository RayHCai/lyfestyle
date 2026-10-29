export type Role = 'user' | 'assistant';

export interface Message {
    id: string;
    role: Role;
    content: string;
    createdAt: number;
    /** Text still arriving from the agent; merged into content when the turn ends. */
    live?: string | undefined;
    /** Names of tools the agent used while producing this message. */
    tools?: string[] | undefined;
    error?: string | undefined;
    /** API mode: the run that produced (or is producing) this message. */
    runId?: string | undefined;
    /** API mode: automation deploys the agent proposed in this message, shown as approval prompts. */
    deploys?: string[];
}

export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    /** Claude Code session id, used to resume the same context on the next turn (local mode). */
    sessionId?: string | undefined;
    messages: Message[];
    streaming?: boolean;
    stderr?: string | undefined;
    /** API mode: the run currently streaming into this conversation. */
    runId?: string | undefined;
    /** API mode: false until the transcript has been fetched. */
    loaded?: boolean;
    /** API mode: created while the API was unreachable; exists only in this window. */
    offline?: boolean;
}

export interface DocMeta {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}

/** API mode: a document in the trash. */
export interface TrashedDoc extends DocMeta {
    deletedAt: number;
    excerpt: string;
}

/** Days a trashed document stays restorable before the API purges it. */
export { TRASH_DAYS } from '@lyfestyle/shared';

export interface Settings {
    name: string;
    /** The harness new turns use: `claude-code`, `codex` or `command`. */
    harness: string;
    /** Claude Code's command; empty finds `claude` on PATH. */
    agentCommand: string;
    /** Codex's command; empty finds `codex` on PATH. */
    codexCommand: string;
    /** A stream-json command for the `command` harness. */
    customCommand: string;
    model: string;
    /** Claude Code `--effort`: low, medium, high, xhigh or max; empty for its default. */
    effort: string;
    workingDirectory: string;
    /** Folder of `<name>/SKILL.md` skills linked into `~/.claude/skills`; empty for the default. */
    skillsDirectory: string;
    /** The todo app's MCP URL (`…/mcp/<secret>`). Given to every agent as the `todo` server. */
    todoMcpUrl: string;
    /** Lyfestyle API origin; with a token it switches the app from local files to the API. */
    apiUrl: string;
    apiToken: string;
}

export const defaultSettings: Settings = {
    name: '',
    harness: 'claude-code',
    agentCommand: '',
    codexCommand: '',
    customCommand: '',
    model: '',
    effort: '',
    workingDirectory: '',
    skillsDirectory: '',
    todoMcpUrl: '',
    apiUrl: '',
    apiToken: '',
};

/** A skill the user can run as `/name` from the composer. */
export interface Skill {
    name: string;
    description: string;
}

export interface AgentEnv {
    harness: string | null;
    apiUrl: string | null;
    apiToken: string | null;
    /** Harness CLIs found on PATH (`claude-code`, `codex`), with their path or null. */
    harnesses: { id: string; path: string | null }[];
}

export type View =
    | { name: 'home' }
    | { name: 'conversation'; id: string }
    | { name: 'conversations' }
    | { name: 'documents'; id?: string | undefined }
    | { name: 'automations' }
    | { name: 'pageviews' }
    | { name: 'settings' };
