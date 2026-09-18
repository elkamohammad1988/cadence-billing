-- ===========================================================================
-- 0002 — Helper functions (entitlement resolution and limit checks)
-- ===========================================================================
-- Everything here lives in the `app` schema, is SECURITY DEFINER, and pins
-- `search_path` to the empty string so that every reference must be schema
-- qualified. That combination is what makes these safe to call from an RLS
-- policy: a caller cannot shadow a table name and change what the check reads.
--
-- SECURITY DEFINER is also what prevents infinite recursion. A policy on
-- workspace_members that needed to query workspace_members would re-enter its
-- own policy; running the lookup as the definer skips RLS on the inner read.
--
-- These functions are the database half of entitlement enforcement. The
-- TypeScript `can()` helper is the application half. They resolve plans by the
-- same rules deliberately — see docs/ARCHITECTURE.md.
-- ===========================================================================


-- --- Identity and membership ----------------------------------------------

create or replace function app.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid();
$$;


create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_platform_admin
  );
$$;


create or replace function app.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
  );
$$;


-- Owner or admin. This is the bar for billing actions, seat changes and
-- destructive project operations.
create or replace function app.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;


create or replace function app.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = p_workspace_id
      and w.owner_id = auth.uid()
  );
$$;


-- --- Configuration ---------------------------------------------------------

create or replace function app.grace_period_days()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.grace_period_days from public.billing_config c limit 1), 7);
$$;


-- --- Entitlement resolution ------------------------------------------------
--
-- The one place that answers "which plan is this workspace actually on right
-- now". Every limit check and every capability check funnels through it.
--
--   no subscription row        -> free
--   trialing | active          -> the subscribed plan
--   past_due within grace      -> the subscribed plan (dunning keeps access)
--   past_due past grace        -> free (the sweeper will make this durable)
--   canceled | unpaid | paused -> free
--   incomplete*                -> free (initial payment never cleared)
--
-- past_due is evaluated against now() rather than trusting a background job to
-- have run. If the sweeper is down, access still expires on time.
create or replace function app.effective_plan_id(p_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select s.plan_id
      from public.subscriptions s
      where s.workspace_id = p_workspace_id
        and (
          s.status in ('trialing', 'active')
          or (
            s.status = 'past_due'
            and s.grace_period_ends_at is not null
            and s.grace_period_ends_at > now()
          )
        )
    ),
    (select p.id from public.plans p where p.key = 'free')
  );
$$;

comment on function app.effective_plan_id(uuid) is
  'Resolves the plan a workspace is entitled to right now. Mirrors resolveEntitlements() in lib/billing/entitlements.ts.';


create or replace function app.effective_plan(p_workspace_id uuid)
returns public.plans
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.plans p where p.id = app.effective_plan_id(p_workspace_id);
$$;


-- --- Usage counters --------------------------------------------------------

