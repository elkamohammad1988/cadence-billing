import { z } from 'zod'

/**
 * Environment access, validated once.
 *
 * Split deliberately into two surfaces:
 *
 *   clientEnv  — safe to reference from a client component. Only NEXT_PUBLIC_*.
 *   serverEnv  — secrets. Throws if imported into a client bundle.
 *
 * The split is not cosmetic: `SUPABASE_SERVICE_ROLE_KEY` bypasses every Row
 * Level Security policy in the database. A build that accidentally ships it to
 * the browser has handed every tenant's billing data to every visitor, and no
 * amount of policy authoring undoes that. The guard below makes the mistake
 * fail at import time instead of in production.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith('pk_').optional(),
})

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().optional(),
  BILLING_GRACE_PERIOD_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  CRON_SECRET: z.string().optional(),
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
})

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, label: string): z.infer<T> {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    throw new Error(
      `Invalid ${label} environment.\n${formatIssues(result.error)}\n\n` +
        'Copy .env.example to .env.local (Next.js) and .env (CLI scripts), then fill the blanks.',
    )
  }
  return result.data
}

/**
 * Client-safe values. Next.js inlines `process.env.NEXT_PUBLIC_*` at build
 * time, so these must be referenced as literal property accesses rather than
 * looked up dynamically — hence the explicit object below.
 */
export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
})

let cachedServerEnv: z.infer<typeof serverSchema> | null = null

/**
 * Secrets. Call this from server code only. Lazy so that importing a module
 * that merely *mentions* server env does not break a client build, and so
 * that CLI scripts can load dotenv before the first access.
 */
export function serverEnv(): z.infer<typeof serverSchema> {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv() was called in the browser. Something imported a server-only module ' +
        'into a client component — find it and move the import behind a server action.',
    )
  }
  cachedServerEnv ??= parseOrThrow(serverSchema, 'server')
  return cachedServerEnv
}

export type ClientEnv = z.infer<typeof clientSchema>
export type ServerEnv = z.infer<typeof serverSchema>
