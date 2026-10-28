/** API transcripts as the UI shows them. Pure, so the mapping can be tested without a store. */
import type { ContentBlock } from '@lyfestyle/shared';
import type { ApiMessage } from './api';
import { joinText, readBlocks } from './turn';
import type { Message } from './types';

const isDeployTool = (name: string) => /(^|__)automations_deploy$/.test(name);

/** Records the tool-use ids of `automations_deploy` calls, whose results become approval prompts. */
export function noteDeployCalls(blocks: readonly ContentBlock[], calls: Set<string>): void {
    for (const b of blocks) if (b.type === 'tool_use' && isDeployTool(b.name)) calls.add(b.id);
}

/** Deploy ids from the results of recorded deploy calls (the tool answers `{ id, status, ... }`). */
export function deploysIn(blocks: readonly ContentBlock[], calls: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const b of blocks) {
        if (b.type !== 'tool_result' || b.isError || !calls.has(b.toolUseId)) continue;
        try {
            const result = JSON.parse(b.content) as { id?: unknown };
            if (typeof result.id === 'string') out.push(result.id);
        } catch {
            // Not JSON: an error text the tool answered with, so there is nothing to approve.
        }
    }
    return out;
}

export const withDeploys = (m: Message, ids: string[]): Message =>
    ids.length ? { ...m, deploys: [...new Set([...(m.deploys ?? []), ...ids])] } : m;

/** The API transcript as the UI shows it: one assistant message per run, tool results folded away. */
export function mapTranscript(messages: ApiMessage[]): Message[] {
    const out: Message[] = [];
    const calls = new Set<string>();
    for (const m of messages) {
        const createdAt = new Date(m.createdAt).getTime();
        const runId = m.runId ?? undefined;
        const last = out.at(-1);
        if (m.role === 'user') {
            out.push({
                id: m.id,
                role: 'user',
                content: readBlocks(m.content).text,
                createdAt,
                runId,
            });
        } else if (m.role === 'tool') {
            // Results answer the latest assistant message of the same run.
            const ids = deploysIn(m.content, calls);
            if (ids.length && last?.role === 'assistant' && last.runId === runId)
                out[out.length - 1] = withDeploys(last, ids);
        } else if (m.role === 'assistant') {
            noteDeployCalls(m.content, calls);
            const { text, tools } = readBlocks(m.content);
            if (last?.role === 'assistant' && last.runId === runId) {
                out[out.length - 1] = {
                    ...last,
                    content: joinText(last.content, text),
                    tools: [...(last.tools ?? []), ...tools],
                };
            } else {
                out.push({
                    id: m.id,
                    role: 'assistant',
                    content: text,
                    createdAt,
                    runId,
                    tools: tools.length ? tools : undefined,
                });
            }
        }
    }
    return out;
}