create or replace function app.workspace_project_count(p_workspace_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.projects pr
  where pr.workspace_id = p_workspace_id
    and pr.archived_at is null;
$$;

comment on function app.workspace_project_count(uuid) is
  'Archived projects do not count against the limit. That is what makes downgrade-by-archiving a coherent policy.';


create or replace function app.workspace_seat_count(p_workspace_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.workspace_members m
  where m.workspace_id = p_workspace_id;
$$;


-- The workspace limit is per user, not per workspace, because a workspace's
-- own plan cannot govern how many workspaces exist before it does.
--
-- Rule: a user may own up to the highest max_workspaces among the effective
-- plans of the workspaces they already own, with the Free plan's value as the
-- floor. Owning one Starter workspace therefore raises the ceiling to 3.
-- Being a *member* of someone else's workspace never counts against you.
create or replace function app.user_workspace_allowance(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce((select p.max_workspaces from public.plans p where p.key = 'free'), 1),
    coalesce(
      (
        select max(coalesce(pl.max_workspaces, 2147483647))
        from public.workspaces w
        join public.plans pl on pl.id = app.effective_plan_id(w.id)
        where w.owner_id = p_user_id
          and w.archived_at is null
      ),
      0
    )
  );
$$;


create or replace function app.user_owned_workspace_count(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.workspaces w
  where w.owner_id = p_user_id
    and w.archived_at is null;
$$;


-- --- Limit predicates ------------------------------------------------------
--
-- Used both in RLS WITH CHECK clauses (the declarative layer) and by the
-- BEFORE INSERT triggers in 0003 (the serialised layer). The policy gives a
-- clean permission denied; the trigger closes the race window between the
-- count and the insert. Both are needed: neither alone is correct.

create or replace function app.can_add_project(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (app.effective_plan(p_workspace_id)).max_projects is null then true
    else app.workspace_project_count(p_workspace_id)
         < (app.effective_plan(p_workspace_id)).max_projects
  end;
$$;


create or replace function app.can_add_seat(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (app.effective_plan(p_workspace_id)).max_seats is null then true
    else app.workspace_seat_count(p_workspace_id)
         < (app.effective_plan(p_workspace_id)).max_seats
  end;
$$;


create or replace function app.can_create_workspace(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.user_owned_workspace_count(p_user_id) < app.user_workspace_allowance(p_user_id);
$$;


create or replace function app.workspace_ai_enabled(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((app.effective_plan(p_workspace_id)).ai_enabled, false);
$$;


-- --- Webhook ordering ------------------------------------------------------
--
-- Stripe makes no ordering guarantee. A subscription.updated generated at
-- 12:00:05 can arrive after the one generated at 12:00:09 — usually because
-- the first delivery failed and was retried. Applying the older one would
-- silently roll the subscription back.
--
-- Ties (same `created` second) are applied: Stripe's resolution is one second,
-- and refusing a tie would drop legitimate rapid-fire updates. The handlers
-- are written so that re-applying the same state is harmless.
create or replace function app.subscription_event_is_stale(
  p_workspace_id uuid,
  p_event_created_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.workspace_id = p_workspace_id
      and s.last_event_at is not null
      and s.last_event_at > p_event_created_at
  );
$$;


-- --- Grants ----------------------------------------------------------------
-- `authenticated` needs EXECUTE because the policies that call these run as
-- the authenticated role. `anon` gets nothing: an unauthenticated caller has
-- no workspace context and no reason to probe usage counts.

grant execute on function
  app.current_user_id(),
  app.is_platform_admin(),
  app.is_workspace_member(uuid),
  app.is_workspace_admin(uuid),
  app.is_workspace_owner(uuid),
  app.grace_period_days(),
  app.effective_plan_id(uuid),
  app.effective_plan(uuid),
  app.workspace_project_count(uuid),
  app.workspace_seat_count(uuid),
  app.user_workspace_allowance(uuid),
  app.user_owned_workspace_count(uuid),
  app.can_add_project(uuid),
  app.can_add_seat(uuid),
  app.can_create_workspace(uuid),
  app.workspace_ai_enabled(uuid),
  app.subscription_event_is_stale(uuid, timestamptz)
to authenticated, service_role;


-- --- Read model ------------------------------------------------------------
--
-- security_invoker means the view is subject to the caller's RLS on the
-- underlying tables, so it cannot become a way to read another tenant's plan.
create or replace view public.workspace_entitlements
with (security_invoker = on)
as
select
  w.id                                   as workspace_id,
  w.slug,
  w.name,
  p.id                                   as plan_id,
  p.key                                  as plan_key,
  p.name                                 as plan_name,
  p.max_workspaces,
  p.max_projects,
  p.max_seats,
  p.ai_enabled,
  p.priority_support,
  p.seat_billing,
  s.status                               as subscription_status,
  s.source                               as subscription_source,
  s.current_period_end,
  s.cancel_at_period_end,
  s.trial_end,
  s.grace_period_ends_at,
  s.scheduled_plan_id,
  s.scheduled_change_at,
  app.workspace_project_count(w.id)      as project_count,
  app.workspace_seat_count(w.id)         as seat_count
from public.workspaces w
join public.plans p on p.id = app.effective_plan_id(w.id)
left join public.subscriptions s on s.workspace_id = w.id;

grant select on public.workspace_entitlements to authenticated, service_role;
