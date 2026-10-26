import { z } from 'zod';
import { invalid, notFound, unavailable } from '../lib/errors.js';

/** An integration a tool cannot work without; such tools are hidden until it is set up. */
export type Requirement = 'canvas' | 'resend';

export interface Tool<S extends z.ZodObject = z.ZodObject> {
    name: string;
    description: string;
    input: S;
    readOnly?: boolean;
    destructive?: boolean;
    requires?: Requirement;
    run(input: z.output<S>): Promise<unknown>;
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
        async available(): Promise<Tool[]> {
            const ready = await met();
            return tools.filter((tool) => !tool.requires || ready.has(tool.requires));
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

        async call(name: string, args: unknown): Promise<unknown> {
            const tool = byName.get(name);
            if (!tool) throw notFound(`Tool "${name}"`);
            if (tool.requires && !(await met()).has(tool.requires)) {
                throw unavailable(
                    `"${name}" needs the ${tool.requires} integration, which is not set up`,
                );
            }
            const parsed = tool.input.safeParse(args ?? {});
            if (!parsed.success) throw invalid(parsed.error);
            return tool.run(parsed.data);
        },
    };
}
