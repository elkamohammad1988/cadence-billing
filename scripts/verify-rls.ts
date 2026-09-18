import 'dotenv/config'

import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

/**
 * Proves the enforcement layer actually enforces.
 *
 * Every check here runs as the `authenticated` role with a real user's JWT
 * claims, not as the database owner. That distinction is the whole point:
 * connecting as `postgres` and selecting rows proves nothing, because the
 * owner bypasses every policy in the file. A test that cannot fail is not a
 * test.
 *
 * Run after `pnpm db:seed`:
 *
 *   pnpm db:verify
 *
 * Exits non-zero if any check fails, so it can be wired into CI later.
 *
 * Mutating checks run inside a transaction that is deliberately rolled back,
 * so the script is safe to run repeatedly against the demo data.
 */

type Check = {
  name: string
  detail: string
  passed: boolean
}

const checks: Check[] = []

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, detail, passed })
  const mark = passed ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${name}`)
  if (detail) console.log(`        ${detail}`)
}

/** Thrown to force a transaction rollback after a mutating check. */
class Rollback extends Error {
  constructor(public payload: unknown) {
    super('rollback')
  }
}

/**
 * Impersonates a user the way PostgREST does: set the JWT claims that
 * `auth.uid()` reads, then drop into the `authenticated` role. Both are
 * `SET LOCAL`, so they evaporate when the transaction ends.
 */
async function asUser(tx: postgres.TransactionSql, userId: string): Promise<void> {
  await tx.unsafe(
    `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'`,
  )
  await tx.unsafe('set local role authenticated')
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.')

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} })

  try {
    // --- Fixtures --------------------------------------------------------
    const workspaces = await sql<{ slug: string; id: string; owner_id: string }[]>`
      select slug, id, owner_id from public.workspaces
       where slug in ('atlas', 'cobalt', 'northwind')
    `
    const bySlug = new Map(workspaces.map((w) => [w.slug, w] as const))
    const atlas = bySlug.get('atlas')
    const cobalt = bySlug.get('cobalt')
    const northwind = bySlug.get('northwind')

    if (!atlas || !cobalt || !northwind) {
      throw new Error(
        'Demo workspaces are missing. Run `pnpm db:seed` first. ' +
          `Found: ${[...bySlug.keys()].join(', ') || 'none'}`,
      )
    }

    const [ownerRow] = await sql<{ id: string; email: string }[]>`
      select id, email from public.profiles where email = 'owner@cadence.test'
    `
    if (!ownerRow) throw new Error('owner@cadence.test is missing. Run `pnpm db:seed`.')
    const owner = ownerRow

    console.log(`\nEnvironment`)
    console.log(`  database host   ${new URL(databaseUrl).host}`)
    const [{ session_user: sessionUser, current_user: currentUser }] = await sql<
      { session_user: string; current_user: string }[]
    >`select session_user, current_user`
    console.log(`  session_user    ${sessionUser}`)
    console.log(`  current_user    ${currentUser}`)

    // --- 1. A member reads their own billing rows ------------------------
    console.log(`\n1. Tenant can read its own billing data`)
    await sql.begin(async (tx) => {
      await asUser(tx, owner.id)

      const subs = await tx<{ status: string; plan_key: string }[]>`
        select s.status::text, p.key as plan_key
          from public.subscriptions s
          join public.plans p on p.id = s.plan_id
         where s.workspace_id = ${cobalt.id}
      `
      record(
        'owner reads cobalt subscription',
        subs.length === 1,
        `${subs.length} row(s): ${subs.map((s) => `${s.plan_key}/${s.status}`).join(', ') || '—'}`,
      )

      const invoices = await tx<{ n: number }[]>`
        select count(*)::int as n from public.invoices where workspace_id = ${cobalt.id}
      `
      record(
        'owner reads cobalt invoices (workspace admin)',
        (invoices[0]?.n ?? 0) === 2,
        `${invoices[0]?.n ?? 0} invoice(s), expected 2`,
      )

      const entitlements = await tx<{ plan_key: string; project_count: number }[]>`
        select plan_key, project_count
          from public.workspace_entitlements
         where workspace_id = ${cobalt.id}
      `
      record(
        'workspace_entitlements view resolves for the owner',
        entitlements.length === 1 && entitlements[0]?.plan_key === 'pro',
        `plan=${entitlements[0]?.plan_key ?? '—'} projects=${entitlements[0]?.project_count ?? '—'}`,
      )
    })

    // --- 2. The same connection sees nothing of another tenant -----------
    console.log(`\n2. Cross-tenant reads return zero rows`)
    await sql.begin(async (tx) => {
      await asUser(tx, owner.id)

      const probes: Array<[string, Promise<{ n: number }[]>]> = [
        [
          'subscriptions',
          tx<{ n: number }[]>`
            select count(*)::int as n from public.subscriptions where workspace_id = ${northwind.id}
          `,
        ],
        [
          'invoices',
          tx<{ n: number }[]>`
            select count(*)::int as n from public.invoices where workspace_id = ${northwind.id}
          `,
        ],
        [
          'billing_customers',
          tx<{ n: number }[]>`
            select count(*)::int as n from public.billing_customers where workspace_id = ${northwind.id}
          `,
        ],
        [
          'projects',
          tx<{ n: number }[]>`
            select count(*)::int as n from public.projects where workspace_id = ${northwind.id}
          `,
        ],
        [
          'workspaces',
          tx<{ n: number }[]>`
            select count(*)::int as n from public.workspaces where id = ${northwind.id}
          `,
        ],
        [
          'workspace_entitlements (view)',
          tx<{ n: number }[]>`
            select count(*)::int as n from public.workspace_entitlements where workspace_id = ${northwind.id}
          `,
        ],
      ]

      for (const [label, query] of probes) {
        const rows = await query
        const n = rows[0]?.n ?? -1
        record(`northwind ${label} invisible to owner`, n === 0, `${n} row(s), expected 0`)
      }

      // The operational tables are platform-admin only; owner is not one.
      const events = await tx<{ n: number }[]>`
        select count(*)::int as n from public.stripe_events
      `
      record(
        'stripe_events invisible to a non-admin',
        (events[0]?.n ?? -1) === 0,
        `${events[0]?.n ?? -1} row(s), expected 0`,
      )
    })

    // --- 3. The limit trigger refuses an over-plan insert ----------------
    console.log(`\n3. Plan limits hold against a direct database write`)
    try {
      await sql.begin(async (tx) => {
        await asUser(tx, owner.id)
        await tx`
          insert into public.projects (workspace_id, name, created_by)
          values (${atlas.id}, ${'Fourth project on a Free plan'}, ${owner.id})
        `
        throw new Rollback('insert unexpectedly succeeded')
      })
      record('free workspace refuses a 4th project', false, 'insert succeeded — limit not enforced')
    } catch (error) {
      if (error instanceof Rollback) {
        record('free workspace refuses a 4th project', false, 'insert succeeded — limit not enforced')
      } else {
        const pgError = error as { code?: string; message?: string }
        const refused = pgError.code === 'CD001' || pgError.code === '42501'
        record(
          'free workspace refuses a 4th project',
          refused,
          `SQLSTATE ${pgError.code ?? '?'} — ${(pgError.message ?? '').split('\n')[0]}`,
        )
      }
    }

    // --- 4a. `authenticated` cannot buy its way past the trigger ---------
    console.log(`\n4. app.limits_bypassed() cannot be reached by an untrusted caller`)
    await sql.begin(async (tx) => {
      await asUser(tx, owner.id)
      // Any role may set a custom GUC, so forge the token properly: read the
      // real transaction id and set the GUC to exactly what the helper would
      // have written. Only the session_user check should stand in the way.
      const [xid] = await tx<{ id: string }[]>`select pg_current_xact_id()::text as id`
      await tx.unsafe(`set local app.bypass_limits = '${xid!.id}'`)
      const [row] = await tx<{ bypassed: boolean; who: string }[]>`
        select app.limits_bypassed() as bypassed, session_user as who
      `
      record(
        'authenticated forging a valid token does not bypass',
        row?.bypassed === false,
        `limits_bypassed()=${row?.bypassed} session_user=${row?.who}`,
      )
    })

    // Separate transaction: the raise aborts it, and anything after a failed
    // statement in the same transaction fails too.
    try {
      await sql.begin(async (tx) => {
        await asUser(tx, owner.id)
        await tx`select app.begin_privileged_writes()`
      })
      record('authenticated cannot call begin_privileged_writes()', false, 'helper did not refuse')
    } catch (error) {
      const pgError = error as { code?: string; message?: string }
      record(
        'authenticated cannot call begin_privileged_writes()',
        pgError.code === '42501',
        `SQLSTATE ${pgError.code ?? '?'} — ${(pgError.message ?? '').split('\n')[0]}`,
      )
    }

    // The property the transaction-id token buys: a session-level SET, the
    // mistake this design is meant to survive, authorises nothing later.
    await sql.begin(async (tx) => {
      const [xid] = await tx<{ id: string }[]>`select pg_current_xact_id()::text as id`
      // Deliberately NOT `set local` — this is the leak being simulated.
      await tx.unsafe(`set app.bypass_limits = '${xid!.id}'`)
    })
    const [leaked] = await sql<{ bypassed: boolean; setting: string | null }[]>`
      select app.limits_bypassed() as bypassed,
             current_setting('app.bypass_limits', true) as setting
    `
    record(
      'a leaked session-level token is inert in later transactions',
      leaked?.bypassed === false,
      `GUC still set to ${leaked?.setting ?? 'null'}, limits_bypassed()=${leaked?.bypassed}`,
    )
    await sql.unsafe(`reset app.bypass_limits`)

    // --- 4b. Same attempt over HTTP with the service-role key ------------
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      record(
        'service-role key over HTTP cannot bypass the limit',
        false,
        'skipped — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set',
      )
    } else {
      const admin = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      // service_role bypasses RLS, so the policy will not stop this. The
      // trigger still must, because over HTTP session_user is `authenticator`.
      const { data, error } = await admin
        .from('projects')
        .insert({
          workspace_id: atlas.id,
          name: 'Fourth project via service-role HTTP',
          created_by: owner.id,
        })
        .select('id')

      const refused = Boolean(error) && !data?.length
      record(
        'service-role key over HTTP cannot bypass the limit',
        refused,
        error
          ? `refused: ${error.code ?? '?'} — ${error.message}`
          : 'INSERT SUCCEEDED — the trigger did not fire for the HTTP path',
      )

      // If it did land, take it back out; the seed's Free workspace is meant
      // to sit exactly at its limit.
      if (data?.length) {
        await sql`delete from public.projects where id = ${data[0]!.id}`
      }
    }

    // --- 4c. A direct privileged connection may bypass -------------------
    try {
      await sql.begin(async (tx) => {
        await tx`select app.begin_privileged_writes()`
        const [row] = await tx<{ bypassed: boolean }[]>`select app.limits_bypassed() as bypassed`
        const inserted = await tx<{ id: string }[]>`
          insert into public.projects (workspace_id, name, created_by)
          values (${atlas.id}, ${'Bypass probe'}, ${owner.id})
          returning id
        `
        throw new Rollback({ bypassed: row?.bypassed, inserted: inserted.length })
      })
      record('direct connection with the GUC may bypass', false, 'transaction unexpectedly committed')
    } catch (error) {
      if (error instanceof Rollback) {
        const payload = error.payload as { bypassed: boolean; inserted: number }
        record(
          'direct connection with the GUC may bypass',
          payload.bypassed === true && payload.inserted === 1,
          `limits_bypassed()=${payload.bypassed}, rows inserted=${payload.inserted} (rolled back)`,
        )
      } else {
        const pgError = error as { code?: string; message?: string }
        record(
          'direct connection with the GUC may bypass',
          false,
          `SQLSTATE ${pgError.code ?? '?'} — ${(pgError.message ?? '').split('\n')[0]}`,
        )
      }
    }

    // --- 5. Seat limit, same shape ---------------------------------------
    console.log(`\n5. Seat limit`)
    const [rival] = await sql<{ id: string }[]>`
      select id from public.profiles where email = 'rival@cadence.test'
    `
    if (rival) {
      try {
        await sql.begin(async (tx) => {
          await asUser(tx, owner.id)
          // atlas is Free: 1 seat, already occupied by the owner.
          await tx`
            insert into public.workspace_members (workspace_id, user_id, role)
            values (${atlas.id}, ${rival.id}, 'member')
          `
          throw new Rollback('insert unexpectedly succeeded')
        })
        record('free workspace refuses a 2nd seat', false, 'insert succeeded — limit not enforced')
      } catch (error) {
        if (error instanceof Rollback) {
          record('free workspace refuses a 2nd seat', false, 'insert succeeded — limit not enforced')
        } else {
          const pgError = error as { code?: string; message?: string }
          const refused = pgError.code === 'CD002' || pgError.code === '42501'
          record(
            'free workspace refuses a 2nd seat',
            refused,
            `SQLSTATE ${pgError.code ?? '?'} — ${(pgError.message ?? '').split('\n')[0]}`,
          )
        }
      }
    }

    // --- Summary ---------------------------------------------------------
    const failed = checks.filter((check) => !check.passed)
    console.log(`\n${'='.repeat(64)}`)
    console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
    if (failed.length) {
      console.log('\nFailures:')
      for (const check of failed) console.log(`  - ${check.name}: ${check.detail}`)
      process.exitCode = 1
    }
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('\nVerification aborted:')
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
