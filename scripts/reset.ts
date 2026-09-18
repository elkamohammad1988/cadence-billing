import 'dotenv/config'

import postgres from 'postgres'

/**
 * Drops everything this project owns, then leaves the database ready for
 * `pnpm db:migrate`.
 *
 * Scoped on purpose. `drop schema public cascade` would also take out whatever
 * Supabase installs there and leave the project subtly broken, so this names
 * the objects it created and nothing else. Supabase's own schemas — auth,
 * storage, realtime — are untouched apart from the demo users.
 *
 * Refuses to run against anything that does not look local unless
 * `--force` is passed. The mistake this prevents is the expensive kind.
 */

const DEMO_EMAIL_DOMAIN = '@cadence.test'

const TEARDOWN = `
  drop view   if exists public.workspace_entitlements cascade;

  drop table  if exists public.stripe_event_attempts  cascade;
  drop table  if exists public.stripe_events          cascade;
  drop table  if exists public.audit_log              cascade;
  drop table  if exists public.payment_failures       cascade;
  drop table  if exists public.invoices               cascade;
  drop table  if exists public.subscriptions          cascade;
  drop table  if exists public.billing_customers      cascade;
  drop table  if exists public.billing_config         cascade;
  drop table  if exists public.notes                  cascade;
  drop table  if exists public.projects               cascade;
  drop table  if exists public.workspace_members      cascade;
  drop table  if exists public.workspaces             cascade;
  drop table  if exists public.plan_prices            cascade;
  drop table  if exists public.plans                  cascade;
  drop table  if exists public.profiles               cascade;

  drop type   if exists public.audit_actor_type    cascade;
  drop type   if exists public.stripe_event_status cascade;
  drop type   if exists public.invoice_status      cascade;
  drop type   if exists public.workspace_role      cascade;
  drop type   if exists public.subscription_source cascade;
  drop type   if exists public.billing_interval    cascade;
  drop type   if exists public.subscription_status cascade;

  -- Takes the SECURITY DEFINER helpers and the trigger functions with it. The
  -- trigger on auth.users depends on app.handle_new_auth_user(), so this must
  -- cascade or the drop fails.
  drop schema if exists app cascade;

  delete from supabase_migrations.schema_migrations
  where name in (
    'extensions_and_types', 'tables', 'functions', 'triggers', 'rls', 'plan_catalogue'
  );
`

function looksLocal(url: string): boolean {
  return /(@|\/\/)(127\.0\.0\.1|localhost|host\.docker\.internal|db)[:/]/.test(url)
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set.')
  }

  const force = process.argv.includes('--force')
  if (!looksLocal(url) && !force) {
    throw new Error(
      `Refusing to reset a database that does not look local.\n` +
        `  DATABASE_URL host: ${new URL(url).host}\n` +
        'Pass --force if you are certain. This drops every Cadence table and all demo users.',
    )
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  try {
    console.log('Dropping Cadence objects…')
    await sql.unsafe(TEARDOWN).simple()

    // auth.users rows outlive the public schema, and their ids are referenced
    // by profiles. Left behind, the next seed run collides on email.
    const deleted = await sql`
      delete from auth.users
      where email like ${'%' + DEMO_EMAIL_DOMAIN}
      returning id
    `
    console.log(`Removed ${deleted.length} demo auth user(s).`)
    console.log('\nDone. Run `pnpm db:migrate && pnpm db:seed` to rebuild.')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
