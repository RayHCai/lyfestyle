import { HELPERS, type GuideLimits } from './helpers.js';

/** How to write an automation, as the agent reads it in the automations_deploy tool. */
export const automationGuide = (
    limits: GuideLimits,
) => `Propose code for the Lyfestyle server to run on a cron schedule. Nothing is deployed until the user approves it: the chat shows them the code with approve and reject buttons right under your message (the Automations page lists it too). After proposing, end your turn with a short plain-language summary of what it does and when it runs; do not ask them to approve in words. Pass automationId to propose a new version of an existing automation (its state and history are kept; a newer proposal replaces one still waiting); every code, schedule or name change goes through this tool.

The schedule is cron with five fields (minute hour day month weekday), six with seconds first, or a nickname such as @daily, in an IANA time zone. It must have a next run: "0 0 30 2 *" is refused.

The code is one ES module (plain JavaScript, Node 22) whose default export receives ctx:

export default async (ctx) => {
  const board = await ctx.tool('todos_get_board', { today: '2026-01-31' });
  const summary = await ctx.agent('Summarise this for a morning email: ' + JSON.stringify(board));
  await ctx.email({ subject: 'Morning briefing', text: summary });
  await ctx.notify({ title: 'Briefing sent' });
  return 'sent';
};

ctx:
${HELPERS.map((h) => `- ${h.doc(limits)}`).join('\n')}
- ctx.log(...), ctx.warn(...), ctx.error(...) (console.* too): kept with the run for debugging.
- ctx.automation: { id, name, version, timezone, runId, trigger: 'schedule' | 'manual', startedAt }.

The code runs in its own Node process with no environment variables and no secrets. It can use fetch and the network, timers, and node: built-ins that do not touch the disk or other processes (node:crypto, node:url, node:buffer, ...). It cannot read or write files (node:fs throws ERR_ACCESS_DENIED), start processes or worker threads, load native addons, import npm packages or relative paths, or signal other processes. ctx is its only way to Lyfestyle's data. Memory is capped at 256 MB.

The return value (a string, or JSON) is stored as the run's output. A thrown error fails the run and notifies the user. A run is stopped after ${Math.round(limits.timeoutMs / 60_000)} minutes. Read automations_get to see recent runs, their logs and errors.`;
