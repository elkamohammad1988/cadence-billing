-- ===========================================================================
-- 0003 — Triggers
-- ===========================================================================
-- Two kinds live here:
--
--   * housekeeping    — updated_at, profile creation, denormalisation
--   * limit enforcement — the serialised half of entitlement enforcement
--
-- On the second: an RLS WITH CHECK clause that counts rows is racy. Two
-- concurrent inserts can both observe "2 projects, limit 3" and both commit,
-- landing at 4. The policy is still worth having — it produces a clean
-- permission-denied and documents intent — but the trigger is what makes the
-- limit true. It takes a transaction-scoped advisory lock keyed on the
-- workspace, so concurrent inserts into the same workspace serialise while
-- inserts into different workspaces do not contend.
--
-- Error codes (class CD is unused by the SQL standard, so these cannot be
-- confused with a built-in failure):
--   CD001  project limit exceeded
--   CD002  seat limit exceeded
--   CD003  workspace limit exceeded
--   CD004  plan could not be resolved (fail-closed; should never fire)
-- ===========================================================================


-- --- Housekeeping ----------------------------------------------------------

create or replace function app.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function app.set_updated_at();

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function app.set_updated_at();

create trigger plan_prices_set_updated_at
  before update on public.plan_prices
  for each row execute function app.set_updated_at();

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function app.set_updated_at();

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function app.set_updated_at();

create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function app.set_updated_at();

create trigger billing_customers_set_updated_at
  before update on public.billing_customers
  for each row execute function app.set_updated_at();

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function app.set_updated_at();

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function app.set_updated_at();

create trigger billing_config_set_updated_at
  before update on public.billing_config
  for each row execute function app.set_updated_at();


-- Every auth.users row gets a profile. Doing this in the database rather than
-- in a signup handler means a user created through any path — the Supabase
-- dashboard, the admin API, the seed script — still ends up with a profile.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();


-- Backfill for accounts that predate this trigger.
--
-- The trigger only fires on INSERT, so on a Supabase project that already has
-- users — which a hosted development project generally does — every one of
-- them would be left without a profile, and the first thing they would hit is
-- a foreign key violation on workspaces.owner_id. Running the backfill here
-- rather than in the seed script means it also covers a project migrated but
-- never seeded.
insert into public.profiles (id, email, full_name, avatar_url)
select u.id,
       coalesce(u.email, ''),
       nullif(u.raw_user_meta_data ->> 'full_name', ''),
       nullif(u.raw_user_meta_data ->> 'avatar_url', '')
  from auth.users u
on conflict (id) do nothing;


-- The owner is a member. Making this a trigger rather than two inserts in
-- application code removes the window in which a workspace exists with no
-- members and is therefore invisible to its own creator under RLS.
create or replace function app.add_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

create trigger workspaces_add_owner_member
  after insert on public.workspaces
  for each row execute function app.add_owner_as_member();


-- notes.workspace_id is denormalised so RLS can scope without joining through
-- projects. Derived here rather than trusted from the client, so it cannot be
-- forged into pointing at another tenant.
create or replace function app.notes_inherit_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select pr.workspace_id into v_workspace_id
  from public.projects pr
  where pr.id = new.project_id;

  if v_workspace_id is null then
    raise exception 'project % does not exist', new.project_id
      using errcode = '23503';
  end if;

  new.workspace_id := v_workspace_id;
  return new;
end;
$$;

create trigger notes_inherit_workspace
  before insert or update of project_id on public.notes
  for each row execute function app.notes_inherit_workspace();


-- Append-only audit trail. Enforced in the database because the whole point of
-- an audit entry is that the person being audited cannot remove it — and the
-- admin area runs with the service role, which bypasses RLS.
create or replace function app.reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only'
    using errcode = '42501';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.reject_mutation();


-- --- Limit enforcement -----------------------------------------------------

-- Escape hatch for privileged writes that legitimately need to land a row the
-- current plan would refuse: the seed building workspaces before their
-- subscriptions exist, reconciliation repairing a row to match Stripe, an
-- audited admin grant.
--
-- The only supported way in is app.begin_privileged_writes(). Callers never
-- touch the GUC; the helper sets it, and sets it transaction-locally.
--
-- What this guarantees, precisely:
--
--   * A caller arriving through PostgREST cannot bypass a limit, whatever key
--     it holds, because session_user is `authenticator` there rather than
--     `postgres`. Note this is a much smaller claim than it sounds: a request
--     holding the service-role key already bypasses all of RLS and can read
--     and write every tenant's billing data. Blocking it from exceeding a
--     project quota is not a security boundary, it is a guard against
--     accidental limit-busting from the REST path.
--
--   * A bypass cannot leak across a pooled connection. This is the property
--     worth having, and it is why the token is the transaction id rather than
--     a constant. Set the GUC session-wide by mistake and it authorises
--     nothing after the current transaction commits, because every later
--     transaction has a different id.
--
-- What it does not guarantee: anything at all against code that already holds
-- a direct `postgres` connection. Such code can call the helper itself. The
-- boundary is the connection, not the function.
--
-- session_user, not current_user: the callers are SECURITY DEFINER triggers,
-- and inside those current_user has already been rewritten to the function
-- owner (`postgres`), so reading it would return `postgres` for every caller
-- and pass for everyone. session_user is untouched by SECURITY DEFINER.
create or replace function app.begin_privileged_writes()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'privileged writes require a direct database connection'
      using errcode = '42501',
            detail = format('session_user is %L', session_user);
  end if;

  -- is_local => true is SET LOCAL. Called outside an explicit transaction it
  -- still applies, but only for that one statement, so the bypass simply does
  -- not reach any later INSERT. That is the correct failure mode.
  perform set_config('app.bypass_limits', pg_current_xact_id()::text, true);
