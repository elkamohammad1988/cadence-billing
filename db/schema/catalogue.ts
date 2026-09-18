import { eq, relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { billingInterval } from './enums'

/**
 * Mirror of the Stripe product catalogue.
 *
 * Limits are read from these rows at request time, never from constants, so
 * packaging can change without a deploy. `null` on a limit column means
 * unlimited; `0` would mean none allowed, which is a different statement.
 */
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stable code-facing identifier: 'free' | 'starter' | 'pro' | 'business'. */
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  tagline: text('tagline'),
  sortOrder: integer('sort_order').notNull().default(0),
  stripeProductId: text('stripe_product_id').unique(),

  maxWorkspaces: integer('max_workspaces'),
  maxProjects: integer('max_projects'),
  maxSeats: integer('max_seats'),

  aiEnabled: boolean('ai_enabled').notNull().default(false),
  prioritySupport: boolean('priority_support').notNull().default(false),
  /** Subscription item carries a quantity equal to the workspace seat count. */
  seatBilling: boolean('seat_billing').notNull().default(false),
  trialDays: integer('trial_days').notNull().default(0),

  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planPrices = pgTable(
  'plan_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    interval: billingInterval('interval').notNull(),
    stripePriceId: text('stripe_price_id').notNull().unique(),
    /** Minor units, as Stripe stores them. 1900 = $19.00. */
    unitAmount: integer('unit_amount').notNull(),
    currency: text('currency').notNull().default('usd'),
    /** Mirrors Stripe's own `livemode`; test and live prices coexist here. */
    livemode: boolean('livemode').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Historical prices accumulate; one active price per interval per mode.
    // `.where()` takes an SQL predicate, not a bare column reference.
    uniqueIndex('plan_prices_one_active_per_interval')
      .on(table.planId, table.interval, table.livemode)
      .where(eq(table.isActive, true)),
    index('plan_prices_plan_id_idx').on(table.planId),
  ],
)

export const plansRelations = relations(plans, ({ many }) => ({
  prices: many(planPrices),
}))

export const planPricesRelations = relations(planPrices, ({ one }) => ({
  plan: one(plans, { fields: [planPrices.planId], references: [plans.id] }),
}))

export type Plan = typeof plans.$inferSelect
export type PlanPrice = typeof planPrices.$inferSelect

/** The four keys the application knows about by name. */
export const PLAN_KEYS = ['free', 'starter', 'pro', 'business'] as const
export type PlanKey = (typeof PLAN_KEYS)[number]
