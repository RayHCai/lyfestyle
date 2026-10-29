/** How the Automations run log shows an agent run's events: one line per thing that happened. */
import type { ContentBlock, RunEvent } from '@lyfestyle/shared';
import { cost } from './time';

/** Most characters of a tool's input or result shown on its line. */
const CLIP = 400;

const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text);

export interface Line {
    key: string;
    at: string;
    /** A class: `text`, `tool`, `result`, `info`, `warn`, `error`, `status`, `usage`. */
    kind: string;
    text: string;
}

function blockLine(block: ContentBlock): Omit<Line, 'key' | 'at'> | null {
    switch (block.type) {
        case 'text':
            return block.text.trim() ? { kind: 'text', text: block.text } : null;
        case 'thinking':
            return null;
        case 'tool_use':
            return {
                kind: 'tool',
                text: `→ ${block.name} ${clip(JSON.stringify(block.input ?? null))}`,
            };
        case 'tool_result':
            return {
                kind: block.isError ? 'error' : 'result',
                text: `← ${clip(block.content)}`,
            };
    }
}

/** What a run event shows as, one line per content block; session events show nothing. */
export function eventLines(e: RunEvent): Line[] {
    const at = e.createdAt;
    switch (e.type) {
        case 'message':
            return e.content.flatMap((block, i) => {
                const line = blockLine(block);
                return line ? [{ key: `${e.id}:${i}`, at, ...line }] : [];
            });
        case 'log':
            return [{ key: String(e.id), at, kind: e.level, text: e.message }];
        case 'status':
            return [
                {
                    key: String(e.id),
                    at,
                    kind: 'status',
                    text: e.error ? `${e.status}: ${e.error}` : e.status,
                },
            ];
        case 'usage':
            return [
                {
                    key: String(e.id),
                    at,
                    kind: 'usage',
                    text: `${e.model} · ${e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens} in · ${e.outputTokens} out · ${cost(e.costUsd)}`,
                },
            ];
        case 'session':
            return [];
    }
}
