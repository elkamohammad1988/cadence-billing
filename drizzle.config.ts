import 'dotenv/config'

import { defineConfig } from 'drizzle-kit'

/**
 * `drizzle-kit` is used for diffing and for Studio, not as the migration
 * runner. Migrations are hand-written SQL in `supabase/migrations/` so that
 * RLS policies, triggers and SECURITY DEFINER functions — none of which a
 * schema differ can express — live alongside the tables they protect.
 *
 * `pnpm db:generate` writes a proposed migration into `drizzle/` for review;
 * anything kept is moved into `supabase/migrations/` by hand.
 */
export default defineConfig({
  schema: './db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  },
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
})
