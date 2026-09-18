-- ===========================================================================
-- 0005 — Plan catalogue
-- ===========================================================================
-- Packaging is a product decision, so it is versioned here rather than left to
-- a script. Pricing is not: `plan_prices` rows are written by
-- `pnpm stripe:sync-plans` from the Stripe catalogue, so an amount can change
-- without a migration or a deploy.
--
-- stripe_product_id is filled in by the same sync. Free has none — there is
-- nothing to charge for.
--
-- Limit semantics: NULL is unlimited.
--
-- Two judgement calls that are not dictated by the pricing table:
--
--   * AI is on from Pro upward. The brief only states that Free has no AI;
--     putting it on Starter would leave Pro's $30 step carrying nothing but
--     project headroom.
--   * max_workspaces for Pro is 10 and unlimited for Business. The brief
--     specifies workspace counts only for Free and Starter. Pro's ceiling
--     matches its seat count, which keeps the "a team, not an org" framing.
--
-- Both are one UPDATE away from being something else — that is the point of
-- keeping limits in a table.
-- ===========================================================================

insert into public.plans (
  key, name, tagline, sort_order,
  max_workspaces, max_projects, max_seats,
  ai_enabled, priority_support, seat_billing, trial_days
)
values
  (
    'free', 'Free', 'For trying Cadence out.', 0,
    1, 3, 1,
    false, false, false, 0
  ),
  (
    'starter', 'Starter', 'For a small team finding its rhythm.', 1,
    3, 25, 3,
    false, false, false, 0
  ),
  (
    'pro', 'Pro', 'For teams that live in it.', 2,
    10, null, 10,
    true, false, false, 14
  ),
  (
    'business', 'Business', 'For organisations that need seats to scale.', 3,
    null, null, null,
    true, true, true, 0
  );
