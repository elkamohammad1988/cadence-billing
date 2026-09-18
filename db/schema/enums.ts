import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * These mirror the Postgres enums created in
 * `supabase/migrations/20260101000000_extensions_and_types.sql`.
 *
 * Drizzle is the query layer here, not the migration source — the SQL files
 * are. Declaring the enums with `pgEnum` gives us the TypeScript union types
 * and lets `drizzle-kit` diff against a real database when a future change
 * needs generating.
 */

/** Verbatim copy of Stripe's `subscription.status` vocabulary. */
export const subscriptionStatus = pgEnum('subscription_status', [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
])

export const billingInterval = pgEnum('billing_interval', ['month', 'year'])

export const subscriptionSource = pgEnum('subscription_source', ['stripe', 'manual'])

export const workspaceRole = pgEnum('workspace_role', ['owner', 'admin', 'member'])

export const invoiceStatus = pgEnum('invoice_status', [
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void',
])

export const stripeEventStatus = pgEnum('stripe_event_status', [
  'received',
  'processing',
  'processed',
  'failed',
  'skipped',
])

export const auditActorType = pgEnum('audit_actor_type', ['user', 'admin', 'system', 'webhook'])

export type SubscriptionStatus = (typeof subscriptionStatus.enumValues)[number]
export type BillingInterval = (typeof billingInterval.enumValues)[number]
export type SubscriptionSource = (typeof subscriptionSource.enumValues)[number]
export type WorkspaceRole = (typeof workspaceRole.enumValues)[number]
export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number]
export type StripeEventStatus = (typeof stripeEventStatus.enumValues)[number]
export type AuditActorType = (typeof auditActorType.enumValues)[number]
