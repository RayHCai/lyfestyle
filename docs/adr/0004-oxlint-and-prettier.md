# 0004. oxlint for linting, Prettier for formatting

- Status: accepted
- Date: 2026-10-26

## Context

Most packages compile with TypeScript 7, the native compiler. ESLint's TypeScript integration
depends on the JavaScript compiler API, which TypeScript 7 does not provide the same way, and a
full ESLint setup is slow on every commit.

## Decision

[oxlint](https://oxc.rs) lints the whole repo from one `.oxlintrc.json`. It needs no TypeScript
program, runs in well under a second, and ships the typescript, import, react, jsx-a11y, vitest,
promise and node rule sets natively. Correctness and suspicious rules are errors; rules that only
encode style preferences are off. A deliberate exception is marked inline with
`// oxlint-disable-next-line <rule> -- <reason>`. Prettier formats everything (4 spaces, single
quotes, 100 columns; YAML at 2 spaces); `rustfmt` formats the Tauri crate and `clippy -D warnings`
lints it.

## Consequences

- No type-aware lint rules (such as floating-promise detection) for now. `tsc` strict mode with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` covers much of that ground.
- Revisit when oxlint's type-aware mode or typescript-eslint supports TypeScript 7.
