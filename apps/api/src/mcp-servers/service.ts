import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mcpServers } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { Patch } from '../lib/types.js';

export type McpTransport = 'http' | 'sse' | 'stdio';

/** The API's own tool server; the runner adds it to every run under this name. */
export const BUILTIN_MCP_SERVER = 'lyfestyle';

export interface McpServerInput {
    name: string;
    transport: McpTransport;
    url?: string | null | undefined;
    command?: string | null | undefined;
    args?: string[] | undefined;
    /** Sent with every request to an http or sse server; stored encrypted. */
    headers?: Record<string, string> | undefined;
    /** Environment for a stdio server's process; stored encrypted. */
    env?: Record<string, string> | undefined;
    enabled?: boolean | undefined;
}

interface McpSecret {
    headers: Record<string, string>;
    env: Record<string, string>;
}

type Row = typeof mcpServers.$inferSelect;

export type McpServersService = ReturnType<typeof createMcpServersService>;

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

    /** What the UI may show: header and variable names, never their values. */
    function view(row: Row) {
        const secret = secrets.open<McpSecret>(row.secret);
        return {
            id: row.id,
            name: row.name,
            transport: row.transport,
            url: row.url,
            command: row.command,
            args: row.args,
            headerNames: Object.keys(secret.headers),
            envNames: Object.keys(secret.env),
            enabled: row.enabled,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }

    async function find(id: string): Promise<Row> {
        const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
        if (!row) throw notFound('MCP server');
        return row;
    }

    async function unique(name: string, id?: string) {
        const [clash] = await db
            .select({ id: mcpServers.id })
            .from(mcpServers)
            .where(eq(mcpServers.name, name));
        if (clash && clash.id !== id)
            throw conflict(`An MCP server named "${name}" already exists`);
    }

    return {
        async list() {
            const rows = await db.select().from(mcpServers).orderBy(asc(mcpServers.name));
            return rows.map(view);
        },

        async get(id: string) {
            return view(await find(id));
        },

        async create(input: McpServerInput) {
            check(input);
            await unique(input.name);
            const [row] = await db
                .insert(mcpServers)
                .values({
                    name: input.name,
                    transport: input.transport,
                    url: input.transport === 'stdio' ? null : (input.url ?? null),
                    command: input.transport === 'stdio' ? (input.command ?? null) : null,
                    args: input.args ?? [],
                    secret: secrets.seal({ headers: input.headers ?? {}, env: input.env ?? {} }),
                    enabled: input.enabled ?? true,
                    createdAt: now(),
                    updatedAt: now(),
                })
                .returning();
            return view(row!);
        },

        /** `headers` and `env`, when given, replace the stored ones wholesale. */
        async update(id: string, patch: Patch<McpServerInput>) {
            const current = await find(id);
            const stored = secrets.open<McpSecret>(current.secret);
            const next = {
                name: patch.name ?? current.name,
                transport: patch.transport ?? current.transport,
                url: patch.url === undefined ? current.url : patch.url,
                command: patch.command === undefined ? current.command : patch.command,
            };
            check(next);
            await unique(next.name, id);
            const [row] = await db
                .update(mcpServers)
                .set({
                    ...next,
                    args: patch.args ?? current.args,
                    enabled: patch.enabled ?? current.enabled,
                    secret: secrets.seal({
                        headers: patch.headers ?? stored.headers,
                        env: patch.env ?? stored.env,
                    }),
                    updatedAt: now(),
                })
                .where(eq(mcpServers.id, id))
                .returning();
            return view(row!);
        },

        async remove(id: string) {
            const row = await find(id);
            await db.delete(mcpServers).where(eq(mcpServers.id, id));
            return view(row);
        },

        /** Enabled servers with their secrets, for a harness to connect to. */
        async forAgent() {
            const rows = await db
                .select()
                .from(mcpServers)
                .where(eq(mcpServers.enabled, true))
                .orderBy(asc(mcpServers.name));
            return rows.map((row) => {
                const secret = secrets.open<McpSecret>(row.secret);
                return row.transport === 'stdio'
                    ? {
                          name: row.name,
                          transport: row.transport,
                          command: row.command!,
                          args: row.args,
                          env: secret.env,
                      }
                    : {
                          name: row.name,
                          transport: row.transport,
                          url: row.url!,
                          headers: secret.headers,
                      };
            });
        },
    };
}
