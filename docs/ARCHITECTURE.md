# Architecture

> This document is being written alongside the code. Sections appear as the
> subsystems they describe are built. Right now it covers the plan catalogue
> and the entitlement layer.

## Where plan limits come from

A plan has two kinds of attribute, and they are owned by different systems.

**Packaging** — how many projects, how many seats, whether AI is on, how many
trial days. These live in `public.plans` and are written **only by
migrations**. `supabase/migrations/20260101000500_plan_catalogue.sql` is the
authoritative statement of what each tier includes.

**Catalogue binding** — Stripe product and price identifiers, and the amounts
charged. These live in `plans.stripe_product_id` and `public.plan_prices`, and
are written **only by `pnpm stripe:sync-plans`**, which reads them from Stripe.

### The rule

- `/admin` may grant a plan to a workspace, without payment, with an audit
  entry recording who did it and why.
- `/admin` may **not** edit the limits or flags on a plan.
- Changing what Pro includes is a migration and a deploy.
- Changing what Pro costs is a Stripe edit plus a sync, with no deploy.

### Why

An earlier draft had `plans` serving as both versioned reference data and
mutable runtime configuration. That combination drifts, and it drifts in a way
that is hard to see:

- An admin raises Pro's project limit through the UI. The database is now
  right and the migration is stale, and nothing records the change.
- Someone runs `db:reset && db:migrate`. The migration wins and silently
  reverts the limit.
- The answer to "what is Pro's project limit" now depends on whether the
  database has been reset since the last time anyone tuned it.

Splitting on the *ownership* line rather than the table line removes the
ambiguity. Limits are a product decision, they belong in version control, and
the review that comes with a pull request is exactly the review a packaging
change deserves. Prices genuinely do need to change without a deploy — a
promotion, a currency, a regional price — and those are the things Stripe is
the system of record for.

The per-workspace escape hatch is the manual grant. When support needs to give
an account Pro for a month, that is a fact about *that workspace*, not a change
to what Pro means, and it is recorded as such.

### Consequences

- `public.plans` has no write policy and no write grant for any role below
  `service_role`. Nothing in the app can change a limit.
- Adding a tier, or changing one, is a new migration. There is no upsert path
  in 0005; a later migration does its own `update`.
- `plan_prices` carries a `livemode` flag so that test-mode and live-mode
  price identifiers can coexist in one table. Going live does not mean
  destroying the test catalogue.

## Entitlement resolution

One function answers "what is this workspace entitled to right now", and
everything else calls it:

| Subscription state | Effective plan |
| --- | --- |
| no subscription row | `free` |
| `trialing`, `active` | the subscribed plan |
| `past_due`, within grace | the subscribed plan |
| `past_due`, past grace | `free` |
| `canceled`, `unpaid`, `paused` | `free` |
| `incomplete`, `incomplete_expired` | `free` |

`past_due` is evaluated against `now()` rather than trusting a background job
to have run. If the grace sweeper is down, access still expires on time; the
sweeper only makes the expiry durable.

This logic exists twice on purpose — `app.effective_plan_id()` in SQL and
`resolveEntitlements()` in TypeScript. The SQL copy backs the database-layer
enforcement; the TypeScript copy backs `can()`. They are tested against each
other rather than derived from one another, because the alternative is a round
trip to the database on every capability check.

## Enforcement layers

Three, deliberately:

1. **`can(workspace, capability)`** — server-side, in every server action and
   route handler. This is the layer that produces a legible refusal: a real
   status code and a message a user can act on.
2. **RLS `WITH CHECK`** — declarative, and the reason a leaked API call cannot
   exceed a plan. Produces a permission error rather than a friendly one.
3. **`BEFORE INSERT` triggers with an advisory lock** — closes the
   count-then-insert race that layers 1 and 2 both have. Two concurrent
   inserts can each observe "2 projects, limit 3" and both commit; only a lock
   prevents landing at 4.

Layer 1 is what users see. Layers 2 and 3 are what make layer 1's claim true
when someone skips the UI. None of the three is redundant, and the cost of
stating the same rule three times is accepted.
