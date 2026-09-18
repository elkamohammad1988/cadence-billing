import 'dotenv/config'

import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

/**
 * Builds the demo dataset.
 *
 * The point of this script is that every subscription state is on screen
 * within seconds of a clone: free, trialing, active, past_due mid-grace, and
 * canceled-after-downgrade. A recording should never have to wait for a trial
 * to expire or a card to decline.
 *
 * Two things worth knowing before reading on.
 *
 * **The Stripe identifiers here are fabricated.** They carry a `_seed_` infix
 * (`cus_seed_cobalt`, `sub_seed_cobalt`) so that nothing mistakes them for
 * real objects. The reconciliation job skips them rather than asking Stripe
 * about subscriptions that do not exist — see `lib/billing/reconcile.ts`. A
 * workspace you create yourself through Checkout gets genuine identifiers and
 * reconciles normally. The seeded ones are scenery; the real flow is real.
 *
 * **It bypasses the limit triggers.** Building a Pro workspace with seven
 * projects means inserting those projects before the subscription row exists,
 * which the Free plan's limit of three would reject. `app.bypass_limits` is
 * the documented escape hatch for exactly this, and it is reachable only from
 * a direct `postgres` connection — see the notes on `app.limits_bypassed()`.
 *
 * Re-running is safe: demo workspaces are dropped and rebuilt, demo users are
 * reused. Audit entries are appended once and then left alone, because an
 * append-only log that a script can rewrite is not one.
 */

const PASSWORD = 'cadence-demo-1234'

const DAY = 24 * 60 * 60 * 1000

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY)
}

type SeedUser = {
  key: 'owner' | 'teammate' | 'designer' | 'admin' | 'rival'
  email: string
  fullName: string
}

const USERS: SeedUser[] = [
  { key: 'owner', email: 'owner@cadence.test', fullName: 'Rowan Devlin' },
  { key: 'teammate', email: 'teammate@cadence.test', fullName: 'Priya Ansari' },
  { key: 'designer', email: 'designer@cadence.test', fullName: 'Tomas Lindqvist' },
  { key: 'admin', email: 'admin@cadence.test', fullName: 'Cadence Admin' },
  // Owns a separate tenant. Exists so the cross-workspace isolation test has a
  // second party whose data must stay invisible.
  { key: 'rival', email: 'rival@cadence.test', fullName: 'Wren Castellanos' },
]

const WORKSPACE_SLUGS = ['atlas', 'beacon', 'cobalt', 'harbor', 'lantern', 'northwind']

// Placeholder catalogue prices. `pnpm stripe:sync-plans` replaces these with
// the real ones from Stripe and deactivates whatever it supersedes.
const SEED_PRICES: Array<{
  planKey: string
  interval: 'month' | 'year'
  stripePriceId: string
  unitAmount: number
}> = [
  { planKey: 'starter', interval: 'month', stripePriceId: 'price_seed_starter_month', unitAmount: 1900 },
  { planKey: 'starter', interval: 'year', stripePriceId: 'price_seed_starter_year', unitAmount: 19000 },
  { planKey: 'pro', interval: 'month', stripePriceId: 'price_seed_pro_month', unitAmount: 4900 },
  { planKey: 'pro', interval: 'year', stripePriceId: 'price_seed_pro_year', unitAmount: 49000 },
  { planKey: 'business', interval: 'month', stripePriceId: 'price_seed_business_month', unitAmount: 14900 },
  { planKey: 'business', interval: 'year', stripePriceId: 'price_seed_business_year', unitAmount: 149000 },
]

