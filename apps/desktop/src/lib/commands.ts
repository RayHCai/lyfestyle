/**
 * Slash commands for the composer. Skills (`/name …`) are sent as typed and Claude Code expands
 * them; `/model` and `/effort` are handled here because they change how the app launches it.
 */
import { useData } from '../store/data';
import type { Skill } from './types';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = ['opus', 'sonnet', 'haiku'];

const appCommands: Skill[] = [
    { name: 'model', description: 'model for new turns: opus, sonnet, haiku or a full id' },
    { name: 'effort', description: 'effort for new turns: ' + EFFORTS.join(', ') },
];
const commandArgs: Record<string, string[]> = {
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
    const arg = /^\/(model|effort)\s+(\S*)$/.exec(value);
    if (arg) {
        const [, cmd = '', q = ''] = arg;
        return (commandArgs[cmd] ?? [])
            .filter((a) => a.startsWith(q.toLowerCase()))
            .map((a) => ({ label: a, description: '', insert: `/${cmd} ${a}` }));
    }
    return [];
}

/** Run `/model` or `/effort`. Returns the line to show under the composer, or null when the text
 *  is something else (a skill or a message), which goes to the agent. */
export async function runAppCommand(text: string): Promise<string | null> {
    const m = /^\/(model|effort)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) return null;
    const cmd = m[1] === 'model' ? 'model' : 'effort';
    const arg = (m[2] ?? '').trim();
    const { settings, mode, env, saveSettings } = useData.getState();
    if (mode === 'api') return `${cmd} is set by the runner while the API is configured`;
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
