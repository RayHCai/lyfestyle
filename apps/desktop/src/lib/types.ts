export type Role = 'user' | 'assistant';

export interface Message {
    id: string;
    role: Role;
    content: string;
    createdAt: number;
    /** Text still arriving from the agent; merged into content when the turn ends. */
    live?: string;
    /** Names of tools the agent used while producing this message. */
    tools?: string[];
    error?: string;
    /** API mode: the run that produced (or is producing) this message. */
    runId?: string;
}

export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    /** Claude Code session id, used to resume the same context on the next turn (local mode). */
    sessionId?: string;
    messages: Message[];
    streaming?: boolean;
    source?: 'chat' | 'automation';
    stderr?: string;
    /** API mode: the run currently streaming into this conversation. */
    runId?: string;
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

export type Trigger =
    | { type: 'manual' }
    | { type: 'interval'; minutes: number }
    | { type: 'daily'; time: string }
    /** API mode only: a five-field cron expression evaluated in the automation's time zone. */
    | { type: 'cron'; expr: string };

export interface RunSummary {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    createdAt: number;
    finishedAt?: number;
    output?: string;
    error?: string;
}

export interface Automation {
    id: string;
    name: string;
    prompt: string;
    trigger: Trigger;
    enabled: boolean;
    createdAt: number;
    lastRunAt?: number;
    nextRunAt?: number;
    /** Local mode: the conversation the last run wrote into. */
    lastConversationId?: string;
    /** API mode: IANA time zone the schedule is evaluated in. */
    timezone?: string;
    /** API mode: the most recent run. */
    lastRun?: RunSummary;
}

export interface Settings {
    name: string;
    agentCommand: string;
    model: string;
    workingDirectory: string;
    globalShortcut: boolean;
    /** Lyfestyle API origin; with a token it switches the app from local files to the API. */
    apiUrl: string;
    apiToken: string;
}

export const defaultSettings: Settings = {
    name: '',
    agentCommand: 'claude',
    model: '',
    workingDirectory: '',
    globalShortcut: true,
    apiUrl: '',
    apiToken: '',
};

export interface AgentEnv {
    harness: string | null;
    platform: string;
    apiUrl: string | null;
    apiToken: string | null;
}

export type View =
    | { name: 'home' }
    | { name: 'conversation'; id: string }
    | { name: 'conversations' }
    | { name: 'documents'; id?: string }
    | { name: 'automations'; id?: string }
    | { name: 'settings' };
