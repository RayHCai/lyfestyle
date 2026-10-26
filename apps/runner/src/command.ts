import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mapSdkMessage } from './claude-code.js';
import { transcript, type Harness, type HarnessInput, type HarnessResult } from './harness.js';

/** Splits a command line on whitespace, keeping quoted runs together. */
export function splitCommand(line: string): string[] {
    const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return parts.map((part) => part.replace(/^(["'])(.*)\1$/, '$2'));
}

/**
 * Any executable that reads a prompt on stdin, takes `--session <id>` to continue a session, and
 * prints Claude Code's stream-json lines: the same contract the desktop app uses for
 * LYFESTYLE_AGENT_COMMAND, so one custom agent plugs into both.
 */
export class CommandHarness implements Harness {
    readonly name = 'command';

    constructor(private readonly command: string) {}

    run(input: HarnessInput): Promise<HarnessResult> {
        const [bin, ...args] = splitCommand(this.command);
        if (!bin) return Promise.reject(new Error('AGENT_HARNESS_COMMAND is empty'));
        const session = input.session?.harness === this.name ? input.session : null;
        if (session) args.push('--session', session.sessionId);
        const earlier = session ? '' : transcript(input.history);

        return new Promise((resolve, reject) => {
            const child = spawn(bin, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: process.platform === 'win32',
            });
            const abort = () => child.kill();
            input.signal.addEventListener('abort', abort, { once: true });

            let output: string | null = null;
            let failure: string | null = null;
            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => {
                stderr = (stderr + chunk.toString()).slice(-4000);
            });

            createInterface({ input: child.stdout }).on('line', (line) => {
                let message: SDKMessage;
                try {
                    message = JSON.parse(line) as SDKMessage;
                } catch {
                    if (line.trim())
                        input.emit({
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'text', text: line }],
                        });
                    return;
                }
                for (const event of mapSdkMessage(message, this.name, session?.usage ?? []))
                    input.emit(event);
                if (message.type !== 'result') return;
                if (message.subtype !== 'success')
                    failure = message.errors.join('\n') || message.subtype;
                else if (message.is_error)
                    failure = message.result || 'Agent command reported an error';
                else output = message.result;
            });

            child.on('error', reject);
            child.on('close', (code) => {
                input.signal.removeEventListener('abort', abort);
                if (failure) return reject(new Error(failure));
                if (code !== 0 && !input.signal.aborted) {
                    return reject(new Error(`Agent command exited with ${code}: ${stderr.trim()}`));
                }
                resolve({ output });
            });

            child.stdin.end(
                earlier
                    ? `<conversation_so_far>\n${earlier}\n</conversation_so_far>\n\n${input.prompt}`
                    : input.prompt,
            );
        });
    }
}
