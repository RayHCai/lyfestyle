import { describe, expect, it } from 'vitest';
import type { AutomationLog } from '../src/db/client.js';
import { runInSandbox, SandboxError, type SandboxOptions } from '../src/automations/sandbox.js';

// The few variables libuv copies into every Windows child so it can start; none is a secret.
const WINDOWS_SYSTEM_ENV = [
    'HOMEDRIVE',
    'HOMEPATH',
    'LOGONSERVER',
    'PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
];

function sandbox(code: string, options: Partial<SandboxOptions> = {}) {
    const logs: { level: AutomationLog['level']; message: string }[] = [];
    const calls: { method: string; args: unknown[] }[] = [];
    const result = runInSandbox({
        code,
        automation: { id: 'auto-1', name: 'Test' },
        state: { seen: 1 },
        helpers: ['echo', 'fail', 'state.set'],
        host: {
            log: (level, message) => logs.push({ level, message }),
            async call(method, args) {
                calls.push({ method, args });
                if (method === 'fail') throw Object.assign(new Error('nope'), { code: 'teapot' });
                if (method === 'state.set') return args[0] ?? {};
                return { echoed: args };
            },
        },
        timeoutMs: 5000,
        signal: new AbortController().signal,
        ...options,
    });
    return { result, logs, calls };
}

const output = async (code: string) => JSON.parse((await sandbox(code).result).output!);

describe('sandbox', () => {
    it('runs the module with ctx built from the helper names', async () => {
        const { result, logs, calls } = sandbox(`
            export default async (ctx) => {
                console.log('hello', { a: 1 });
                const echoed = await ctx.echo(1, 'two');
                const failed = await ctx.fail().catch((e) => e.code + ': ' + e.message);
                await ctx.state.set({ seen: ctx.state.get().seen + 1 });
                const after = ctx.state.get();
                await ctx.state.set(null);
                return { echoed, failed, after, reset: ctx.state.get(), automation: ctx.automation };
            };
        `);
        expect(JSON.parse((await result).output!)).toEqual({
            echoed: { echoed: [1, 'two'] },
            failed: 'teapot: nope',
            after: { seen: 2 },
            reset: {},
            automation: { id: 'auto-1', name: 'Test' },
        });
        expect(logs).toEqual([{ level: 'info', message: 'hello {"a":1}' }]);
        expect(calls.map((c) => c.method)).toEqual(['echo', 'fail', 'state.set', 'state.set']);
    });

    it('takes code larger than a Windows command line', async () => {
        const padding = `// ${'x'.repeat(100_000)}\n`;
        const { result } = sandbox(`${padding}export default () => 'big'`);
        expect(await result).toEqual({ output: 'big' });
    });

    it('starts with none of the API’s environment', async () => {
        process.env.LYFESTYLE_SANDBOX_CANARY = 'secret';
        try {
            const env = await output(`export default () => process.env`);
            expect(env).not.toHaveProperty('LYFESTYLE_SANDBOX_CANARY');
            const allowed = process.platform === 'win32' ? WINDOWS_SYSTEM_ENV : [];
            expect(Object.keys(env).filter((key) => !allowed.includes(key))).toEqual([]);
        } finally {
            delete process.env.LYFESTYLE_SANDBOX_CANARY;
        }
    });

    it('cannot touch the file system, start processes or signal other processes', async () => {
        const denied = await output(`
            const attempt = async (fn) => { try { await fn(); return 'allowed'; } catch (e) { return e.code ?? e.message; } };
            export default async () => ({
                read: await attempt(async () => (await import('node:fs')).readFileSync(process.execPath)),
                list: await attempt(async () => (await import('node:fs')).readdirSync('.')),
                readAsync: await attempt(async () => (await import('node:fs/promises')).readFile(process.execPath)),
                write: await attempt(async () => (await import('node:fs')).writeFileSync('owned.txt', 'x')),
                spawn: await attempt(async () => (await import('node:child_process')).execFileSync(process.execPath, ['-v'])),
                worker: await attempt(async () => new (await import('node:worker_threads')).Worker('1', { eval: true })),
                kill: await attempt(() => process.kill(process.ppid, 0)),
                npm: await attempt(() => import('zod')),
                relative: await attempt(() => import('./service.js')),
            });
        `);
        expect(denied).toMatchObject({
            read: 'ERR_ACCESS_DENIED',
            list: 'ERR_ACCESS_DENIED',
            readAsync: 'ERR_ACCESS_DENIED',
            write: 'ERR_ACCESS_DENIED',
            spawn: 'ERR_ACCESS_DENIED',
            worker: 'ERR_ACCESS_DENIED',
            kill: 'process.kill is not available to automations',
        });
        expect(denied.npm).not.toBe('allowed');
        expect(denied.relative).not.toBe('allowed');
    });

    it('fails the run on a malformed message without throwing in the API', async () => {
        const { result, logs } = sandbox(`
            export default () => {
                process.send({ type: 'log', level: 'shout', message: 42 });
                return new Promise(() => {});
            };
        `);
        await expect(result).rejects.toThrow('The code sent the API an invalid message');
        expect(logs).toContainEqual({
            level: 'error',
            message: expect.stringContaining('"level":"shout"'),
        });
    });

    it('never resolves a helper the code was not given, such as constructor', async () => {
        const { result, calls } = sandbox(`
            export default () => {
                process.send({ type: 'call', id: 1, method: 'constructor', args: [] });
                return new Promise(() => {});
            };
        `);
        await expect(result).rejects.toThrow('invalid message');
        expect(calls).toEqual([]);
    });

    it('kills code that runs past its timeout, busy or not', async () => {
        const { result, logs } = sandbox(
            `export default () => { console.log(String(process.pid)); for (;;) {} }`,
            { timeoutMs: 1500 },
        );
        const error = await result.catch((err: unknown) => err);
        expect(error).toBeInstanceOf(SandboxError);
        expect(error).toMatchObject({ kind: 'timeout', message: 'Timed out after 2 s' });
        const pid = Number(logs[0]?.message);
        await expect.poll(() => isAlive(pid), { timeout: 3000 }).toBe(false);
    });

    it('stops on abort', async () => {
        const abort = new AbortController();
        const { result } = sandbox(`export default () => new Promise(() => {})`, {
            signal: abort.signal,
        });
        setTimeout(() => abort.abort('Deleted'), 300);
        await expect(result).rejects.toMatchObject({ kind: 'aborted', message: 'Deleted' });
    });

    it('reports a child that runs out of memory', async () => {
        const { result } = sandbox(
            `export default () => { const a = []; for (;;) a.push({ n: a.length, s: 'x' + a.length }); }`,
            { memoryMb: 32, timeoutMs: 20_000 },
        );
        await expect(result).rejects.toMatchObject({
            kind: 'failed',
            message: 'Ran out of memory (32 MB)',
        });
    });

    it('fails code without a default export, or that throws', async () => {
        await expect(sandbox(`export const x = 1`).result).rejects.toThrow(
            'must export a default function',
        );
        await expect(
            sandbox(`export default () => { throw new Error('boom') }`).result,
        ).rejects.toThrow('boom');
        await expect(sandbox(`export default () => process.exit(3)`).result).rejects.toThrow(
            'stopped before finishing (exit 3)',
        );
    });
});

function isAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
