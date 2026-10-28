#!/usr/bin/env node
// Stream-json entry point for the desktop app's LYFESTYLE_AGENT_COMMAND; stdout carries JSON lines only.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

register();
const { main } = await import('../src/bridge.ts');
// exitCode rather than exit(): exiting at once can cut off the last lines still in a stdout pipe.
process.exitCode = await main().catch((err) => (console.error(err?.message ?? err), 1));
// Once stdout has drained, an idle keep-alive socket must not hold the process open.
setTimeout(() => process.exit(), 2_000).unref();
