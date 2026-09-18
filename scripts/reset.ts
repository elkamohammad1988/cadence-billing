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
 * The development database is a hosted Supabase project, not a disposable
 * container, so the guard cannot be "is this localhost". Instead the
 * destructive target is pinned: `CADENCE_DESTRUCTIVE_OK` must name the exact
 * host in DATABASE_URL. Repoint DATABASE_URL at staging or production without
 * also editing that variable and this refuses to run.
 *
 * That ordering matters. A guard you disable with a flag gets disabled out of
 * habit; a guard that requires editing a second file gets read first.
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

  -- Guarded: on a project that has never been migrated by either this script
  -- or the Supabase CLI, the schema does not exist and an unguarded DELETE
  -- fails with "schema does not exist".
  do $guard$
  begin
    if to_regclass('supabase_migrations.schema_migrations') is not null then
      delete from supabase_migrations.schema_migrations
      where name in (
        'extensions_and_types', 'tables', 'functions', 'triggers', 'rls', 'plan_catalogue'
      );
    end if;
  end
  $guard$;
`

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set.')
  }

  const host = new URL(url).host
  const allowed = (process.env.CADENCE_DESTRUCTIVE_OK ?? '').trim()

  if (!allowed) {
    throw new Error(
      'CADENCE_DESTRUCTIVE_OK is not set, so `db:reset` is disabled.\n' +
        `To allow it, set CADENCE_DESTRUCTIVE_OK to the host you intend to wipe: ${host}`,
    )
  }

  // Compare on host only. The port and the username differ between Supabase's
  // session and transaction poolers for the same project, and failing on that
  // difference would teach people to paste whatever the error printed.
  if (allowed !== host.split(':')[0] && allowed !== host) {
    throw new Error(
      'Refusing to reset: DATABASE_URL does not point at the host you authorised.\n' +
        `  DATABASE_URL host:      ${host}\n` +
        `  CADENCE_DESTRUCTIVE_OK: ${allowed}\n\n` +
        'This drops every Cadence table and deletes all @cadence.test auth users. ' +
        'If you really mean to wipe this database, update CADENCE_DESTRUCTIVE_OK in .env.',
    )
  }

  console.log(`Resetting ${host} …`)

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
