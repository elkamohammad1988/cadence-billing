import { relations } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { planPrices, plans } from './catalogue'
import { invoiceStatus, subscriptionSource, subscriptionStatus } from './enums'
import { workspaces } from './tenancy'

/**
 * Stripe customer to workspace map. The webhook handler needs it: most events
 * carry a customer id and nothing else that identifies the tenant.
 */
export const billingCustomers = pgTable('billing_customers', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  email: text('email'),
  name: text('name'),
  /** Cached for the billing page. Never used for authorisation. */
  defaultCardBrand: text('default_card_brand'),
  defaultCardLast4: text('default_card_last4'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The single source of truth for what a workspace is entitled to.
 *
 * Exactly one row per workspace; the absence of a row means Free. The row is
 * a projection of Stripe, reconciled by the webhook handler and repaired by
 * the reconciliation job. Nothing that runs as the user can write to it.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .unique()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    priceId: uuid('price_id').references(() => planPrices.id, { onDelete: 'set null' }),

    source: subscriptionSource('source').notNull().default('stripe'),
    status: subscriptionStatus('status').notNull(),

    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id').unique(),
    /** Needed to push seat-quantity updates without re-reading the sub. */
    stripeItemId: text('stripe_item_id'),

    quantity: integer('quantity').notNull().default(1),

    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),

    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    trialStart: timestamp('trial_start', { withTimezone: true }),
    trialEnd: timestamp('trial_end', { withTimezone: true }),

    /** Dunning deadline. Past this, a past_due workspace drops to Free. */
    gracePeriodEndsAt: timestamp('grace_period_ends_at', { withTimezone: true }),

    /** A downgrade that takes effect at period end. */
    scheduledPlanId: uuid('scheduled_plan_id').references(() => plans.id, { onDelete: 'set null' }),
    scheduledPriceId: uuid('scheduled_price_id').references(() => planPrices.id, {
      onDelete: 'set null',
    }),
    scheduledChangeAt: timestamp('scheduled_change_at', { withTimezone: true }),

    /**
     * Out-of-order delivery guard. Stripe does not guarantee ordering, so we
     * record the `created` timestamp of the last event applied and refuse
     * anything older.
     */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    lastEventId: text('last_event_id'),

    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('subscriptions_status_idx').on(table.status),
    index('subscriptions_stripe_customer_idx').on(table.stripeCustomerId),
    index('subscriptions_plan_id_idx').on(table.planId),
  ],
)

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    stripeInvoiceId: text('stripe_invoice_id').notNull().unique(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    number: text('number'),
    status: invoiceStatus('status').notNull(),
    amountDue: integer('amount_due').notNull().default(0),
    amountPaid: integer('amount_paid').notNull().default(0),
    amountRemaining: integer('amount_remaining').notNull().default(0),
    subtotal: integer('subtotal').notNull().default(0),
    total: integer('total').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    /** True when the line items include a proration adjustment. */
    hasProration: boolean('has_proration').notNull().default(false),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    invoicePdf: text('invoice_pdf'),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    dueDate: timestamp('due_date', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextPaymentAttempt: timestamp('next_payment_attempt', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invoices_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('invoices_status_idx').on(table.status),
  ],
)

/**
 * One row per failed payment attempt. Separate from `invoices` because an
 * invoice that later succeeds should not erase the fact that it failed first —
 * that history is what the admin failed-payments view is for.
 */
export const paymentFailures = pgTable(
  'payment_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    stripeInvoiceId: text('stripe_invoice_id').notNull(),
    stripeChargeId: text('stripe_charge_id'),
    amountDue: integer('amount_due').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    attemptCount: integer('attempt_count').notNull().default(1),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    nextPaymentAttempt: timestamp('next_payment_attempt', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payment_failures_workspace_idx').on(table.workspaceId, table.occurredAt)],
)

export const billingCustomersRelations = relations(billingCustomers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [billingCustomers.workspaceId],
    references: [workspaces.id],
  }),
}))

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  workspace: one(workspaces, { fields: [subscriptions.workspaceId], references: [workspaces.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  price: one(planPrices, { fields: [subscriptions.priceId], references: [planPrices.id] }),
}))

export const invoicesRelations = relations(invoices, ({ one }) => ({
  workspace: one(workspaces, { fields: [invoices.workspaceId], references: [workspaces.id] }),
}))

export type BillingCustomer = typeof billingCustomers.$inferSelect
export type Subscription = typeof subscriptions.$inferSelect
export type Invoice = typeof invoices.$inferSelect
export type PaymentFailure = typeof paymentFailures.$inferSelect
