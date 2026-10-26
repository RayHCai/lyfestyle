#!/usr/bin/env node
// Stream-json entry point for the desktop app's LYFESTYLE_AGENT_COMMAND; stdout carries JSON lines only.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

register();
const { main } = await import('../src/bridge.ts');
process.exit(await main().catch((err) => (console.error(err?.message ?? err), 1)));
