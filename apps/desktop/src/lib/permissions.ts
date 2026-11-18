/**
 * Permission prompts from a running Claude Code. `agent.rs` starts it with
 * `--permission-prompt-tool stdio`, so a tool call its permission rules do not settle (an edit
 * outside the working directory, a shell command) arrives on stdout as a `can_use_tool` control
 * request and waits for the answer on stdin. Requests wait here, keyed by the conversation that
 * shows them, until the user answers, Claude Code withdraws them or the process ends.
 */
import { useSyncExternalStore } from 'react';
import { call, isTauri } from './tauri';

export interface PermissionRequest {
    /** The `agent_send` id: the conversation's locally, the run's for an API run. */
    agent: string;
    conversationId: string;
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    /** Claude Code's own wording for the request, when it gives one. */
    title?: string;
    /** Why its rules did not settle it, e.g. the path is outside the working directories. */
    reason?: string;
}

/** What a stdout line means for permissions, if it is a control message at all. */
export type Control =
    | { kind: 'request'; request: Omit<PermissionRequest, 'agent' | 'conversationId'> }
    | { kind: 'cancel'; requestId: string }
    /** A control request the app cannot answer; it gets an error so the agent does not wait. */
    | { kind: 'unsupported'; requestId: string; subtype: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function readControl(line: Record<string, unknown>): Control | null {
    if (line.type === 'control_cancel_request') {
        const requestId = text(line.request_id);
        return requestId ? { kind: 'cancel', requestId } : null;
    }
    if (line.type !== 'control_request') return null;
    const requestId = text(line.request_id);
    const req = line.request;
    if (!requestId || !isRecord(req)) return null;
    const tool = text(req.tool_name);
    if (req.subtype !== 'can_use_tool' || !tool)
        return { kind: 'unsupported', requestId, subtype: String(req.subtype) };
    const reason = isRecord(req.decision_reason)
        ? text(req.decision_reason.reason)
        : text(req.decision_reason);
    const title = text(req.title) ?? text(req.description);
    return {
        kind: 'request',
        request: {
            requestId,
            tool,
            input: isRecord(req.input) ? req.input : {},
            ...(title ? { title } : {}),
            ...(reason ? { reason } : {}),
        },
    };
}

/** The tool input worth showing: the path, command or URL for the usual tools, else all of it. */
export function describeInput(input: Record<string, unknown>): string {
    for (const key of ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern']) {
        const v = text(input[key]);
        if (v) return v;
    }
    const all = JSON.stringify(input, null, 2);
    return all === '{}' ? '' : all.slice(0, 2000);
}

export const DENIED =
    'The user denied this tool call. Do not try to get around it; ask them what they want instead.';

/** The `can_use_tool` answer: allow runs the call as requested. */
export function decision(request: PermissionRequest, allow: boolean) {
    return allow
        ? { behavior: 'allow', updatedInput: request.input }
        : { behavior: 'deny', message: DENIED };
}

// --- the pending list, per conversation ---

const EMPTY: PermissionRequest[] = [];
let pending: Record<string, PermissionRequest[]> = {};
const listeners = new Set<() => void>();

function set(next: Record<string, PermissionRequest[]>) {
    pending = next;
    for (const l of listeners) l();
}

function drop(match: (r: PermissionRequest) => boolean) {
    const next: Record<string, PermissionRequest[]> = {};
    let changed = false;
    for (const [id, list] of Object.entries(pending)) {
        const kept = list.filter((r) => !match(r));
        if (kept.length !== list.length) changed = true;
        if (kept.length) next[id] = kept;
    }
    if (changed) set(next);
}

/** What the agent is asking in a conversation, oldest first. */
export const pendingFor = (conversationId: string) => pending[conversationId] ?? EMPTY;

export const usePermissions = (conversationId: string) =>
    useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => pendingFor(conversationId),
    );

function reply(agent: string, requestId: string, response: unknown, error?: string) {
    if (!isTauri) return Promise.resolve();
    return call('agent_control', {
        args: { conversation_id: agent, request_id: requestId, response, error: error ?? null },
    });
}

/**
 * Takes a stdout line from agent `agent` if it is a control message, and returns what it was
 * (null for any other line). New requests show in `conversationId` until answered.
 */
export function handleControl(
    agent: string,
    conversationId: string,
    line: Record<string, unknown>,
): Control | null {
    const control = readControl(line);
    if (!control) return null;
    if (control.kind === 'cancel') {
        drop((r) => r.agent === agent && r.requestId === control.requestId);
    } else if (control.kind === 'unsupported') {
        reply(agent, control.requestId, null, `Unsupported request: ${control.subtype}`).catch(
            (e: unknown) => console.warn('control request not answered:', e),
        );
    } else {
        const list = pending[conversationId] ?? EMPTY;
        set({
            ...pending,
            [conversationId]: [...list, { ...control.request, agent, conversationId }],
        });
    }
    return control;
}

/** Drops whatever agent `agent` was still asking; called when its process exits. */
export const clearAgent = (agent: string) => drop((r) => r.agent === agent);

/** Answers a request. Rejects when the agent is gone; the request is dropped either way. */
export async function answer(request: PermissionRequest, allow: boolean) {
    try {
        await reply(request.agent, request.requestId, decision(request, allow));
    } finally {
        drop((r) => r.agent === request.agent && r.requestId === request.requestId);
    }
}
