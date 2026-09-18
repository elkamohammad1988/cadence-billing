import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { auditActorType, stripeEventStatus } from './enums'
import { profiles, workspaces } from './tenancy'

/**
 * Idempotency ledger and audit trail for webhook deliveries.
 *
 * The unique constraint on `stripeEventId` is the idempotency mechanism: the
 * handler inserts the row before doing any work, and a unique violation is the
 * duplicate-delivery signal. Nothing else about the design depends on Stripe
 * delivering exactly once, because Stripe does not.
 */
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stripe's own event id (`evt_…`). */
    stripeEventId: text('stripe_event_id').notNull().unique(),
    type: text('type').notNull(),
    apiVersion: text('api_version'),
    /** Full payload, so replay does not need to call Stripe. */
    payload: jsonb('payload').notNull(),
    status: stripeEventStatus('status').notNull().default('received'),
    /** Null when the event names a customer we have never seen. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    stripeCustomerId: text('stripe_customer_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    errorDetail: jsonb('error_detail'),
    durationMs: integer('duration_ms'),
    /** `created` from the Stripe event. Used for ordering, not for latency. */
    eventCreatedAt: timestamp('event_created_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    replayCount: integer('replay_count').notNull().default(0),
    lastReplayedAt: timestamp('last_replayed_at', { withTimezone: true }),
    lastReplayedBy: uuid('last_replayed_by').references(() => profiles.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('stripe_events_status_idx').on(table.status, table.eventCreatedAt),
    index('stripe_events_type_idx').on(table.type, table.eventCreatedAt),
    index('stripe_events_workspace_idx').on(table.workspaceId, table.eventCreatedAt),
  ],
)

/**
 * Per-attempt history. `stripeEvents` holds current state; this holds how it
 * got there, which is what you need when debugging a replay that behaved
 * differently from the original delivery.
 */
export const stripeEventAttempts = pgTable(
  'stripe_event_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => stripeEvents.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    status: stripeEventStatus('status').notNull(),
    error: text('error'),
    errorDetail: jsonb('error_detail'),
    durationMs: integer('duration_ms'),
    /** Null for the original delivery, set for an admin-initiated replay. */
    triggeredBy: uuid('triggered_by').references(() => profiles.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    unique('stripe_event_attempts_event_id_attempt_number_key').on(
      table.eventId,
      table.attemptNumber,
    ),
  ],
)

/**
 * Single-row configuration. These live in the database rather than in env so
 * that changing the grace period is an admin action, not a deploy.
 */
export const billingConfig = pgTable('billing_config', {
  id: boolean('id').primaryKey().default(true),
  gracePeriodDays: integer('grace_period_days').notNull().default(7),
  trialReminderDays: integer('trial_reminder_days').notNull().default(3),
  /** Downgrade policy when the target plan's project limit is exceeded. */
  downgradeArchivesExcess: boolean('downgrade_archives_excess').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Append-only; a database trigger rejects UPDATE and DELETE. Every privileged
 * mutation writes here: manual plan grants, webhook replays, forced
 * downgrades, reconciliation repairs.
 *
 * `actorId` and `workspaceId` carry no foreign key on purpose. An audit entry
 * has to outlive its subject — "who deleted this workspace" is a question you
 * ask after the workspace is gone. And mechanically an FK cannot work here at
 * all: `on delete set null` is an UPDATE and `on delete cascade` is a DELETE,
 * and the append-only trigger rejects both, so either one would make deleting
 * a workspace fail. Joins against these columns must tolerate a missing row.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    /** Captured at write time; the actor may later be deleted. */
    actorEmail: text('actor_email'),
    workspaceId: uuid('workspace_id'),
    /** Dotted verb, e.g. 'billing.plan_granted', 'webhook.replayed'. */
    action: text('action').notNull(),
    reason: text('reason'),
    targetTable: text('target_table'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_workspace_idx').on(table.workspaceId, table.createdAt),
    index('audit_log_action_idx').on(table.action, table.createdAt),
  ],
)

export const stripeEventsRelations = relations(stripeEvents, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [stripeEvents.workspaceId], references: [workspaces.id] }),
  attempts: many(stripeEventAttempts),
}))

export const stripeEventAttemptsRelations = relations(stripeEventAttempts, ({ one }) => ({
  event: one(stripeEvents, {
    fields: [stripeEventAttempts.eventId],
    references: [stripeEvents.id],
  }),
}))

export type StripeEvent = typeof stripeEvents.$inferSelect
export type StripeEventAttempt = typeof stripeEventAttempts.$inferSelect
export type BillingConfig = typeof billingConfig.$inferSelect
export type AuditLogEntry = typeof auditLog.$inferSelect
