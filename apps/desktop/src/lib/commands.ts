/**
 * Slash commands for the composer. Skills (`/name …`) are sent as typed and Claude Code expands
 * them; `/harness`, `/model` and `/effort` are handled here because they change how the app
 * launches the agent.
 */
import { useData } from '../store/data';
import { HARNESSES, activeHarness, harnessProblem, isHarnessId } from './harness';
import type { Skill } from './types';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = ['opus', 'sonnet', 'haiku'];

const appCommands: Skill[] = [
    {
        name: 'harness',
        description: 'agent for new turns: ' + HARNESSES.map((h) => h.id).join(', '),
    },
    { name: 'model', description: 'model for new turns: opus, sonnet, haiku or a full id' },
    { name: 'effort', description: 'effort for new turns: ' + EFFORTS.join(', ') },
];
const commandArgs: Record<string, string[]> = {
    harness: HARNESSES.map((h) => h.id),
    model: ['default', ...MODELS],
    effort: ['default', ...EFFORTS],
};

export interface SlashOption {
    label: string;
    description: string;
    /** What the field holds after picking this option. */
    insert: string;
}

/** Menu entries for what is typed so far: commands and skills while the name is being typed,
 *  then argument values after `/model ` or `/effort `. Anything else gets no menu. */
export function slashOptions(value: string, skills: Skill[]): SlashOption[] {
    const name = /^\/(\S*)$/.exec(value);
    if (name) {
        const q = (name[1] ?? '').toLowerCase();
        return [...appCommands, ...skills]
            .filter((c) => c.name.toLowerCase().startsWith(q))
            .map((c) => ({
                label: '/' + c.name,
                description: c.description,
                insert: `/${c.name} `,
            }));
    }
    const arg = /^\/(harness|model|effort)\s+(\S*)$/.exec(value);
    if (arg) {
        const [, cmd = '', q = ''] = arg;
        return (commandArgs[cmd] ?? [])
            .filter((a) => a.startsWith(q.toLowerCase()))
            .map((a) => ({ label: a, description: '', insert: `/${cmd} ${a}` }));
    }
    return [];
}

/** `/harness [id]`: shows or switches the harness new turns use. */
async function runHarness(arg: string): Promise<string> {
    const { settings, env, saveSettings } = useData.getState();
    if (env.harness) return 'harness is fixed by LYFESTYLE_AGENT_COMMAND';
    const current = activeHarness(settings);
    if (!arg) {
        const problem = harnessProblem(current, settings, env);
        return `harness: ${current}${problem ? ` (${problem})` : ''}`;
    }
    const id = arg.toLowerCase();
    if (!isHarnessId(id)) return `harness: one of ${HARNESSES.map((h) => h.id).join(', ')}`;
    const problem = harnessProblem(id, settings, env);
    if (problem) return `harness: ${id} is ${problem}; set it up in settings`;
    await saveSettings({ harness: id });
    return `harness → ${id}`;
}

/** Run `/harness`, `/model` or `/effort`. Returns the line to show under the composer, or null
 *  when the text is something else (a skill or a message), which goes to the agent. */
export async function runAppCommand(text: string): Promise<string | null> {
    const m = /^\/(harness|model|effort)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) return null;
    const arg = (m[2] ?? '').trim();
    if (m[1] === 'harness') return runHarness(arg);
    const cmd = m[1] === 'model' ? 'model' : 'effort';
    const { settings, env, saveSettings } = useData.getState();
    if (env.harness) return `${cmd} is not used with LYFESTYLE_AGENT_COMMAND`;
    if (!arg) return `${cmd}: ${settings[cmd] || 'claude code default'}`;
    const value = arg.toLowerCase() === 'default' ? '' : arg;
    if (/\s/.test(value) || (cmd === 'effort' && value && !EFFORTS.includes(value)))
        return cmd === 'effort'
            ? `effort: one of ${EFFORTS.join(', ')} or default`
            : 'model: one alias or model id, or default';
    await saveSettings({ [cmd]: value });
    return `${cmd} → ${value || 'claude code default'}`;
}
