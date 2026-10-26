@AGENTS.md

## Claude Code

- `.claude/hooks/format.mjs` formats a file with Prettier (or rustfmt) when registered as a
  `PostToolUse` hook for `Edit|Write`. You still run `pnpm check` before finishing.
- Several Claude Code sessions may work in this repo at once. Before running `pnpm install` or
  editing root config (`package.json`, `pnpm-workspace.yaml`, `.oxlintrc.json`, `lefthook.yml`,
  `.github/`), check for peer sessions and coordinate with them.
