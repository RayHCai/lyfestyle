import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { mapSdkMessage } from './claude-code.js';
import {
    agentEnv,
    budgetFor,
    mcpConfig,
    promptFor,
    resultOutcome,
    type Harness,
    type HarnessInput,
    type HarnessResult,
} from './harness.js';

/** A session id a command may be handed back; anything else could smuggle in arguments. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/** How long a POSIX command gets to exit after SIGTERM before its process group is killed. */
const KILL_GRACE_MS = 5_000;

/** Splits a command line on whitespace, keeping quoted runs together. */
export function splitCommand(line: string): string[] {
    const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return parts.map((part) => part.replace(/^(["'])(.*)\1$/, '$2'));
}

/**
 * One argument on a cmd.exe command line. Every argument that is not a plain word is quoted, which
 * keeps `&|<>()^` literal both for cmd.exe and for the batch file that passes it on; `%`, `"` and
 * line breaks are refused because no quoting stops cmd.exe acting on them.
 */
export function cmdArg(arg: string): string {
    if (/[%"\r\n\0]/.test(arg)) {
        throw new Error(
            `Cannot pass ${JSON.stringify(arg)} to a .cmd or .bat agent command: it contains %, " or a line break`,
        );
    }
    // Trailing backslashes are doubled so the program does not read `\"` as an escaped quote.
    return /^[\w\-.:\\/@+]+$/.test(arg) ? arg : `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

const isFile = (path: string) => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

/**
 * The file Windows would run for `bin`: as given when it is a path, else the first PATH entry
 * holding it with one of the PATHEXT extensions. The current directory is not searched.
 */
function resolveWindowsCommand(bin: string): string {
    const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const named = extensions.some((ext) => bin.toLowerCase().endsWith(ext.toLowerCase()));
    const names = named ? [bin] : extensions.map((ext) => bin + ext);
    const dirs = /[\\/]/.test(bin)
        ? ['']
        : (process.env.PATH ?? '')
              .split(';')
              .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
              .filter(Boolean);
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = dir ? join(dir, name) : resolve(name);
            if (isFile(candidate)) return candidate;
        }
    }
    return bin;
}

/**
 * Starts the agent command without a shell, so its arguments arrive exactly as given. Windows can
 * only start a `.cmd` or `.bat` through cmd.exe, so those run as `cmd.exe /d /s /c` with every
 * argument escaped by `cmdArg`. On POSIX the command leads its own process group, so stopping it
 * can stop everything it started.
 */
function spawnCommand(bin: string, args: string[], env: Record<string, string>): ChildProcess {
    const options: SpawnOptions = { env, stdio: ['pipe', 'pipe', 'pipe'] };
    if (process.platform !== 'win32') return spawn(bin, args, { ...options, detached: true });
    const file = resolveWindowsCommand(bin);
    if (!/\.(cmd|bat)$/i.test(file)) return spawn(file, args, { ...options, windowsHide: true });
    const line = [file, ...args].map(cmdArg).join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/v:off', '/c', `"${line}"`], {
        ...options,
        windowsHide: true,
        windowsVerbatimArguments: true,
    });
}

/** Stops the command and everything it started; on Windows cmd.exe's child outlives cmd.exe. */
function killTree(child: ChildProcess) {
    const { pid } = child;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
            .on('error', () => child.kill())
            .unref();
        return;
    }
    const signalGroup = (signal: NodeJS.Signals) => {
        try {
            process.kill(-pid, signal);
        } catch {
            child.kill(signal);
        }
    };
    signalGroup('SIGTERM');
    setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
    }, KILL_GRACE_MS).unref();
}

export interface CommandOptions {
    /** The runner's turn cap, passed on as LYFESTYLE_MAX_TURNS. */
    maxTurns?: number | undefined;
    /** The runner's own spend cap; the run's budget applies when it is lower. */
    maxBudgetUsd?: number | undefined;
}

/**
 * Any executable that reads a prompt on stdin, takes `--session <id>` to continue a session, and
 * prints Claude Code's stream-json lines: the same contract the desktop app uses for
 * LYFESTYLE_AGENT_COMMAND, so one custom agent plugs into both. Its tools arrive the same way in
 * both too: `LYFESTYLE_MCP_CONFIG` names a file in Claude Code's `--mcp-config` format. It must
 * honour LYFESTYLE_MAX_BUDGET_USD and LYFESTYLE_MAX_TURNS itself: the API learns what a command
 * spent only from its final result line, too late to stop it.
 */
export class CommandHarness implements Harness {
    readonly name = 'command';

    constructor(
        private readonly command: string,
        private readonly options: CommandOptions = {},
    ) {}

    async run(input: HarnessInput): Promise<HarnessResult> {
        // An abort that landed before this point has no listener to reach.
        if (input.signal.aborted) throw new Error('Run stopped before the agent command started');
        // The file holds the run's agent token, so it is private to this run and removed after it.
        const dir = await mkdtemp(join(tmpdir(), 'lyfestyle-mcp-'));
        const config = join(dir, 'mcp.json');
        await writeFile(config, JSON.stringify({ mcpServers: mcpConfig(input.mcpServers) }), {
            mode: 0o600,
        });
        try {
            return await this.#spawn(input, config);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    #spawn(input: HarnessInput, mcpConfigFile: string): Promise<HarnessResult> {
        const [bin, ...args] = splitCommand(this.command);
        if (!bin) return Promise.reject(new Error('AGENT_HARNESS_COMMAND is empty'));
        let session = input.session?.harness === this.name ? input.session : null;
        if (session && !SESSION_ID.test(session.sessionId)) {
            input.emit({
                type: 'log',
                level: 'warn',
                message: `Not resuming session ${JSON.stringify(session.sessionId.slice(0, 100))}: not a plain id. Starting a new one with the conversation so far.`,
            });
            session = null;
        }
        if (session) args.push('--session', session.sessionId);
        const env = agentEnv({
            LYFESTYLE_MCP_CONFIG: mcpConfigFile,
            LYFESTYLE_MAX_BUDGET_USD: String(budgetFor(input, this.options.maxBudgetUsd)),
            ...(this.options.maxTurns
                ? { LYFESTYLE_MAX_TURNS: String(this.options.maxTurns) }
                : {}),
        });
        const baseline = session?.usage ?? [];
        const prompt = promptFor(input, { resumed: session !== null, withSoul: true });

        return new Promise((resolve, reject) => {
            let child: ChildProcess;
            try {
                child = spawnCommand(bin, args, env);
            } catch (err) {
                return reject(err);
            }
            const stop = () => killTree(child);
            input.signal.addEventListener('abort', stop, { once: true });

            let output: string | null = null;
            let failure: string | null = null;
            let stdinError: Error | null = null;
            let stderr = '';
            child.stderr!.on('data', (chunk: Buffer) => {
                stderr = (stderr + chunk.toString()).slice(-4000);
            });
            // A command that exits without reading its whole prompt breaks the pipe.
            child.stdin!.on('error', (err) => {
                stdinError = err;
            });

            createInterface({ input: child.stdout! }).on('line', (line) => {
                // A throw here would be uncaught and take the runner down, so nothing may escape.
                try {
                    this.#line(line, input, baseline, (outcome) => {
                        // The last result line is the turn's outcome.
                        failure = 'error' in outcome ? outcome.error : null;
                        output = 'output' in outcome ? outcome.output : null;
                    });
                } catch (err) {
                    input.emit({
                        type: 'log',
                        level: 'warn',
                        message: `Ignored an agent output line: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }
            });

            child.on('error', (err) => {
                input.signal.removeEventListener('abort', stop);
                reject(new Error(`Could not run the agent command: ${err.message}`));
            });
            child.on('close', (code, signal) => {
                input.signal.removeEventListener('abort', stop);
                // Unread prompt still queued for a pipe nobody reads any more.
                const unread = stdinError !== null || !child.stdin!.writableFinished;
                child.stdin!.destroy();
                if (failure !== null) return reject(new Error(failure));
                // A result line means the turn finished, even if a stop request raced it.
                if (output !== null) return resolve({ output });
                if (input.signal.aborted) return reject(new Error('Agent command stopped'));
                if (code !== 0) {
                    return reject(
                        new Error(`Agent command exited with ${code ?? signal}: ${stderr.trim()}`),
                    );
                }
                if (unread)
                    return reject(new Error('Agent command exited without reading its prompt'));
                resolve({ output: null });
            });

            child.stdin!.end(prompt);
        });
    }

    #line(
        line: string,
        input: HarnessInput,
        baseline: NonNullable<HarnessInput['session']>['usage'],
        onResult: (outcome: { output: string } | { error: string }) => void,
    ) {
        if (!line.trim()) return;
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            // Not stream-json: a plain-text agent's reply, shown as it is.
            input.emit({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: line }],
            });
            return;
        }
        for (const event of mapSdkMessage(message, this.name, baseline)) input.emit(event);
        const outcome = resultOutcome(message);
        if (outcome) onResult(outcome);
    }
}
