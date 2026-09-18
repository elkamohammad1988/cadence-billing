import 'dotenv/config'

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import postgres from 'postgres'

/**
 * Applies `supabase/migrations/*.sql` in filename order.
 *
 * The Supabase CLI already does this on `supabase db reset`. This script
 * exists for the cases where the CLI is not in play: CI against a bare
 * Postgres container, and `supabase db push`-less deploys where all you have
 * is a connection string.
 *
 * It records applied migrations in `supabase_migrations.schema_migrations` —
 * the CLI's own ledger, with the CLI's own column names. That is deliberate:
 * a second bookkeeping table would let the two runners disagree about what has
 * been applied, and the failure mode of that disagreement is running a
 * migration twice.
 *
 * Each file runs inside its own transaction. A failure leaves the database at
 * the last complete migration rather than halfway through a broken one.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')
const FILENAME = /^(\d{14,})_([a-z0-9_]+)\.sql$/

type Migration = {
  version: string
  name: string
  file: string
  sql: string
  checksum: string
}

function loadMigrations(): Migration[] {
  const entries = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort()

  return entries.map((file) => {
    const match = FILENAME.exec(file)
    if (!match) {
      throw new Error(
        `Migration filename "${file}" does not match <14-digit timestamp>_<snake_case>.sql. ` +
          'The Supabase CLI parses the prefix as the version; a file it cannot parse is silently skipped.',
      )
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    return {
      version: match[1]!,
      name: match[2]!,
      file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex').slice(0, 12),
    }
  })
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  try {
    await sql.unsafe(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key
      );
      alter table supabase_migrations.schema_migrations
        add column if not exists statements text[];
      alter table supabase_migrations.schema_migrations
        add column if not exists name text;
    `).simple()

    const applied = new Set(
      (
        await sql<{ version: string }[]>`
          select version from supabase_migrations.schema_migrations
        `
      ).map((row) => row.version),
    )

    const migrations = loadMigrations()
    const pending = migrations.filter((migration) => !applied.has(migration.version))

    if (pending.length === 0) {
      console.log(`Up to date — ${migrations.length} migration(s) already applied.`)
      return
    }

    // Out-of-order arrivals happen when two branches add migrations and merge.
    // Applying them anyway is usually right, but silently is not: the schema
    // you get depends on merge order, which is not recorded anywhere.
    const highestApplied = [...applied].sort().at(-1)
    for (const migration of pending) {
      if (highestApplied && migration.version < highestApplied) {
        console.warn(
          `  ! ${migration.file} sorts before the last applied migration (${highestApplied}). ` +
            'Applying it now, but the resulting schema depends on merge order.',
        )
      }
    }

    console.log(`Applying ${pending.length} migration(s):`)

    for (const migration of pending) {
      const startedAt = Date.now()
      process.stdout.write(`  → ${migration.file} `)

      try {
        await sql.begin(async (tx) => {
          // `.simple()` uses the simple query protocol, which is what allows a
          // file containing many statements to run as one round trip.
          await tx.unsafe(migration.sql).simple()
          await tx`
            insert into supabase_migrations.schema_migrations (version, name, statements)
            values (${migration.version}, ${migration.name}, ${[migration.sql]})
          `
        })
      } catch (error) {
        console.log('failed')
        console.error(`\n${migration.file} did not apply. The transaction was rolled back.\n`)
        throw error
      }

      console.log(`ok (${Date.now() - startedAt}ms, sha ${migration.checksum})`)
    }

    console.log(`\nDone. ${migrations.length} migration(s) applied in total.`)
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
