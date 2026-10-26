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
    /** Set when the run is a scheduled automation rather than a chat turn. */
    job: { id: string; name: string } | null;
    /** The API's own tool server first, then every enabled server from the registry. */
    mcpServers: McpServerSpec[];
    signal: AbortSignal;
    emit(event: RunEventInput): void;
}

export interface HarnessResult {
    output: string | null;
}

/** An agent loop the runner can hand a claimed run to. */
export interface Harness {
    readonly name: string;
    run(input: HarnessInput): Promise<HarnessResult>;
}

/** Earlier turns as plain text, for a harness starting a fresh session mid-conversation. */
export function transcript(history: HarnessInput['history']): string {
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