end;
$$;

comment on function app.begin_privileged_writes() is
  'Opens a transaction-scoped bypass of the plan limit triggers. Direct postgres connections only. The token is the transaction id, so a leaked session-level setting authorises nothing.';

revoke execute on function app.begin_privileged_writes() from public;


create or replace function app.limits_bypassed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    session_user in ('postgres', 'supabase_admin')
      and current_setting('app.bypass_limits', true)
          = pg_current_xact_id_if_assigned()::text,
    false
  );
$$;

comment on function app.limits_bypassed() is
  'True only inside a transaction that called app.begin_privileged_writes(). Read by the limit triggers.';

revoke execute on function app.limits_bypassed() from public;
grant execute on function app.limits_bypassed() to service_role;


create or replace function app.enforce_project_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan  public.plans;
  v_count integer;
begin
  -- Only inserts and un-archiving consume quota. An update that leaves a
  -- project archived, or edits its name, must not be blocked by a limit the
  -- workspace already exceeds.
  if tg_op = 'UPDATE' and not (old.archived_at is not null and new.archived_at is null) then
    return new;
  end if;

  if app.limits_bypassed() then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('cadence:projects'), hashtext(new.workspace_id::text));

  v_plan := app.effective_plan(new.workspace_id);

  -- An unresolvable plan leaves every column of v_plan NULL, which the next
  -- test would read as "unlimited". Refuse instead: a limit check that cannot
  -- find the limit has failed, and failing open is how a plan limit quietly
  -- stops existing.
  if v_plan.id is null then
    raise exception 'could not resolve a plan for workspace %', new.workspace_id
      using errcode = 'CD004',
            hint = 'The plans table is missing the row with key = ''free''.';
  end if;

  if v_plan.max_projects is null then
    return new;
  end if;

  select count(*)::integer into v_count
  from public.projects pr
  where pr.workspace_id = new.workspace_id
    and pr.archived_at is null
    and pr.id is distinct from new.id;

  if v_count >= v_plan.max_projects then
    raise exception
      'project limit reached: the % plan allows % active project(s) and this workspace has %',
      v_plan.name, v_plan.max_projects, v_count
      using errcode = 'CD001',
            hint = 'Upgrade the plan or archive an existing project.';
  end if;

  return new;
end;
$$;

create trigger projects_enforce_limit
  before insert or update of archived_at on public.projects
  for each row execute function app.enforce_project_limit();


create or replace function app.enforce_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan  public.plans;
  v_count integer;
begin
  if app.limits_bypassed() then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('cadence:seats'), hashtext(new.workspace_id::text));

  v_plan := app.effective_plan(new.workspace_id);

  -- Same fail-closed reasoning as the project limit above.
  if v_plan.id is null then
    raise exception 'could not resolve a plan for workspace %', new.workspace_id
      using errcode = 'CD004',
            hint = 'The plans table is missing the row with key = ''free''.';
  end if;

  if v_plan.max_seats is null then
    return new;
  end if;

  select count(*)::integer into v_count
  from public.workspace_members m
  where m.workspace_id = new.workspace_id
    and m.id is distinct from new.id;

  if v_count >= v_plan.max_seats then
    raise exception
      'seat limit reached: the % plan allows % seat(s) and this workspace has %',
      v_plan.name, v_plan.max_seats, v_count
      using errcode = 'CD002',
            hint = 'Upgrade the plan or remove a member.';
  end if;

  return new;
end;
$$;

create trigger workspace_members_enforce_limit
  before insert on public.workspace_members
  for each row execute function app.enforce_seat_limit();


create or replace function app.enforce_workspace_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowance integer;
  v_count     integer;
begin
  if app.limits_bypassed() then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('cadence:workspaces'), hashtext(new.owner_id::text));

  v_allowance := app.user_workspace_allowance(new.owner_id);

  select count(*)::integer into v_count
  from public.workspaces w
  where w.owner_id = new.owner_id
    and w.archived_at is null
    and w.id is distinct from new.id;

  if v_count >= v_allowance then
    raise exception
      'workspace limit reached: this account may own % workspace(s) and already owns %',
      v_allowance, v_count
      using errcode = 'CD003',
            hint = 'Upgrade one of your existing workspaces to raise the limit.';
  end if;

  return new;
end;
$$;

create trigger workspaces_enforce_limit
  before insert on public.workspaces
  for each row execute function app.enforce_workspace_limit();
