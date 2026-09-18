import 'dotenv/config'

import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

/**
 * Builds the demo dataset: every subscription state visible within seconds of
 * a clone, so a recording never has to wait for a trial to expire or a card to
 * decline.
 *
 * The Stripe identifiers are fabricated and carry a `_seed_` infix, so nothing
 * mistakes them for real objects and reconciliation can skip them. A workspace
 * created through Checkout gets genuine identifiers and reconciles normally.
 *
 * Re-running is safe: demo workspaces are dropped and rebuilt, demo users are
 * reused.
 */

const PASSWORD = 'cadence-demo-1234'
const DAY = 24 * 60 * 60 * 1000

const daysFromNow = (days: number) => new Date(Date.now() + days * DAY)

type UserKey = 'owner' | 'teammate' | 'designer' | 'admin' | 'rival'

const USERS: Array<{ key: UserKey; email: string; fullName: string }> = [
  { key: 'owner', email: 'owner@cadence.test', fullName: 'Rowan Devlin' },
  { key: 'teammate', email: 'teammate@cadence.test', fullName: 'Priya Ansari' },
  { key: 'designer', email: 'designer@cadence.test', fullName: 'Tomas Lindqvist' },
  { key: 'admin', email: 'admin@cadence.test', fullName: 'Cadence Admin' },
  // Owns a separate tenant, so the isolation test has a second party.
  { key: 'rival', email: 'rival@cadence.test', fullName: 'Wren Castellanos' },
]

const SLUGS = ['atlas', 'beacon', 'cobalt', 'harbor', 'lantern', 'northwind']

// Placeholders until `pnpm stripe:sync-plans` publishes the real catalogue.
const PRICES: Array<[plan: string, interval: 'month' | 'year', id: string, amount: number]> = [
  ['starter', 'month', 'price_seed_starter_month', 1900],
  ['starter', 'year', 'price_seed_starter_year', 19000],
  ['pro', 'month', 'price_seed_pro_month', 4900],
  ['pro', 'year', 'price_seed_pro_year', 49000],
  ['business', 'month', 'price_seed_business_month', 14900],
  ['business', 'year', 'price_seed_business_year', 149000],
]

