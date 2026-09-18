-- ===========================================================================
-- 0004 — Row Level Security
-- ===========================================================================
-- Every table in `public` has RLS enabled. Nothing is left open "because the
-- app checks it".
--
-- The privilege model has three roles:
--
--   anon          — unauthenticated. Reads the plan catalogue (the pricing
--                   page) and nothing else.
--   authenticated — a signed-in user. Everything they do is scoped to
--                   workspaces they are a member of. All user-initiated writes
--                   in the app go through this role.
--   service_role  — BYPASSES RLS entirely. Reserved for the webhook handler,
--                   the reconciliation job, the grace sweeper, the seed script
--                   and /admin. If a request could be triggered by a user, it
--                   must not use this role.
--
-- That last rule is the one that matters. RLS is only an enforcement layer for
-- code paths that run as `authenticated`; a server action that reaches for the
-- service-role client has opted out of every policy below. lib/supabase/*
-- makes the two clients visibly different so the choice is deliberate.
--
-- Table privileges are revoked wholesale and re-granted per table. Supabase's
-- default privileges hand anon and authenticated full DML on new tables in
-- `public`; relying on policies alone to claw that back leaves writable tables
-- one dropped policy away from being writable by anyone.
-- ===========================================================================

revoke all on all tables in schema public from anon, authenticated;

alter table public.profiles              enable row level security;
alter table public.plans                 enable row level security;
alter table public.plan_prices           enable row level security;
alter table public.workspaces            enable row level security;
alter table public.workspace_members     enable row level security;
alter table public.projects              enable row level security;
alter table public.notes                 enable row level security;
alter table public.billing_customers     enable row level security;
alter table public.subscriptions         enable row level security;
alter table public.invoices              enable row level security;
alter table public.payment_failures      enable row level security;
alter table public.stripe_events         enable row level security;
alter table public.stripe_event_attempts enable row level security;
alter table public.billing_config        enable row level security;
alter table public.audit_log             enable row level security;


-- --- profiles --------------------------------------------------------------
-- Visible to yourself, to people you share a workspace with (so member lists
-- can show names), and to platform admins.

grant select on public.profiles to authenticated;
-- is_platform_admin is deliberately absent: a user must not be able to grant
-- themselves admin by PATCHing their own profile row.
grant update (full_name, avatar_url) on public.profiles to authenticated;

create policy profiles_select_self_or_co_member on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or app.is_platform_admin()
    or exists (
      select 1
      from public.workspace_members mine
      join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
      where mine.user_id = (select auth.uid())
        and theirs.user_id = public.profiles.id
    )
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));


-- --- plans / plan_prices ---------------------------------------------------
-- The catalogue is public: the pricing page renders before sign-in. Writes are
-- service-role only — the catalogue is synced from Stripe, never edited by a
-- user.

grant select on public.plans to anon, authenticated;
grant select on public.plan_prices to anon, authenticated;

create policy plans_select_all on public.plans
  for select to anon, authenticated
  using (true);

create policy plan_prices_select_all on public.plan_prices
  for select to anon, authenticated
  using (true);


-- --- workspaces ------------------------------------------------------------

grant select, insert, delete on public.workspaces to authenticated;
-- owner_id is excluded: transferring ownership is a deliberate server action
-- with its own checks, not a column update.
grant update (name, slug, archived_at) on public.workspaces to authenticated;

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (app.is_workspace_member(id) or app.is_platform_admin());

-- The plan limit is part of the INSERT policy, not just the trigger, so an
-- over-limit create fails as a permission error rather than an exception —
-- and so the constraint is visible to anyone reading the policies.
create policy workspaces_insert_within_limit on public.workspaces
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and app.can_create_workspace((select auth.uid()))
  );

create policy workspaces_update_admin on public.workspaces
  for update to authenticated
  using (app.is_workspace_admin(id))
  with check (app.is_workspace_admin(id));

create policy workspaces_delete_owner on public.workspaces
  for delete to authenticated
  using (app.is_workspace_owner(id));


-- --- workspace_members -----------------------------------------------------
-- Seats. The INSERT policy is where the seat limit is enforced for anything
-- that talks to the database as the user.

grant select, insert, delete on public.workspace_members to authenticated;
grant update (role) on public.workspace_members to authenticated;

create policy workspace_members_select_member on public.workspace_members
  for select to authenticated
  using (app.is_workspace_member(workspace_id) or app.is_platform_admin());

create policy workspace_members_insert_within_limit on public.workspace_members
  for insert to authenticated
  with check (
    app.is_workspace_admin(workspace_id)
    and app.can_add_seat(workspace_id)
    -- Ownership is conferred by workspaces.owner_id and the trigger that
    -- follows it. It cannot be handed out by inserting a membership row.
    and role <> 'owner'
  );

create policy workspace_members_update_admin on public.workspace_members
  for update to authenticated
  using (app.is_workspace_admin(workspace_id) and role <> 'owner')
  with check (app.is_workspace_admin(workspace_id) and role <> 'owner');

-- An admin may remove a member; anyone may remove themselves. The owner's row
-- is immovable — deleting it would leave a workspace whose owner cannot see it.
create policy workspace_members_delete on public.workspace_members
  for delete to authenticated
  using (
    role <> 'owner'
    and (
      app.is_workspace_admin(workspace_id)
      or user_id = (select auth.uid())
    )
  );


-- --- projects --------------------------------------------------------------

grant select, insert, delete on public.projects to authenticated;
grant update (name, description, archived_at, archived_reason) on public.projects to authenticated;

create policy projects_select_member on public.projects
  for select to authenticated
  using (app.is_workspace_member(workspace_id));

create policy projects_insert_within_limit on public.projects
  for insert to authenticated
  with check (
    app.is_workspace_member(workspace_id)
    and app.can_add_project(workspace_id)
  );

-- Un-archiving is also a quota event; the trigger enforces it. The policy only
-- needs to establish tenancy.
create policy projects_update_member on public.projects
  for update to authenticated
  using (app.is_workspace_member(workspace_id))
  with check (app.is_workspace_member(workspace_id));

create policy projects_delete_admin on public.projects
  for delete to authenticated
  using (app.is_workspace_admin(workspace_id));


-- --- notes -----------------------------------------------------------------
-- workspace_id is set by a BEFORE trigger from the parent project, so the
-- check on project_id is the load-bearing one; the workspace_id clause guards
-- against the trigger being dropped.

grant select, insert, delete on public.notes to authenticated;
grant update (title, body, project_id) on public.notes to authenticated;

create policy notes_select_member on public.notes
  for select to authenticated
  using (app.is_workspace_member(workspace_id));

create policy notes_insert_member on public.notes
  for insert to authenticated
  with check (
    app.is_workspace_member(workspace_id)
    and exists (
      select 1
      from public.projects pr
      where pr.id = public.notes.project_id
        and app.is_workspace_member(pr.workspace_id)
    )
  );

create policy notes_update_member on public.notes
  for update to authenticated
  using (app.is_workspace_member(workspace_id))
  with check (app.is_workspace_member(workspace_id));

create policy notes_delete_member on public.notes
  for delete to authenticated
  using (app.is_workspace_member(workspace_id));


-- --- Billing data ----------------------------------------------------------
--
-- Split by sensitivity:
--
--   subscriptions    — every member reads it. Trial countdowns, "past due"
--                      banners and plan badges are part of the product surface,
--                      and the row holds no payment instrument.
--   billing_customers,
--   invoices,
--   payment_failures — workspace admins only. Amounts, card metadata and
--                      invoice URLs are not member-level information.
--
-- None of these tables has an INSERT, UPDATE or DELETE policy, and none grants
-- write privileges. They are written exclusively by the webhook handler and
-- the reconciliation job, both of which run as service_role. A user cannot
-- write their own subscription row under any code path, which is what makes
-- "the subscription table is the source of truth" a defensible claim.

grant select on public.subscriptions to authenticated;

create policy subscriptions_select_member on public.subscriptions
  for select to authenticated
  using (app.is_workspace_member(workspace_id) or app.is_platform_admin());


grant select on public.billing_customers to authenticated;

create policy billing_customers_select_admin on public.billing_customers
  for select to authenticated
  using (app.is_workspace_admin(workspace_id) or app.is_platform_admin());


grant select on public.invoices to authenticated;

create policy invoices_select_admin on public.invoices
  for select to authenticated
  using (app.is_workspace_admin(workspace_id) or app.is_platform_admin());


grant select on public.payment_failures to authenticated;

create policy payment_failures_select_admin on public.payment_failures
  for select to authenticated
  using (app.is_workspace_admin(workspace_id) or app.is_platform_admin());


-- --- Operational tables ----------------------------------------------------
--
-- The webhook log carries full Stripe payloads, which include customer email
-- addresses and amounts across every tenant. Platform admins only — and the
-- /admin area reads it through the service role in any case. The policies
-- exist so that a stray authenticated query returns nothing rather than
-- everything.

grant select on public.stripe_events to authenticated;

create policy stripe_events_select_platform_admin on public.stripe_events
  for select to authenticated
  using (app.is_platform_admin());


grant select on public.stripe_event_attempts to authenticated;

create policy stripe_event_attempts_select_platform_admin on public.stripe_event_attempts
  for select to authenticated
  using (app.is_platform_admin());


grant select on public.audit_log to authenticated;

-- A workspace admin can see what was done to their own workspace; a platform
-- admin sees everything. Entries with no workspace are platform-level.
create policy audit_log_select_scoped on public.audit_log
  for select to authenticated
  using (
    app.is_platform_admin()
    or (workspace_id is not null and app.is_workspace_admin(workspace_id))
  );


-- The grace period is rendered in the dunning banner, so every signed-in user
-- needs to read it. It is a single row of non-sensitive configuration.
grant select on public.billing_config to authenticated;

create policy billing_config_select_all on public.billing_config
  for select to authenticated
  using (true);


-- --- Re-grant the read model ----------------------------------------------
-- `revoke all on all tables` at the top of this file includes views, so the
-- grant issued alongside `workspace_entitlements` in 0002 has just been undone.
-- Re-issued here rather than moved, because the revoke has to come first: its
-- job is to clear Supabase's default privileges before anything is granted
-- back deliberately.
--
-- The view is security_invoker, so this grant does not widen anything — a
-- caller still sees only the workspaces their policies on `workspaces`,
-- `plans` and `subscriptions` already let them see.
grant select on public.workspace_entitlements to authenticated;
