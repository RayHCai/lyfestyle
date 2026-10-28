import type { RunKind } from '@lyfestyle/shared';
import { z } from 'zod';
import { forbidden, invalid, notFound, unavailable } from '../lib/errors.js';

/** An integration a tool cannot work without; such tools are hidden until it is set up. */
export type Requirement = 'canvas' | 'resend';

/** Who is calling a tool. */
export interface ToolContext {
    /** The agent run whose scoped token made the call; null for the root token (the user). */
    run: { id: string; kind: RunKind } | null;
    /** Set when approved automation code calls through `ctx.tool`. */
    automation?: boolean;
}

/** Hono variables the auth middleware sets for every authenticated request. */
export interface CallerEnv {
    Variables: { caller: ToolContext };
}

/** Nobody reviews what happens: automation code, or the agent runs it starts. */
const unattended = (ctx: ToolContext) => ctx.automation === true || ctx.run?.kind === 'automation';

export interface Tool<S extends z.ZodObject = z.ZodObject> {
    name: string;
    description: string;
    input: S;
    readOnly?: boolean;
    destructive?: boolean;
    requires?: Requirement;
    /** Hidden from unattended callers, whose input may be untrusted content such as email. */
    attendedOnly?: boolean;
    run(input: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

export const defineTool = <S extends z.ZodObject>(tool: Tool<S>): Tool<S> => tool;

function inputSchema(schema: z.ZodObject): Record<string, unknown> {
    const { $schema: _, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    return json;
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;

export function createToolRegistry(tools: Tool[], met: () => Promise<Set<Requirement>>) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    return {
        /** The tools `ctx` may call right now. */
        async available(ctx: ToolContext): Promise<Tool[]> {
            const ready = await met();
            return tools.filter(
                (tool) =>
                    (!tool.requires || ready.has(tool.requires)) &&
                    !(tool.attendedOnly && unattended(ctx)),
            );
        },

        describe(tool: Tool) {
            return {
                name: tool.name,
                description: tool.description,
                inputSchema: inputSchema(tool.input),
                readOnly: tool.readOnly ?? false,
                destructive: tool.destructive ?? false,
                requires: tool.requires ?? null,
            };
        },

        async call(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
            const tool = byName.get(name);
            if (!tool) throw notFound(`Tool "${name}"`);
            if (tool.attendedOnly && unattended(ctx)) {
                throw forbidden(`"${name}" is not available to automations`);
            }
            if (tool.requires && !(await met()).has(tool.requires)) {
                throw unavailable(
                    `"${name}" needs the ${tool.requires} integration, which is not set up`,
                );
            }
            const parsed = tool.input.safeParse(args ?? {});
            if (!parsed.success) throw invalid(parsed.error);
            return tool.run(parsed.data, ctx);
        },
    };
}
