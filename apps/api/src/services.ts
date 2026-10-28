import { createConversationsService } from './agent/conversations.js';
import { createRunsService } from './agent/runs.js';
import { createUsageService } from './agent/usage.js';
import { createAutomationsService } from './automations/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { createCanvas } from './integrations/canvas.js';
import { createResend } from './integrations/resend.js';
import { createIntegrationsService } from './integrations/service.js';
import { createIntegrationStore } from './integrations/store.js';
import type { SecretBox } from './lib/crypto.js';
import type { Notifier } from './lib/notifier.js';
import { createMcpServersService } from './mcp-servers/service.js';
import { createMetricsService } from './metrics/service.js';
import { createNotificationsService } from './notifications/service.js';
import { createPagesService } from './pages/service.js';
import { createTodosService } from './todos/service.js';
import { createTools } from './tools/definitions.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';

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

    const pages = createPagesService(db, now);
    const todos = createTodosService(db, now);
    const runs = createRunsService({
        db,
        notifier,
        secrets,
        now,
        staleAfterMs: config.runStaleAfterMs,
        budgetUsd: config.runBudgetUsd,
    });
    const conversations = createConversationsService({ db, runs, now });
    const notifications = createNotificationsService(db, now);
    const usage = createUsageService(db);
    const metrics = createMetricsService({ db, now, config });

    const store = createIntegrationStore(db, secrets, now);
    const canvas = createCanvas({ store, fetch: deps.fetch });
    const resend = createResend({ config, fetch: deps.fetch });
    const integrations = createIntegrationsService({ store, resend });
    const mcpServers = createMcpServersService({ db, secrets, now });

    // Automation code calls the agent's tools, and the tools manage automations, so the registry
    // is reached lazily: automation code only runs after both exist.
    const automations = createAutomationsService({
        db,
        runs,
        notifications,
        resend,
        callTool: (name, input) => tools.call(name, input, { run: null, automation: true }),
        config,
        now,
    });

    const tools: ToolRegistry = createToolRegistry(
        createTools({
            pages,
            todos,
            automations,
            notifications,
            canvas,
            resend,
            limits: { budgetUsd: config.runBudgetUsd, timeoutMs: config.automationTimeoutMs },
        }),
        integrations.met,
    );

    return {
        ...deps,
        pages,
        todos,
        runs,
        conversations,
        automations,
        notifications,
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
