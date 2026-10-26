import type { ContentBlock, MessageRole, RunKind, RunStatus } from '@lyfestyle/shared';
import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    customType,
    date,
    doublePrecision,
    index,
    integer,
    jsonb,
    pgSequence,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Every page write takes the next value, so sync clients can pull "everything after N". */
export const pageSeq = pgSequence('page_seq');

export const pages = pgTable(
    'pages',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        title: text('title').notNull().default(''),
        content: text('content').notNull().default(''),
        icon: text('icon'),
        version: integer('version').notNull().default(1),
        seq: bigint('seq', { mode: 'number' })
            .notNull()
            .default(sql`nextval('page_seq')`),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        search: tsvector('search').generatedAlwaysAs(
            sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')`,
        ),
    },
    (t) => [
        uniqueIndex('pages_seq_idx').on(t.seq),
        index('pages_updated_idx').on(t.updatedAt, t.id),
        index('pages_search_idx').using('gin', t.search),
    ],
);

/** Targets carry no foreign key: a link may point at a page another device has not synced yet. */
export const pageLinks = pgTable(
    'page_links',
    {
        sourceId: uuid('source_id')
            .notNull()
            .references(() => pages.id, { onDelete: 'cascade' }),
        targetId: uuid('target_id').notNull(),
    },
    (t) => [
        primaryKey({ columns: [t.sourceId, t.targetId] }),
        index('page_links_target_idx').on(t.targetId),
    ],
);

export const goals = pgTable(
    'goals',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        title: text('title').notNull(),
        notes: text('notes'),
        month: date('month', { mode: 'string' }).notNull(),
        color: text('color').notNull().default('#6366f1'),
        position: doublePrecision('position').notNull().default(0),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [index('goals_month_idx').on(t.month)],
);

export const todos = pgTable(
    'todos',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        title: text('title').notNull(),
        notes: text('notes'),
        scope: text('scope', { enum: ['day', 'week'] }).notNull(),
        date: date('date', { mode: 'string' }).notNull(),
        goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
        position: doublePrecision('position').notNull().default(0),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [index('todos_scope_date_idx').on(t.scope, t.date)],
);

export const conversations = pgTable(
    'conversations',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        title: text('title'),
        harness: text('harness'),
        harnessSessionId: text('harness_session_id'),
        createdAt: createdAt(),
        updatedAt: updatedAt(),
    },
    (t) => [index('conversations_updated_idx').on(t.updatedAt, t.id)],
);

export const jobs = pgTable('jobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    schedule: text('schedule').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

export const runs = pgTable(
    'runs',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        kind: text('kind').$type<RunKind>().notNull(),
        status: text('status').$type<RunStatus>().notNull().default('queued'),
        prompt: text('prompt').notNull(),
        conversationId: uuid('conversation_id').references(() => conversations.id, {
            onDelete: 'cascade',
        }),
        jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
        runnerId: text('runner_id'),
        harness: text('harness'),
        output: text('output'),
        error: text('error'),
        cancelRequested: boolean('cancel_requested').notNull().default(false),
        createdAt: createdAt(),
        startedAt: timestamp('started_at', { withTimezone: true }),
        heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
        finishedAt: timestamp('finished_at', { withTimezone: true }),
    },
    (t) => [
        index('runs_status_idx').on(t.status, t.createdAt),
        index('runs_created_idx').on(t.createdAt, t.id),
        index('runs_job_idx').on(t.jobId),
        index('runs_conversation_idx').on(t.conversationId),
    ],
);

export const messages = pgTable(
    'messages',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        ordinal: bigint('ordinal', { mode: 'number' }).generatedAlwaysAsIdentity(),
        conversationId: uuid('conversation_id')
            .notNull()
            .references(() => conversations.id, { onDelete: 'cascade' }),
        runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
        role: text('role').$type<MessageRole>().notNull(),
        content: jsonb('content').$type<ContentBlock[]>().notNull(),
        createdAt: createdAt(),
    },
    (t) => [index('messages_conversation_idx').on(t.conversationId, t.ordinal)],
);

export const runEvents = pgTable(
    'run_events',
    {
        id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
        runId: uuid('run_id')
            .notNull()
            .references(() => runs.id, { onDelete: 'cascade' }),
        type: text('type').notNull(),
        data: jsonb('data').$type<Record<string, unknown>>().notNull(),
        createdAt: createdAt(),
    },
    (t) => [index('run_events_run_idx').on(t.runId, t.id)],
);

/** Kind, conversation and job are copied from the run so usage outlives the runs it came from. */
export const usageRecords = pgTable(
    'usage_records',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
        kind: text('kind').$type<RunKind>().notNull(),
        conversationId: uuid('conversation_id'),
        jobId: uuid('job_id'),
        harness: text('harness').notNull(),
        sessionId: text('session_id'),
        model: text('model').notNull(),
        inputTokens: integer('input_tokens').notNull(),
        outputTokens: integer('output_tokens').notNull(),
        cacheReadTokens: integer('cache_read_tokens').notNull(),
        cacheWriteTokens: integer('cache_write_tokens').notNull(),
        costUsd: doublePrecision('cost_usd').notNull(),
        durationMs: integer('duration_ms'),
        createdAt: createdAt(),
    },
    (t) => [
        index('usage_created_idx').on(t.createdAt),
        index('usage_run_idx').on(t.runId),
        index('usage_session_idx').on(t.sessionId),
    ],
);

export const integrations = pgTable('integrations', {
    provider: text('provider', { enum: ['canvas'] }).primaryKey(),
    account: text('account'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secret: text('secret').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});

/** A page view reported by any website through the public collect endpoint. */
export const pageViews = pgTable(
    'page_views',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        origin: text('origin').notNull(),
        path: text('path').notNull(),
        url: text('url').notNull(),
        title: text('title'),
        referrer: text('referrer'),
        ip: text('ip'),
        userAgent: text('user_agent'),
        language: text('language'),
        props: jsonb('props').$type<Record<string, unknown>>().notNull().default({}),
        createdAt: createdAt(),
    },
    (t) => [
        index('page_views_created_idx').on(t.createdAt, t.id),
        index('page_views_origin_idx').on(t.origin, t.createdAt),
    ],
);

export const mcpServers = pgTable('mcp_servers', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    transport: text('transport', { enum: ['http', 'sse', 'stdio'] }).notNull(),
    url: text('url'),
    command: text('command'),
    args: jsonb('args').$type<string[]>().notNull().default([]),
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
});