async function ensureUsers(): Promise<Record<UserKey, string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: existing, error } = await admin.auth.admin.listUsers({ perPage: 200 })
  if (error) throw new Error(`Could not list auth users: ${error.message}`)

  const byEmail = new Map(existing.users.map((u) => [u.email?.toLowerCase() ?? '', u.id] as const))
  const ids = {} as Record<UserKey, string>

  for (const user of USERS) {
    const found = byEmail.get(user.email)
    if (found) {
      ids[user.key] = found
      continue
    }
    // email_confirm skips the confirmation mail, so these accounts work
    // regardless of how mail is configured.
    const created = await admin.auth.admin.createUser({
      email: user.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: user.fullName },
    })
    if (created.error || !created.data.user) {
      throw new Error(`Could not create ${user.email}: ${created.error?.message ?? 'unknown'}`)
    }
    ids[user.key] = created.data.user.id
  }

  return ids
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.')

  console.log('Creating demo users…')
  const users = await ensureUsers()

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} })

  try {
    await sql.begin(async (tx) => {
      // Demo workspaces are built before their subscriptions exist, so the
      // Free plan's limits would reject most of what follows.
      await tx`select app.begin_privileged_writes()`

      await tx`delete from public.workspaces where slug = any(${SLUGS})`

      const adminEmails = (process.env.ADMIN_EMAILS ?? 'admin@cadence.test')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)

      for (const user of USERS) {
        await tx`
          update public.profiles
             set full_name = ${user.fullName},
                 is_platform_admin = ${adminEmails.includes(user.email)}
           where id = ${users[user.key]}
        `
      }

      for (const planKey of ['starter', 'pro', 'business']) {
        await tx`
          update public.plans set stripe_product_id = ${`prod_seed_${planKey}`}
           where key = ${planKey} and stripe_product_id is null
        `
      }

      const priceIds = new Map<string, string>()
      for (const [planKey, interval, stripePriceId, amount] of PRICES) {
        const [row] = await tx<{ id: string }[]>`
          select app.set_active_plan_price(
            ${planKey}, ${interval}::public.billing_interval,
            ${stripePriceId}, ${amount}, 'usd', false
          ) as id
        `
        priceIds.set(`${planKey}:${interval}`, row!.id)
      }

      const planRows = await tx<{ id: string; key: string }[]>`select id, key from public.plans`
      const planId = (key: string) => {
        const id = planRows.find((p) => p.key === key)?.id
        if (!id) throw new Error(`Plan "${key}" is missing — did migration 0005 run?`)
        return id
      }
      const priceId = (key: string) => {
        const id = priceIds.get(key)
        if (!id) throw new Error(`Price "${key}" is missing.`)
        return id
      }

      async function workspace(slug: string, name: string, ownerId: string): Promise<string> {
        const [row] = await tx<{ id: string }[]>`
          insert into public.workspaces (slug, name, owner_id)
          values (${slug}, ${name}, ${ownerId}) returning id
        `
        return row!.id
      }

      async function member(workspaceId: string, userId: string, role: string): Promise<void> {
        await tx`
          insert into public.workspace_members (workspace_id, user_id, role, invited_by)
          values (${workspaceId}, ${userId}, ${role}::public.workspace_role, ${users.owner})
          on conflict (workspace_id, user_id) do nothing
        `
      }

      /** Names from `archivedFrom` onward are inserted already archived. */
      async function projects(
        workspaceId: string,
        createdBy: string,
        names: string[],
        archivedFrom?: number,
      ): Promise<void> {
        for (const [index, name] of names.entries()) {
          const archived = archivedFrom !== undefined && index >= archivedFrom
          const [project] = await tx<{ id: string }[]>`
            insert into public.projects
              (workspace_id, name, description, created_by, archived_at, archived_reason)
            values (
              ${workspaceId}, ${name}, ${`Demo project: ${name}.`}, ${createdBy},
              ${archived ? daysFromNow(-6) : null},
              ${archived ? 'Archived automatically on downgrade to Free.' : null}
            ) returning id
          `
          await tx`
            insert into public.notes (workspace_id, project_id, title, body, created_by)
            values (${workspaceId}, ${project!.id}, 'Kickoff',
                    ${`Opening note for ${name}.`}, ${createdBy})
          `
        }
      }

      async function customer(workspaceId: string, id: string, email: string): Promise<void> {
        await tx`
          insert into public.billing_customers
            (workspace_id, stripe_customer_id, email, name, default_card_brand, default_card_last4)
          values (${workspaceId}, ${id}, ${email}, 'Cadence demo', 'visa', '4242')
        `
      }

      type SubscriptionFields = {
        status: string
        planKey: string
        priceKey: string
        quantity?: number
        periodStart: Date
        periodEnd: Date
        trialEnd?: Date
        graceEndsAt?: Date
        canceledAt?: Date
      }

      async function subscription(
        workspaceId: string,
        slug: string,
        f: SubscriptionFields,
      ): Promise<void> {
        await tx`
          insert into public.subscriptions (
            workspace_id, plan_id, price_id, source, status,
            stripe_customer_id, stripe_subscription_id, stripe_item_id, quantity,
            current_period_start, current_period_end, trial_start, trial_end,
            grace_period_ends_at, canceled_at, ended_at, last_event_at, last_event_id
          ) values (
            ${workspaceId}, ${planId(f.planKey)}, ${priceId(f.priceKey)}, 'stripe',
            ${f.status}::public.subscription_status,
            ${`cus_seed_${slug}`}, ${`sub_seed_${slug}`}, ${`si_seed_${slug}`},
            ${f.quantity ?? 1},
            ${f.periodStart}, ${f.periodEnd},
            ${f.trialEnd ? f.periodStart : null}, ${f.trialEnd ?? null},
            ${f.graceEndsAt ?? null}, ${f.canceledAt ?? null}, ${f.canceledAt ?? null},
            ${f.periodStart}, ${`evt_seed_${slug}`}
          )
        `
      }

      // 1. Free, sitting exactly at its 3-project limit so the refusal is
      //    reachable the moment the app loads.
      const atlas = await workspace('atlas', 'Atlas', users.owner)
      await projects(atlas, users.owner, ['Website refresh', 'Q3 roadmap', 'Hiring loop'])

      // 2. Trialing.
      const beacon = await workspace('beacon', 'Beacon', users.owner)
      await member(beacon, users.teammate, 'admin')
      await projects(beacon, users.owner, ['Onboarding revamp', 'Mobile beta', 'Design system'])
      await customer(beacon, 'cus_seed_beacon', 'owner@cadence.test')
      await subscription(beacon, 'beacon', {
        status: 'trialing',
        planKey: 'pro',
        priceKey: 'pro:month',
        periodStart: daysFromNow(-5),
        periodEnd: daysFromNow(9),
        trialEnd: daysFromNow(9),
      })

      // 3. Active Pro.
      const cobalt = await workspace('cobalt', 'Cobalt', users.owner)
      await member(cobalt, users.teammate, 'member')
      await member(cobalt, users.designer, 'member')
      await projects(cobalt, users.owner, [
        'Platform migration',
        'Billing rewrite',
        'Customer interviews',
        'Analytics pipeline',
        'Partner API',
      ])
      await customer(cobalt, 'cus_seed_cobalt', 'owner@cadence.test')
      await subscription(cobalt, 'cobalt', {
        status: 'active',
        planKey: 'pro',
        priceKey: 'pro:month',
        periodStart: daysFromNow(-12),
        periodEnd: daysFromNow(18),
      })

      // 4. past_due with four days left of a seven-day grace period: access
      //    intact, banner counting down.
      const harbor = await workspace('harbor', 'Harbor', users.owner)
      await member(harbor, users.designer, 'member')
      await projects(harbor, users.owner, ['Retail pilot', 'Store rollout', 'Vendor onboarding'])
      await customer(harbor, 'cus_seed_harbor', 'owner@cadence.test')
      await subscription(harbor, 'harbor', {
        status: 'past_due',
        planKey: 'starter',
        priceKey: 'starter:month',
        periodStart: daysFromNow(-3),
        periodEnd: daysFromNow(27),
        graceEndsAt: daysFromNow(4),
      })

      // 5. Canceled, with two projects archived on the way down — the
      //    documented downgrade policy, already applied.
      const lantern = await workspace('lantern', 'Lantern', users.owner)
      await projects(
        lantern,
        users.owner,
        ['Brand study', 'Field research', 'Concept tests', 'Motion tests', 'Archive audit'],
        3,
      )
      await customer(lantern, 'cus_seed_lantern', 'owner@cadence.test')
      await subscription(lantern, 'lantern', {
        status: 'canceled',
        planKey: 'pro',
        priceKey: 'pro:month',
        periodStart: daysFromNow(-36),
        periodEnd: daysFromNow(-6),
        canceledAt: daysFromNow(-6),
      })

      // 6. A second tenant on a seat-billed plan. Nothing above may be visible
      //    from here, and nothing here from above.
      const northwind = await workspace('northwind', 'Northwind', users.rival)
      await member(northwind, users.teammate, 'member')
      await member(northwind, users.designer, 'member')
      await projects(northwind, users.rival, ['Warehouse ops', 'Fleet tracking', 'Supplier portal'])
      await customer(northwind, 'cus_seed_northwind', 'rival@cadence.test')
      await subscription(northwind, 'northwind', {
        status: 'active',
        planKey: 'business',
        priceKey: 'business:month',
        quantity: 3,
        periodStart: daysFromNow(-8),
        periodEnd: daysFromNow(22),
      })
    })

    const summary = await sql<
      {
        slug: string
        plan_key: string
        subscription_status: string | null
        project_count: number
        seat_count: number
      }[]
    >`
      select w.slug, p.key as plan_key, s.status::text as subscription_status,
             app.workspace_project_count(w.id) as project_count,
             app.workspace_seat_count(w.id) as seat_count
        from public.workspaces w
        join public.plans p on p.id = app.effective_plan_id(w.id)
        left join public.subscriptions s on s.workspace_id = w.id
       where w.slug = any(${SLUGS})
       order by w.created_at
    `

    console.log('\nslug         effective plan  status       projects  seats')
    console.log('-'.repeat(60))
    for (const row of summary) {
      console.log(
        row.slug.padEnd(13) +
          row.plan_key.padEnd(16) +
          (row.subscription_status ?? '—').padEnd(13) +
          String(row.project_count).padEnd(10) +
          row.seat_count,
      )
    }
    console.log(`\nAll demo accounts use the password: ${PASSWORD}`)
    console.log('  owner@cadence.test  owns atlas, beacon, cobalt, harbor, lantern')
    console.log('  rival@cadence.test  owns northwind — the isolation counterparty')
    console.log('  admin@cadence.test  platform admin')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('\nSeed failed:')
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
