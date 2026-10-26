import { createConversationsService } from './agent/conversations.js';
import { createJobsService } from './agent/jobs.js';
import { createRunsService } from './agent/runs.js';
import { createUsageService } from './agent/usage.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { createCanvas } from './integrations/canvas.js';
import { createResend } from './integrations/resend.js';
import { createIntegrationStore } from './integrations/store.js';
import type { SecretBox } from './lib/crypto.js';
import type { Notifier } from './lib/notifier.js';
import { createMcpServersService } from './mcp-servers/service.js';
import { createMetricsService } from './metrics/service.js';
import { createPagesService } from './pages/service.js';
import { createTodosService } from './todos/service.js';
import { createTools } from './tools/definitions.js';
import { createToolRegistry, type Requirement } from './tools/registry.js';

export interface Deps {
    db: Db;
    config: Config;
    notifier: Notifier;
    secrets: SecretBox;
    /** Outbound HTTP to Canvas and Resend; swapped out in tests. */
    fetch: typeof fetch;
    now: () => Date;
}

export function createServices(deps: Deps) {
    const { db, config, notifier, secrets, now } = deps;

    const pages = createPagesService(db);
    const todos = createTodosService(db, now);
    const runs = createRunsService({ db, notifier, now, staleAfterMs: config.runStaleAfterMs });
    const conversations = createConversationsService({ db, runs, now });
    const jobs = createJobsService({ db, runs, now });
    const usage = createUsageService(db);
    const metrics = createMetricsService(db, now);

    const integrations = createIntegrationStore(db, secrets, now);
    const canvas = createCanvas({ store: integrations, fetch: deps.fetch });
    const resend = createResend({ config, fetch: deps.fetch });
    const mcpServers = createMcpServersService({ db, secrets, now });

    const tools = createToolRegistry(
        createTools({ pages, todos, jobs, canvas, resend }),
        async () => {
            const connected = await integrations.connected();
            const met = new Set<Requirement>();
            if (connected.has('canvas')) met.add('canvas');
            if (resend.configured) met.add('resend');
            return met;
        },
    );

    return {
        ...deps,
        pages,
        todos,
        runs,
        conversations,
        jobs,
        usage,
        metrics,
        integrations,
        canvas,
        resend,
        mcpServers,
        tools,
    };
}

export type Services = ReturnType<typeof createServices>;
