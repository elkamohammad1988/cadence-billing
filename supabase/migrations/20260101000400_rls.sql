-- 0004 — Row Level Security
--
-- Roles: `anon` reads the plan catalogue and nothing else. `authenticated` is
-- scoped to workspaces it belongs to, and every user-initiated write in the
-- app goes through it. `service_role` bypasses RLS entirely and is reserved
-- for the webhook handler, reconciliation, the sweeper, the seed and /admin.
--
-- The rule that matters: if a request can be triggered by a user, it must not
-- use service_role. A server action that reaches for the service-role client
-- has opted out of every policy in this file.
--
-- The blanket REVOKE is not belt-and-braces. Supabase's default privileges
-- hand anon and authenticated full DML on new tables in `public`, so relying
-- on policies alone leaves every table one dropped policy away from being
-- writable by anyone.

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


-- Visible to yourself, to workspace co-members, and to platform admins.
grant select on public.profiles to authenticated;
-- is_platform_admin is absent: a user must not be able to grant themselves
-- admin by PATCHing their own row.
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


-- Public: the pricing page renders before sign-in. No write policy at any
-- level below service_role.
grant select on public.plans to anon, authenticated;
grant select on public.plan_prices to anon, authenticated;

create policy plans_select_all on public.plans
  for select to anon, authenticated
  using (true);

create policy plan_prices_select_all on public.plan_prices
  for select to anon, authenticated
  using (true);


grant select, insert, delete on public.workspaces to authenticated;
-- owner_id is excluded: transferring ownership is a server action with its own
-- checks, not a column update.
grant update (name, slug, archived_at) on public.workspaces to authenticated;

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (app.is_workspace_member(id) or app.is_platform_admin());

-- Stated here as well as in the trigger so the limit is visible to anyone
-- reading the policies, and fails as a permission error.
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


-- Seats.
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
    -- Ownership comes from workspaces.owner_id, not from a membership row.
    and role <> 'owner'
  );

create policy workspace_members_update_admin on public.workspace_members
  for update to authenticated
  using (app.is_workspace_admin(workspace_id) and role <> 'owner')
  with check (app.is_workspace_admin(workspace_id) and role <> 'owner');

-- The owner's row is immovable: deleting it would leave a workspace its owner
-- cannot see.
create policy workspace_members_delete on public.workspace_members
  for delete to authenticated
  using (
    role <> 'owner'
    and (
      app.is_workspace_admin(workspace_id)
      or user_id = (select auth.uid())
    )
  );


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

-- Un-archiving is a quota event, enforced by the trigger; the policy only
-- establishes tenancy.
create policy projects_update_member on public.projects
  for update to authenticated
  using (app.is_workspace_member(workspace_id))
  with check (app.is_workspace_member(workspace_id));

create policy projects_delete_admin on public.projects
  for delete to authenticated
  using (app.is_workspace_admin(workspace_id));


-- workspace_id is set by a BEFORE trigger from the parent project, so the
-- project_id check is the load-bearing one; the workspace_id clause guards
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


-- Billing data, split by sensitivity: every member reads `subscriptions`
-- (trial countdowns and past-due banners are product surface, and the row
-- holds no payment instrument); amounts, card metadata and invoice URLs are
-- workspace-admin only.
--
-- None of these tables grants write privileges or has a write policy. They are
-- written only by the webhook handler and reconciliation, both service_role.
-- That is what makes "subscriptions is the source of truth" defensible.

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


-- The webhook log carries full Stripe payloads: customer emails and amounts
-- across every tenant. Platform admins only; the policy exists so a stray
-- authenticated query returns nothing rather than everything.
grant select on public.stripe_events to authenticated;

create policy stripe_events_select_platform_admin on public.stripe_events
  for select to authenticated
  using (app.is_platform_admin());


grant select on public.stripe_event_attempts to authenticated;

create policy stripe_event_attempts_select_platform_admin on public.stripe_event_attempts
  for select to authenticated
  using (app.is_platform_admin());


grant select on public.audit_log to authenticated;

-- Entries with no workspace are platform-level.
create policy audit_log_select_scoped on public.audit_log
  for select to authenticated
  using (
    app.is_platform_admin()
    or (workspace_id is not null and app.is_workspace_admin(workspace_id))
  );


-- Read by the dunning banner, so every signed-in user needs it.
grant select on public.billing_config to authenticated;

create policy billing_config_select_all on public.billing_config
  for select to authenticated
  using (true);


-- `revoke all on all tables` at the top of this file includes views, so the
-- grant issued with `workspace_entitlements` in 0002 has just been undone.
-- The view is security_invoker, so re-granting widens nothing.
grant select on public.workspace_entitlements to authenticated;
