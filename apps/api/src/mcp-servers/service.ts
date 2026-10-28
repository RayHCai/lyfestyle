import type { Db, McpTransport, Row } from '../db/client.js';
import type { SecretBox } from '../lib/crypto.js';
import { badRequest, conflict, notFound, onDuplicate } from '../lib/errors.js';
import type { Patch } from '../lib/types.js';

/** The API's own tool server; the runner adds it to every run under this name. */
export const BUILTIN_MCP_SERVER = 'lyfestyle';

interface McpServerInput {
    name: string;
    transport: McpTransport;
    /** May carry a secret in its path or query (e.g. a token), so it is stored encrypted. */
    url?: string | null | undefined;
    command?: string | null | undefined;
    /** May carry secrets too; stored encrypted. */
    args?: string[] | undefined;
    /** Sent with every request to an http or sse server; stored encrypted. */
    headers?: Record<string, string> | undefined;
    /** Environment for a stdio server's process; stored encrypted. */
    env?: Record<string, string> | undefined;
    enabled?: boolean | undefined;
}

/** The sealed `secret` column. Rows written before url and args moved in lack those two. */
interface McpSecret {
    url?: string | null;
    args?: string[];
    headers: Record<string, string>;
    env: Record<string, string>;
}

type Secrets = Required<McpSecret>;

type McpRow = Row<'mcpServer'>;

/** Scheme and host, plus "/…" when a path or query is hidden; never userinfo. */
function displayUrl(raw: string | null): string | null {
    if (!raw || !URL.canParse(raw)) return null;
    const url = new URL(raw);
    const hidden = url.pathname !== '/' || url.search !== '' || url.hash !== '';
    return `${url.protocol}//${url.host}${hidden ? '/…' : ''}`;
}

export function createMcpServersService(deps: { db: Db; secrets: SecretBox; now: () => Date }) {
    const { db, secrets, now } = deps;

    function check(server: Pick<McpServerInput, 'name' | 'transport' | 'url' | 'command'>) {
        if (server.name === BUILTIN_MCP_SERVER)
            throw badRequest(`"${BUILTIN_MCP_SERVER}" is reserved`);
        if (server.transport === 'stdio' ? !server.command : !server.url) {
            throw badRequest(
                server.transport === 'stdio'
                    ? 'A stdio server needs a command'
                    : `An ${server.transport} server needs a url`,
            );
        }
    }

    /** The url and args columns hold only what is safe to show; the real ones are sealed. */
    function columns(transport: McpTransport, value: Secrets) {
        return {
            url: transport === 'stdio' ? null : displayUrl(value.url),
            args: [],
            secret: secrets.seal(value),
        };
    }

    /**
     * The row's secrets, or null once they cannot be decrypted (ENCRYPTION_KEY changed). A row
     * from before url and args were sealed is moved to the sealed form on the way.
     */
    async function unseal(row: McpRow): Promise<Secrets | null> {
        let stored: McpSecret;
        try {
            stored = secrets.open<McpSecret>(row.secret);
        } catch {
            return null;
        }
        if (stored.url !== undefined && stored.args !== undefined) return stored as Secrets;
        const upgraded = { ...stored, url: row.url, args: row.args };
        // Conditional on the old blob, so a write that landed meanwhile is not overwritten.
        await db.mcpServer.updateMany({
            where: { id: row.id, secret: row.secret },
            data: columns(row.transport, upgraded),
        });
        return upgraded;
    }

    /** What the UI may show: header and variable names and an argument count, never values. */
    async function view(row: McpRow) {
        const value = await unseal(row);
        return {
            id: row.id,
            name: row.name,
            transport: row.transport,
            url: row.transport === 'stdio' ? null : displayUrl(row.url),
            command: row.command,
            argCount: value?.args.length ?? 0,
            headerNames: Object.keys(value?.headers ?? {}),
            envNames: Object.keys(value?.env ?? {}),
            enabled: row.enabled,
            /** The secrets were sealed with another ENCRYPTION_KEY: delete and re-add it. */
            secretsUnavailable: value === null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }

    async function find(id: string): Promise<McpRow> {
        const row = await db.mcpServer.findUnique({ where: { id } });
        if (!row) throw notFound('MCP server');
        return row;
    }

    const duplicate = (name: string) => onDuplicate(`An MCP server named "${name}" already exists`);

    return {
        async list() {
            const rows = await db.mcpServer.findMany({ orderBy: { name: 'asc' } });
            return Promise.all(rows.map(view));
        },

        async get(id: string) {
            return view(await find(id));
        },

        async create(input: McpServerInput) {
            check(input);
            const stdio = input.transport === 'stdio';
            const row = await db.mcpServer
                .create({
                    data: {
                        name: input.name,
                        transport: input.transport,
                        command: stdio ? (input.command ?? null) : null,
                        ...columns(input.transport, {
                            url: stdio ? null : (input.url ?? null),
                            args: stdio ? (input.args ?? []) : [],
                            headers: input.headers ?? {},
                            env: input.env ?? {},
                        }),
                        enabled: input.enabled ?? true,
                        createdAt: now(),
                        updatedAt: now(),
                    },
                })
                .catch(duplicate(input.name));
            return view(row);
        },

        /**
         * `headers`, `env` and `args`, when given, replace the stored ones wholesale. Switching
         * transport drops what the new one cannot use, as `create` does.
         */
        async update(id: string, patch: Patch<McpServerInput>) {
            const current = await find(id);
            const stored = await unseal(current);
            if (!stored) {
                throw conflict(
                    'Its secrets were sealed with another ENCRYPTION_KEY; delete and re-add it',
                );
            }
            const transport = patch.transport ?? current.transport;
            const stdio = transport === 'stdio';
            const next = {
                name: patch.name ?? current.name,
                transport,
                url: stdio ? null : patch.url === undefined ? stored.url : patch.url,
                command: !stdio
                    ? null
                    : patch.command === undefined
                      ? current.command
                      : patch.command,
            };
            check(next);
            const row = await db.mcpServer
                .update({
                    where: { id },
                    data: {
                        name: next.name,
                        transport,
                        command: next.command,
                        ...columns(transport, {
                            url: next.url,
                            args: stdio ? (patch.args ?? stored.args) : [],
                            headers: patch.headers ?? stored.headers,
                            env: patch.env ?? stored.env,
                        }),
                        enabled: patch.enabled ?? current.enabled,
                        updatedAt: now(),
                    },
                })
                .catch(duplicate(next.name));
            return view(row);
        },

        /** Works even when the secrets can no longer be decrypted, so such a row can go. */
        async remove(id: string) {
            const row = await find(id);
            const shown = await view(row);
            await db.mcpServer.delete({ where: { id } });
            return shown;
        },

        /** Enabled servers with their secrets, for a harness to connect to. */
        async forAgent() {
            const rows = await db.mcpServer.findMany({
                where: { enabled: true },
                orderBy: { name: 'asc' },
            });
            const servers = [];
            for (const row of rows) {
                const value = await unseal(row);
                if (!value) {
                    console.warn(
                        `MCP server "${row.name}" skipped: its secrets cannot be decrypted`,
                    );
                    continue;
                }
                servers.push(
                    row.transport === 'stdio'
                        ? {
                              name: row.name,
                              transport: row.transport,
                              command: row.command!,
                              args: value.args,
                              env: value.env,
                          }
                        : {
                              name: row.name,
                              transport: row.transport,
                              url: value.url!,
                              headers: value.headers,
                          },
                );
            }
            return servers;
        },
    };
}
