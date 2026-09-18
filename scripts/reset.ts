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

/**
 * Enumerated from the catalog rather than hand-listed.
 *
 * The previous version named every object explicitly, which meant that adding
 * a table and forgetting to add it here produced a "fresh" database that
 * quietly still had the old one in it — the worst possible outcome for a reset.
 *
 * Scope: everything in `public`, plus the `app` schema. Supabase's own schemas
 * (auth, storage, realtime) are untouched apart from the demo users deleted
 * separately below. On a project dedicated to this app that is what "reset"
 * should mean; the script prints what it is about to drop so the assumption is
 * visible rather than implied.
 */
const TEARDOWN = `
  do $teardown$
  declare
    r record;
  begin
    -- Views first: a view over a table being dropped would go anyway via
    -- cascade, but dropping it explicitly keeps the notice output readable.
    for r in
      select table_name from information_schema.views where table_schema = 'public'
    loop
      execute format('drop view if exists public.%I cascade', r.table_name);
    end loop;

    for r in
      select tablename from pg_tables where schemaname = 'public'
    loop
      execute format('drop table if exists public.%I cascade', r.tablename);
    end loop;

    -- Enum types are not reached by dropping the tables that use them.
    for r in
      select t.typname
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
         and t.typtype = 'e'
    loop
      execute format('drop type if exists public.%I cascade', r.typname);
    end loop;
  end
  $teardown$;

  -- Takes the SECURITY DEFINER helpers and the trigger functions with it. The
  -- trigger on auth.users depends on app.handle_new_auth_user(), so this must
  -- cascade or the drop fails.
  drop schema if exists app cascade;

  -- Everything the ledger recorded has just been dropped, so the ledger must
  -- not go on claiming it exists. Guarded because the schema is absent on a
  -- project neither this script nor the CLI has ever migrated.
  do $guard$
  begin
    if to_regclass('supabase_migrations.schema_migrations') is not null then
      delete from supabase_migrations.schema_migrations;
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
    // Print the inventory before destroying it. The teardown drops everything
    // in `public`, not just tables this project created, and that is a big
    // enough claim to show rather than assert.
    const inventory = await sql<{ kind: string; name: string }[]>`
      select 'table' as kind, tablename as name from pg_tables where schemaname = 'public'
      union all
      select 'view', table_name from information_schema.views where table_schema = 'public'
      union all
      select 'type', t.typname
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typtype = 'e'
      order by kind, name
    `

    if (inventory.length === 0) {
      console.log('Nothing in public to drop.')
    } else {
      console.log(`Dropping ${inventory.length} object(s) from public:`)
      for (const item of inventory) {
        console.log(`  ${item.kind.padEnd(6)} ${item.name}`)
      }
    }

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
