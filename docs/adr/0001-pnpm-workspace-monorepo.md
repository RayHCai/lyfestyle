# 0001. One pnpm workspace for every app and package

- Status: accepted
- Date: 2026-10-26

## Context

The API, runner, desktop app and their shared code change together: the run-event protocol in
`packages/shared` is a contract between all of them, and `@lyfestyle/client` is typed from the API's
own routes. Separate repos would turn every protocol change into a multi-repo release.

## Decision

One repository, one pnpm workspace (`apps/*`, `packages/*`), one lockfile. Internal packages are
consumed as TypeScript source through `workspace:*` and `exports` pointing at `src/`; nothing is
published. pnpm is the only package manager: `npm install` replaces pnpm's symlinked
`node_modules` and silently breaks workspace links. `minimumReleaseAge` holds new dependency
versions back three days as supply-chain protection.

## Consequences

- A protocol change and all its consumers land in one commit and one CI run.
- Root files (`package.json`, `pnpm-workspace.yaml`, the lockfile) are shared by everything, so only
  one `pnpm install` should run at a time.
- The desktop app builds with TypeScript 5.9 while the rest uses TypeScript 7, so it keeps its own
  thin API client instead of importing `@lyfestyle/client`.