async function ensureUsers(): Promise<Record<SeedUser['key'], string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. ' +
        'Run `pnpm db:start` and copy the printed values into .env.',
    )
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // The admin API has no get-by-email, so one listing is cheaper than five
  // failed creates.
  const { data: existing, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 })
  if (listError) {
    throw new Error(`Could not list auth users: ${listError.message}`)
  }
  const byEmail = new Map(
    existing.users.map((user) => [user.email?.toLowerCase() ?? '', user.id] as const),
  )

  const ids = {} as Record<SeedUser['key'], string>

  for (const user of USERS) {
    const found = byEmail.get(user.email)
    if (found) {
      ids[user.key] = found
      continue
    }

    const { data, error } = await admin.auth.admin.createUser({
      email: user.email,
      password: PASSWORD,
      // Skips the confirmation mail entirely, so these accounts can sign in on
      // a machine with no mail provider configured.
      email_confirm: true,
      user_metadata: { full_name: user.fullName },
    })
    if (error || !data.user) {
      throw new Error(`Could not create ${user.email}: ${error?.message ?? 'unknown error'}`)
    }
    ids[user.key] = data.user.id
  }

  return ids
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.')
  }

  console.log('Creating demo users…')
  const users = await ensureUsers()

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} })

  try {
    await sql.begin(async (tx) => {
      // Must be literal: `set local` does not take a bind parameter.
      await tx.unsafe(`set local app.bypass_limits = 'on'`)

      // --- Clean slate for the demo tenants --------------------------------
      // Cascades remove members, projects, notes, subscriptions, invoices and
      // billing customers along with the workspace.
      await tx`delete from public.workspaces where slug = any(${WORKSPACE_SLUGS})`
      await tx`delete from public.stripe_events where stripe_event_id like 'evt_seed_%'`

      // --- Profiles --------------------------------------------------------
      const adminEmails = (process.env.ADMIN_EMAILS ?? 'admin@cadence.test')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)

      for (const user of USERS) {
        await tx`
          update public.profiles
             set full_name = ${user.fullName},
                 is_platform_admin = ${adminEmails.includes(user.email)}
           where id = ${users[user.key]}
        `
      }

      // --- Catalogue -------------------------------------------------------
      for (const planKey of ['starter', 'pro', 'business']) {
        await tx`
          update public.plans
             set stripe_product_id = ${`prod_seed_${planKey}`}
           where key = ${planKey}
             and stripe_product_id is null
        `
      }

      const priceIds = new Map<string, string>()
      for (const price of SEED_PRICES) {
        const [row] = await tx<{ id: string }[]>`
          insert into public.plan_prices (plan_id, "interval", stripe_price_id, unit_amount)
          select p.id, ${price.interval}::public.billing_interval,
                 ${price.stripePriceId}, ${price.unitAmount}
            from public.plans p
           where p.key = ${price.planKey}
          on conflict (stripe_price_id) do update
            set unit_amount = excluded.unit_amount,
                is_active = true
          returning id
        `
        priceIds.set(`${price.planKey}:${price.interval}`, row!.id)
      }

      const planRows = await tx<{ id: string; key: string }[]>`
        select id, key from public.plans
      `
      const planIds = new Map(planRows.map((row) => [row.key, row.id] as const))
      const planId = (key: string): string => {
        const id = planIds.get(key)
        if (!id) throw new Error(`Plan "${key}" is missing — did 0005 run?`)
        return id
      }
      const priceId = (key: string): string => {
        const id = priceIds.get(key)
        if (!id) throw new Error(`Price "${key}" is missing.`)
        return id
      }

      // --- Helpers ---------------------------------------------------------

      async function createWorkspace(
        slug: string,
        name: string,
        ownerId: string,
      ): Promise<string> {
        const [row] = await tx<{ id: string }[]>`
          insert into public.workspaces (slug, name, owner_id)
          values (${slug}, ${name}, ${ownerId})
          returning id
        `
        return row!.id
      }

      async function addMember(
        workspaceId: string,
        userId: string,
        role: 'admin' | 'member',
      ): Promise<void> {
        await tx`
          insert into public.workspace_members (workspace_id, user_id, role, invited_by)
          values (${workspaceId}, ${userId}, ${role}::public.workspace_role, ${users.owner})
          on conflict (workspace_id, user_id) do nothing
        `
      }

      async function addProjects(
        workspaceId: string,
        createdBy: string,
        names: string[],
        options: { archivedFrom?: number; archivedReason?: string } = {},
      ): Promise<void> {
        for (const [index, name] of names.entries()) {
          const archived =
            options.archivedFrom !== undefined && index >= options.archivedFrom
              ? daysFromNow(-6)
              : null
          const [project] = await tx<{ id: string }[]>`
            insert into public.projects
              (workspace_id, name, description, created_by, archived_at, archived_reason)
            values (
              ${workspaceId}, ${name}, ${`Demo project: ${name}.`}, ${createdBy},
              ${archived}, ${archived ? (options.archivedReason ?? null) : null}
            )
            returning id
          `
          await tx`
            insert into public.notes (workspace_id, project_id, title, body, created_by)
            values (
              ${workspaceId}, ${project!.id}, ${'Kickoff'},
              ${`Opening note for ${name}. Replace with anything; the product surface is not the point.`},
              ${createdBy}
            )
          `
        }
      }

      async function addBillingCustomer(
        workspaceId: string,
        customerId: string,
        email: string,
        brand: string,
        last4: string,
      ): Promise<void> {
        await tx`
          insert into public.billing_customers
            (workspace_id, stripe_customer_id, email, name, default_card_brand, default_card_last4)
          values (${workspaceId}, ${customerId}, ${email}, ${'Cadence demo'}, ${brand}, ${last4})
        `
      }

      // --- 1. Free ---------------------------------------------------------
      // At the limit on purpose: "Create project" is disabled on arrival, and
      // an API call that ignores the UI still gets CD001 back.
      const atlas = await createWorkspace('atlas', 'Atlas', users.owner)
      await addProjects(atlas, users.owner, ['Website refresh', 'Q3 roadmap', 'Hiring loop'])

      // --- 2. Trialing -----------------------------------------------------
      const beacon = await createWorkspace('beacon', 'Beacon', users.owner)
      await addMember(beacon, users.teammate, 'admin')
      await addProjects(beacon, users.owner, [
        'Onboarding revamp',
        'Mobile beta',
        'Pricing experiment',
        'Support macros',
        'Design system',
      ])
      await addBillingCustomer(beacon, 'cus_seed_beacon', 'owner@cadence.test', 'visa', '4242')
      await tx`
        insert into public.subscriptions (
          workspace_id, plan_id, price_id, source, status,
          stripe_customer_id, stripe_subscription_id, stripe_item_id, quantity,
          current_period_start, current_period_end, trial_start, trial_end,
          last_event_at, last_event_id
        ) values (
          ${beacon}, ${planId('pro')}, ${priceId('pro:month')}, 'stripe', 'trialing',
          'cus_seed_beacon', 'sub_seed_beacon', 'si_seed_beacon', 1,
          ${daysFromNow(-5)}, ${daysFromNow(9)}, ${daysFromNow(-5)}, ${daysFromNow(9)},
          ${daysFromNow(-5)}, 'evt_seed_beacon_created'
        )
      `

      // --- 3. Active Pro ---------------------------------------------------
      // Carries two paid invoices, the second with a proration line, so the
      // billing history page has something true to show before anyone has run
      // an upgrade by hand.
      const cobalt = await createWorkspace('cobalt', 'Cobalt', users.owner)
      await addMember(cobalt, users.teammate, 'member')
      await addMember(cobalt, users.designer, 'member')
      await addProjects(cobalt, users.owner, [
        'Platform migration',
        'Billing rewrite',
        'Customer interviews',
        'Analytics pipeline',
        'Docs overhaul',
        'Partner API',
        'Incident review',
      ])
      await addBillingCustomer(cobalt, 'cus_seed_cobalt', 'owner@cadence.test', 'visa', '4242')
      await tx`
        insert into public.subscriptions (
          workspace_id, plan_id, price_id, source, status,
          stripe_customer_id, stripe_subscription_id, stripe_item_id, quantity,
          current_period_start, current_period_end,
          last_event_at, last_event_id, reconciled_at
        ) values (
          ${cobalt}, ${planId('pro')}, ${priceId('pro:month')}, 'stripe', 'active',
          'cus_seed_cobalt', 'sub_seed_cobalt', 'si_seed_cobalt', 1,
          ${daysFromNow(-12)}, ${daysFromNow(18)},
          ${daysFromNow(-12)}, 'evt_seed_cobalt_updated', ${daysFromNow(-1)}
        )
      `
      await tx`
        insert into public.invoices (
          workspace_id, stripe_invoice_id, stripe_subscription_id, number, status,
          amount_due, amount_paid, amount_remaining, subtotal, total,
          has_proration, hosted_invoice_url, period_start, period_end, paid_at, created_at
        ) values
        (
          ${cobalt}, 'in_seed_cobalt_001', 'sub_seed_cobalt', 'CDNC-0001', 'paid',
          1900, 1900, 0, 1900, 1900,
          false, 'https://invoice.stripe.com/seed/cobalt-001',
          ${daysFromNow(-42)}, ${daysFromNow(-12)}, ${daysFromNow(-42)}, ${daysFromNow(-42)}
        ),
        (
          ${cobalt}, 'in_seed_cobalt_002', 'sub_seed_cobalt', 'CDNC-0002', 'paid',
          3860, 3860, 0, 3860, 3860,
          true, 'https://invoice.stripe.com/seed/cobalt-002',
          ${daysFromNow(-12)}, ${daysFromNow(18)}, ${daysFromNow(-12)}, ${daysFromNow(-12)}
        )
      `

      // --- 4. past_due, mid-grace ------------------------------------------
      // Four days left on a seven-day grace period. Access is intact; the
      // dunning banner counts down.
      const harbor = await createWorkspace('harbor', 'Harbor', users.owner)
      await addMember(harbor, users.designer, 'member')
      await addProjects(harbor, users.owner, [
        'Retail pilot',
        'Store rollout',
        'Seasonal campaign',
        'Vendor onboarding',
      ])
      await addBillingCustomer(harbor, 'cus_seed_harbor', 'owner@cadence.test', 'mastercard', '4444')
      await tx`
        insert into public.subscriptions (
          workspace_id, plan_id, price_id, source, status,
          stripe_customer_id, stripe_subscription_id, stripe_item_id, quantity,
          current_period_start, current_period_end, grace_period_ends_at,
          last_event_at, last_event_id
        ) values (
          ${harbor}, ${planId('starter')}, ${priceId('starter:month')}, 'stripe', 'past_due',
          'cus_seed_harbor', 'sub_seed_harbor', 'si_seed_harbor', 1,
          ${daysFromNow(-3)}, ${daysFromNow(27)}, ${daysFromNow(4)},
          ${daysFromNow(-3)}, 'evt_seed_harbor_payment_failed'
        )
      `
      await tx`
        insert into public.invoices (
          workspace_id, stripe_invoice_id, stripe_subscription_id, number, status,
          amount_due, amount_paid, amount_remaining, subtotal, total,
          hosted_invoice_url, period_start, period_end, attempt_count,
          next_payment_attempt, created_at
        ) values (
          ${harbor}, 'in_seed_harbor_004', 'sub_seed_harbor', 'CDNC-0004', 'open',
          1900, 0, 1900, 1900, 1900,
          'https://invoice.stripe.com/seed/harbor-004',
          ${daysFromNow(-3)}, ${daysFromNow(27)}, 2,
          ${daysFromNow(1)}, ${daysFromNow(-3)}
        )
      `
      await tx`
        insert into public.payment_failures (
          workspace_id, stripe_invoice_id, stripe_charge_id, amount_due,
          attempt_count, failure_code, failure_message, next_payment_attempt, occurred_at
        ) values (
          ${harbor}, 'in_seed_harbor_004', 'ch_seed_harbor_004', 1900,
          2, 'card_declined', 'Your card was declined.', ${daysFromNow(1)}, ${daysFromNow(-3)}
        )
      `

      // --- 5. Canceled, after an automatic downgrade -----------------------
      // Two projects were archived on the way down, which is the documented
      // policy. Un-archiving one is refused while the workspace sits at the
      // Free limit — that refusal is worth showing on camera.
      const lantern = await createWorkspace('lantern', 'Lantern', users.owner)
      await addProjects(
        lantern,
        users.owner,
        ['Brand study', 'Field research', 'Concept tests', 'Motion tests', 'Archive audit'],
        { archivedFrom: 3, archivedReason: 'Archived automatically on downgrade to Free.' },
      )
      await addBillingCustomer(lantern, 'cus_seed_lantern', 'owner@cadence.test', 'visa', '0341')
      await tx`
        insert into public.subscriptions (
          workspace_id, plan_id, price_id, source, status,
          stripe_customer_id, stripe_subscription_id, stripe_item_id, quantity,
          current_period_start, current_period_end, canceled_at, ended_at,
          last_event_at, last_event_id
        ) values (
          ${lantern}, ${planId('pro')}, ${priceId('pro:month')}, 'stripe', 'canceled',
          'cus_seed_lantern', 'sub_seed_lantern', 'si_seed_lantern', 1,
          ${daysFromNow(-36)}, ${daysFromNow(-6)}, ${daysFromNow(-6)}, ${daysFromNow(-6)},
          ${daysFromNow(-6)}, 'evt_seed_lantern_deleted'
        )
      `

      // --- 6. A second tenant ----------------------------------------------
      // Owned by someone else, on a seat-billed plan. Nothing above may be
      // visible from here, and nothing here may be visible from above; that is
      // what the isolation test asserts.
      const northwind = await createWorkspace('northwind', 'Northwind', users.rival)
      await addMember(northwind, users.teammate, 'member')
      await addMember(northwind, users.designer, 'member')
      await addProjects(northwind, users.rival, [
        'Warehouse ops',
        'Fleet tracking',
        'Supplier portal',
      ])
      await addBillingCustomer(
        northwind,
        'cus_seed_northwind',
        'rival@cadence.test',
        'amex',
        '0005',
      )
      await tx`
        insert into public.subscriptions (
          workspace_id, plan_id, price_id, source, status,
          stripe_customer_id, stripe_subscription_id, stripe_item_id, quantity,
          current_period_start, current_period_end,
          last_event_at, last_event_id
        ) values (
          ${northwind}, ${planId('business')}, ${priceId('business:month')}, 'stripe', 'active',
          'cus_seed_northwind', 'sub_seed_northwind', 'si_seed_northwind', 3,
          ${daysFromNow(-8)}, ${daysFromNow(22)},
          ${daysFromNow(-8)}, 'evt_seed_northwind_updated'
        )
      `

      // --- Webhook log -----------------------------------------------------
      // One of each status, so /admin has something to filter on and something
      // to replay the first time it is opened.
      await tx`
        insert into public.stripe_events (
          stripe_event_id, type, api_version, payload, status, workspace_id,
          stripe_customer_id, attempts, error, duration_ms,
          event_created_at, processed_at
        ) values
        (
          'evt_seed_cobalt_updated', 'customer.subscription.updated', '2024-11-20.acacia',
          ${sql.json({ id: 'evt_seed_cobalt_updated', seeded: true, object: 'event' })},
          'processed', ${cobalt}, 'cus_seed_cobalt', 1, null, 41,
          ${daysFromNow(-12)}, ${daysFromNow(-12)}
        ),
        (
          'evt_seed_beacon_created', 'customer.subscription.created', '2024-11-20.acacia',
          ${sql.json({ id: 'evt_seed_beacon_created', seeded: true, object: 'event' })},
          'processed', ${beacon}, 'cus_seed_beacon', 1, null, 33,
          ${daysFromNow(-5)}, ${daysFromNow(-5)}
        ),
        (
          'evt_seed_harbor_payment_failed', 'invoice.payment_failed', '2024-11-20.acacia',
          ${sql.json({ id: 'evt_seed_harbor_payment_failed', seeded: true, object: 'event' })},
          'failed', ${harbor}, 'cus_seed_harbor', 3,
          'plan lookup failed: no active price for sub_seed_harbor', 128,
          ${daysFromNow(-3)}, null
        ),
        (
          'evt_seed_unknown_customer', 'invoice.paid', '2024-11-20.acacia',
          ${sql.json({ id: 'evt_seed_unknown_customer', seeded: true, object: 'event' })},
          'skipped', null, 'cus_seed_not_ours', 1,
          'no workspace for customer cus_seed_not_ours', 12,
          ${daysFromNow(-2)}, ${daysFromNow(-2)}
        )
      `

      await tx`
        insert into public.stripe_event_attempts (event_id, attempt_number, status, error, duration_ms, started_at, finished_at)
        select e.id, 1, 'failed',
               'plan lookup failed: no active price for sub_seed_harbor', 128,
               ${daysFromNow(-3)}, ${daysFromNow(-3)}
          from public.stripe_events e
         where e.stripe_event_id = 'evt_seed_harbor_payment_failed'
      `

      // --- Audit trail -----------------------------------------------------
      // Append-only, so it is written once and never rewritten by a re-seed.
      const [seeded] = await tx<{ count: number }[]>`
        select count(*)::int as count
          from public.audit_log
         where metadata ->> 'seed' = 'true'
      `
      if ((seeded?.count ?? 0) === 0) {
        await tx`
          insert into public.audit_log (
            actor_type, actor_id, actor_email, workspace_id, action, reason,
            target_table, target_id, metadata, created_at
          ) values
          (
            'system', null, null, ${lantern}, 'billing.downgraded_to_free',
            'Subscription canceled; plan limits reapplied.',
            'subscriptions', 'sub_seed_lantern',
            ${sql.json({ seed: 'true', archived_projects: 2 })}, ${daysFromNow(-6)}
          ),
          (
            'system', null, null, ${harbor}, 'billing.grace_period_started',
            'First payment failure on invoice in_seed_harbor_004.',
            'subscriptions', 'sub_seed_harbor',
            ${sql.json({ seed: 'true', grace_days: 7 })}, ${daysFromNow(-3)}
          )
        `
      }
    })

    // --- Summary -----------------------------------------------------------
    const summary = await sql<
      {
        slug: string
        plan_key: string
        subscription_status: string | null
        project_count: number
        seat_count: number
      }[]
    >`
      select w.slug,
             p.key as plan_key,
             s.status::text as subscription_status,
             app.workspace_project_count(w.id) as project_count,
             app.workspace_seat_count(w.id) as seat_count
        from public.workspaces w
        join public.plans p on p.id = app.effective_plan_id(w.id)
        left join public.subscriptions s on s.workspace_id = w.id
       where w.slug = any(${WORKSPACE_SLUGS})
       order by w.created_at
    `

    console.log('\nSeeded workspaces:\n')
    console.log('  slug         effective plan   status        projects  seats')
    console.log('  ' + '-'.repeat(62))
    for (const row of summary) {
      console.log(
        '  ' +
          row.slug.padEnd(13) +
          row.plan_key.padEnd(17) +
          (row.subscription_status ?? '—').padEnd(14) +
          String(row.project_count).padEnd(10) +
          String(row.seat_count),
      )
    }

    console.log(`\nAll demo accounts use the password: ${PASSWORD}`)
    console.log('  owner@cadence.test     owns atlas, beacon, cobalt, harbor, lantern')
    console.log('  teammate@cadence.test  member of beacon, cobalt, northwind')
    console.log('  designer@cadence.test  member of cobalt, harbor, northwind')
    console.log('  rival@cadence.test     owns northwind — the isolation counterparty')
    console.log('  admin@cadence.test     platform admin, for /admin')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('\nSeed failed:')
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
