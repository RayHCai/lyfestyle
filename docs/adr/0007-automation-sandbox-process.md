# 0007. Run automation code in a child process under Node's permission model

- Status: accepted (supersedes the worker-thread part of [0006](0006-automations-as-approved-code.md))
- Date: 2026-10-28

## Context

[ADR 0006](0006-automations-as-approved-code.md) ran approved automation code in a `worker_threads`
worker inside the API process and accepted that the worker was not a boundary. In practice that
meant more than "runs with the API's privileges":

- The worker inherited the API's `process.env`: `API_TOKEN`, `ENCRYPTION_KEY`, `DATABASE_URL`,
  `RESEND_API_KEY`. Any approved version could read them and send them anywhere.
- It shared the API's pid and memory. `resourceLimits` caps the JavaScript heap only, so Buffers
  and ArrayBuffers could exhaust the API's memory, and the worker could read and write the API's
  files and spawn processes that outlived `terminate()`.
- Messages from the worker were trusted. A malformed one threw inside the API's `message` listener,
  an uncaught exception that took the whole API down.

Approval stays the main control (the user reads every version), but code that is approved can still
be wrong, and the agent writes it from content such as email. The blast radius of a mistake should
be the automation run, not the API and its secrets.

## Decision

Each automation run executes in its own child Node process (`apps/api/src/automations/sandbox.ts`):

- `spawn(process.execPath, ['--permission', '--max-old-space-size=<MB>', '--input-type=module',
'-e', BOOTSTRAP])` with `env: {}` and `stdio: ['ignore', 'pipe', 'pipe', 'ipc']`. The bootstrap is
  a string in the bundle, so the esbuild output stays one file with nothing beside it.
- `--permission` with no `--allow-*` flags denies the file system, `child_process`,
  `worker_threads`, native addons, WASI and the inspector. The bootstrap also replaces
  `process.kill`, which the permission model does not cover.
- The code, `ctx.automation`, the state and the names of the `ctx` helpers arrive over IPC after the
  spawn (Windows caps a command line at about 32 KB). The automation module is imported from a
  `data:` URL, so it cannot import npm packages or relative paths.
- Every message from the child is validated with zod (type, ids, log level, helper name from the
  list it was given, argument count). An invalid one is logged and fails the run; the listener never
  throws. Helpers are looked up in a `Map`, so a name such as `constructor` resolves to nothing.
- The API kills the child (`SIGKILL`) on timeout, abort or completion, settles the run exactly once,
  and keeps stdout and stderr in the run's logs. An out-of-memory exit is reported as such.
- The helpers are one manifest (`helpers.ts`: name, argument schema, guide line, implementation)
  that the host dispatch, the child's `ctx` and the agent's guide are all built from.

## Consequences

- What the child holds: the code, its state, and `ctx`. It never sees the API's environment or
  secrets, its database connection, or its files. A crash, an infinite loop, an allocation spike or
  `process.exit` ends the child and fails (or times out) the run; the API carries on.
- What it does not protect: the network stays open (fetch, `node:net`), so code can reach anything
  the API host can, including the internet and private services that need no credentials. CPU is
  bounded only by `AUTOMATION_TIMEOUT_MS`. The child runs as the API's OS user (`node` in the
  image), so whatever the permission model leaves out, such as `os.setPriority` on another process,
  is still possible. Memory outside the V8 heap is bounded by the host, not by `--max-old-space-size`;
  only the child dies when it runs out. This is still not a sandbox for untrusted code: approval
  remains the boundary that ADR 0006 describes.
- Each run starts a Node process instead of a thread: a little slower to start and heavier, which
  is negligible next to runs that last seconds to minutes and happen a few times a day.
- A new helper is one entry in `HELPERS`; its result must survive JSON, since it crosses IPC.
- Depends on the permission model being stable in the Node the API runs on (22.13 and later; the
  image uses `node:22-slim` and `engines` requires 22.18).
- Revisit if automations need packages or files (grant narrow `--allow-fs-read` paths, or move to a
  container), if the network must be closed (a container or an egress proxy; Node has no network
  permission in 22), or if the app gains other users.
