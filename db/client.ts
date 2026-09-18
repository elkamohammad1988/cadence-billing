import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

/**
 * Direct Postgres access via Drizzle.
 *
 * Read this before using it: this connection authenticates as the database
 * owner. **Row Level Security does not apply to it.** It is the equivalent of
 * the service-role key, and it is the right tool for exactly four callers:
 *
 *   1. the Stripe webhook handler
 *   2. the reconciliation job and the grace-period sweeper
 *   3. the /admin area
 *   4. migration and seed scripts
 *
 * Every one of those is triggered by Stripe, by cron, or by a platform admin —
 * never by an arbitrary user's request. Anything a signed-in user can cause to
 * run must go through `lib/supabase/server.ts`, which carries their JWT and is
 * therefore subject to the policies in
 * `supabase/migrations/20260101000400_rls.sql`.
 *
 * If you find yourself reaching for this client inside a route that a user can
 * hit, the tenancy check you are about to write by hand already exists in the
 * database. Use the other client.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cadenceSql: ReturnType<typeof postgres> | undefined
}

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. See .env.example.')
  }
  return url
}

/**
 * One pool per process. Cached on globalThis because Next.js re-evaluates
 * modules on every hot reload in development, and an uncached pool leaks a
 * connection per edit until Postgres refuses new ones.
 */
function getSql() {
  globalThis.__cadenceSql ??= postgres(connectionString(), {
    max: process.env.NODE_ENV === 'production' ? 10 : 3,
    // Supabase's connection pooler does not support prepared statements on the
    // transaction-mode port. Disabling them keeps the same code working
    // against both the direct port and the pooler.
    prepare: false,
    onnotice: () => {},
  })
  return globalThis.__cadenceSql
}

export const sql = getSql()

export const db = drizzle(sql, { schema, casing: 'snake_case' })

export type Database = typeof db
export { schema }
