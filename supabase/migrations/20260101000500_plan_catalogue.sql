-- 0005 — Plan catalogue
--
-- Packaging is versioned here; pricing is not. `plan_prices` and
-- `stripe_product_id` are written by `pnpm stripe:sync-plans`, so an amount
-- changes without a deploy. See docs/ARCHITECTURE.md.
--
-- NULL on a limit column means unlimited. 0 would mean none allowed.
--
-- Two judgement calls the brief does not dictate: AI is on from Pro upward
-- (otherwise Pro's $30 step carries only project headroom), and Pro's
-- max_workspaces of 10 matches its seat count.

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
