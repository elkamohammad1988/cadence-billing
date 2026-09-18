-- ===========================================================================
-- 0001 — Tables
-- ===========================================================================
-- Naming: plural tables, `stripe_*_id` for every identifier that lives in
-- Stripe. Anything nullable is nullable because Stripe can legitimately not
-- send it, not because we were unsure.
-- ===========================================================================


-- --- Identity --------------------------------------------------------------

-- One row per auth.users row, created by a trigger. Application code never
-- reads auth.users directly; this is the public projection of it.
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  email              text        not null,
  full_name          text,
  avatar_url         text,
  -- Gate for /admin. Bootstrapped from ADMIN_EMAILS by the seed script.
  is_platform_admin  boolean     not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.profiles is
  'Public projection of auth.users. Application code reads this, never auth.users.';


-- --- Plan catalogue --------------------------------------------------------

-- Mirror of the Stripe product catalogue. The app reads limits from HERE, not
-- from constants in the codebase, so pricing and packaging can change without
-- a deploy. `pnpm stripe:sync-plans` keeps it in step with Stripe.
create table public.plans (
  id                 uuid        primary key default gen_random_uuid(),
  -- Stable identifier used in code. Never renamed, never reused.
  key                text        not null unique,
  name               text        not null,
  tagline            text,
  sort_order         integer     not null default 0,
  -- Null for the Free plan, which has no Stripe product.
  stripe_product_id  text        unique,

  -- Limits. NULL means unlimited. 0 would mean "none allowed" and is a
  -- different statement, so the distinction is load-bearing.
  max_workspaces     integer,
  max_projects       integer,
  max_seats          integer,

  -- Capability flags.
  ai_enabled         boolean     not null default false,
  priority_support   boolean     not null default false,

  -- When true the Stripe subscription item carries a quantity equal to the
  -- workspace's seat count, and seat changes push a quantity update.
  seat_billing       boolean     not null default false,

  -- 0 = no trial. Applied at Checkout; Stripe owns trial expiry, not us.
  trial_days         integer     not null default 0,

  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint plans_limits_nonnegative check (
    coalesce(max_workspaces, 0) >= 0
    and coalesce(max_projects, 0) >= 0
    and coalesce(max_seats, 0) >= 0
    and trial_days >= 0
  )
);

comment on column public.plans.max_projects is
  'NULL means unlimited. 0 means none allowed. The two are not the same.';


create table public.plan_prices (
  id                 uuid              primary key default gen_random_uuid(),
  plan_id            uuid              not null references public.plans (id) on delete cascade,
  "interval"         public.billing_interval not null,
  stripe_price_id    text              not null unique,
  -- Minor units, as Stripe stores them. 1900 = $19.00.
  unit_amount        integer           not null,
  currency           text              not null default 'usd',
  -- Mirrors Stripe's own `livemode`. Test-mode and live-mode price ids are
  -- different objects, and both need to exist here at once: going live must
  -- not mean destroying the test catalogue that every demo and every test
  -- depends on. Checkout picks the row matching the mode of the secret key
  -- in use.
  livemode           boolean           not null default false,
  is_active          boolean           not null default true,
  created_at         timestamptz       not null default now(),
  updated_at         timestamptz       not null default now(),

  constraint plan_prices_amount_nonnegative check (unit_amount >= 0)
);

-- A plan accumulates historical prices, but only one active price per interval
-- per mode — that is the one Checkout uses. Writes go through
-- app.set_active_plan_price(), which deactivates before inserting; doing it in
-- the other order collides with this index.
create unique index plan_prices_one_active_per_interval
  on public.plan_prices (plan_id, "interval", livemode)
  where is_active;

create index plan_prices_plan_id_idx on public.plan_prices (plan_id);


-- --- Tenancy ---------------------------------------------------------------

create table public.workspaces (
  id            uuid        primary key default gen_random_uuid(),
  slug          text        not null unique,
  name          text        not null,
  owner_id      uuid        not null references public.profiles (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,

  constraint workspaces_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);

comment on table public.workspaces is
  'The billing boundary. A subscription belongs to a workspace, never to a user.';

create index workspaces_owner_id_idx on public.workspaces (owner_id);


-- One row per seat. The seat count Stripe bills is the number of rows here.
create table public.workspace_members (
  id            uuid                  primary key default gen_random_uuid(),
  workspace_id  uuid                  not null references public.workspaces (id) on delete cascade,
  user_id       uuid                  not null references public.profiles (id) on delete cascade,
  role          public.workspace_role not null default 'member',
  invited_by    uuid                  references public.profiles (id) on delete set null,
  created_at    timestamptz           not null default now(),

  unique (workspace_id, user_id)
);

create index workspace_members_user_id_idx on public.workspace_members (user_id);
create index workspace_members_workspace_id_idx on public.workspace_members (workspace_id);


-- --- Product surface (deliberately thin) -----------------------------------

create table public.projects (
  id              uuid        primary key default gen_random_uuid(),
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  name            text        not null,
  description     text,
  created_by      uuid        references public.profiles (id) on delete set null,
  -- Set when a downgrade archives projects over the new plan's limit.
  archived_at     timestamptz,
  archived_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint projects_name_not_blank check (length(btrim(name)) > 0)
);

create index projects_workspace_id_idx on public.projects (workspace_id);
-- Supports the active-project count on the hot path of every insert.
create index projects_workspace_active_idx
  on public.projects (workspace_id)
  where archived_at is null;


create table public.notes (
  id            uuid        primary key default gen_random_uuid(),
  -- Denormalised from projects so RLS can scope without a join. Kept honest
  -- by a trigger; see 0003.
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  project_id    uuid        not null references public.projects (id) on delete cascade,
  title         text        not null,
  body          text        not null default '',
  created_by    uuid        references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index notes_project_id_idx on public.notes (project_id);
create index notes_workspace_id_idx on public.notes (workspace_id);


-- --- Billing ---------------------------------------------------------------

-- Resolves a Stripe customer to a workspace. The webhook handler needs this:
-- most events carry a customer id and nothing else that identifies the tenant.
create table public.billing_customers (
  workspace_id        uuid        primary key references public.workspaces (id) on delete cascade,
  stripe_customer_id  text        not null unique,
  email               text,
  name                text,
  -- Cached from Stripe for the billing page; never used for authorisation.
  default_card_brand  text,
  default_card_last4  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.billing_customers is
  'Stripe customer <-> workspace map. One customer per workspace, not per user.';


-- The single source of truth for "what is this workspace entitled to".
-- Exactly one row per workspace. Absence of a row means Free.
create table public.subscriptions (
  id                       uuid        primary key default gen_random_uuid(),
  workspace_id             uuid        not null unique references public.workspaces (id) on delete cascade,
  plan_id                  uuid        not null references public.plans (id) on delete restrict,
  price_id                 uuid        references public.plan_prices (id) on delete set null,

  source                   public.subscription_source not null default 'stripe',
  status                   public.subscription_status not null,

  stripe_customer_id       text,
  stripe_subscription_id   text        unique,
  -- Needed to push seat quantity changes without re-reading the subscription.
  stripe_item_id           text,

  -- Seats billed. 1 for plans that are not seat-billed.
  quantity                 integer     not null default 1,

  current_period_start     timestamptz,
  current_period_end       timestamptz,

  cancel_at_period_end     boolean     not null default false,
  cancel_at                timestamptz,
  canceled_at              timestamptz,
  ended_at                 timestamptz,

  trial_start              timestamptz,
  trial_end                timestamptz,

  -- Dunning. Set when an invoice first fails, cleared on recovery. When now()
  -- passes this while status is past_due, the sweeper downgrades to Free.
  grace_period_ends_at     timestamptz,

  -- A downgrade that takes effect at period end. The UI reads these to show
  -- "Pro until Nov 3, then Starter".
  scheduled_plan_id        uuid        references public.plans (id) on delete set null,
  scheduled_price_id       uuid        references public.plan_prices (id) on delete set null,
  scheduled_change_at      timestamptz,

  -- Out-of-order delivery guard. Stripe does not guarantee ordering, so we
  -- record the `created` timestamp of the last event applied and refuse to
  -- apply anything older. See app.subscription_event_is_stale().
  last_event_at            timestamptz,
  last_event_id            text,

  -- Last time reconciliation confirmed this row against the Stripe API.
  reconciled_at            timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint subscriptions_quantity_positive check (quantity >= 1),

  -- A Stripe-sourced subscription must carry its Stripe identifiers. A manual
  -- grant must not pretend to have them.
  constraint subscriptions_stripe_ids_present check (
    source <> 'stripe'
    or (stripe_customer_id is not null and stripe_subscription_id is not null)
  ),
  constraint subscriptions_manual_has_no_stripe_sub check (
    source <> 'manual' or stripe_subscription_id is null
  )
);

create index subscriptions_status_idx on public.subscriptions (status);
create index subscriptions_stripe_customer_idx on public.subscriptions (stripe_customer_id);
create index subscriptions_plan_id_idx on public.subscriptions (plan_id);
-- Drives the grace-period sweeper.
create index subscriptions_grace_expiry_idx
  on public.subscriptions (grace_period_ends_at)
  where grace_period_ends_at is not null;
-- Drives the scheduled-downgrade sweeper.
create index subscriptions_scheduled_change_idx
  on public.subscriptions (scheduled_change_at)
  where scheduled_change_at is not null;


create table public.invoices (
  id                      uuid        primary key default gen_random_uuid(),
  workspace_id            uuid        not null references public.workspaces (id) on delete cascade,
  stripe_invoice_id       text        not null unique,
  stripe_subscription_id  text,
  number                  text,
  status                  public.invoice_status not null,
  -- Minor units.
  amount_due              integer     not null default 0,
  amount_paid             integer     not null default 0,
  amount_remaining        integer     not null default 0,
  subtotal                integer     not null default 0,
  total                   integer     not null default 0,
  currency                text        not null default 'usd',
  -- True when the line items include a proration adjustment. The demo shows
  -- this on the billing page after a mid-cycle upgrade.
  has_proration           boolean     not null default false,
  hosted_invoice_url      text,
  invoice_pdf             text,
  period_start            timestamptz,
  period_end              timestamptz,
  due_date                timestamptz,
  paid_at                 timestamptz,
  attempt_count           integer     not null default 0,
  next_payment_attempt    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index invoices_workspace_created_idx on public.invoices (workspace_id, created_at desc);
create index invoices_status_idx on public.invoices (status);


-- One row per failed payment attempt. Kept separate from `invoices` because
-- the admin failed-payments view needs attempt-level history, and because an
-- invoice that later succeeds should not erase the fact that it failed first.
create table public.payment_failures (
  id                    uuid        primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  stripe_invoice_id     text        not null,
  stripe_charge_id      text,
  amount_due            integer     not null default 0,
  currency              text        not null default 'usd',
  attempt_count         integer     not null default 1,
  -- Stripe's decline code, e.g. 'card_declined', 'insufficient_funds'.
  failure_code          text,
  failure_message       text,
  next_payment_attempt  timestamptz,
  occurred_at           timestamptz not null default now(),
  -- Set when a later invoice.paid clears this failure.
  resolved_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index payment_failures_workspace_idx on public.payment_failures (workspace_id, occurred_at desc);
create index payment_failures_unresolved_idx
  on public.payment_failures (occurred_at desc)
  where resolved_at is null;


-- --- Webhook plumbing ------------------------------------------------------

-- Idempotency ledger. The handler INSERTs the Stripe event id before doing any
-- work; a unique violation on stripe_event_id is the duplicate-delivery signal.
create table public.stripe_events (
  id                 uuid        primary key default gen_random_uuid(),
  -- Stripe's own event id (evt_…). The unique constraint here is the whole
  -- idempotency mechanism.
  stripe_event_id    text        not null unique,
  type               text        not null,
  api_version        text,
  -- Full event payload, so an event can be replayed without calling Stripe.
  payload            jsonb       not null,
  status             public.stripe_event_status not null default 'received',
  -- Resolved during processing; null when the customer is unknown to us.
  workspace_id       uuid        references public.workspaces (id) on delete set null,
  stripe_customer_id text,
  attempts           integer     not null default 0,
  -- Populated on the most recent failure. Cleared on a successful replay.
  error              text,
  error_detail       jsonb,
  duration_ms        integer,
  -- `created` from the Stripe event, used for ordering. Distinct from
  -- received_at, which is when it reached us.
  event_created_at   timestamptz not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  replay_count       integer     not null default 0,
  last_replayed_at   timestamptz,
  last_replayed_by   uuid        references public.profiles (id) on delete set null,

  constraint stripe_events_attempts_nonnegative check (attempts >= 0)
);

comment on table public.stripe_events is
  'Idempotency ledger and audit trail for webhook deliveries. The unique constraint on stripe_event_id is what makes duplicate delivery a no-op.';

create index stripe_events_status_idx on public.stripe_events (status, event_created_at desc);
create index stripe_events_type_idx on public.stripe_events (type, event_created_at desc);
create index stripe_events_workspace_idx on public.stripe_events (workspace_id, event_created_at desc);
create index stripe_events_failed_idx
  on public.stripe_events (event_created_at desc)
  where status = 'failed';


-- Per-attempt history. `stripe_events` holds current state; this holds how it
-- got there, which is what you actually need when debugging a replay.
create table public.stripe_event_attempts (
  id               uuid        primary key default gen_random_uuid(),
  event_id         uuid        not null references public.stripe_events (id) on delete cascade,
  attempt_number   integer     not null,
  status           public.stripe_event_status not null,
  error            text,
  error_detail     jsonb,
  duration_ms      integer,
  -- Null for the original delivery, set for an admin-initiated replay.
  triggered_by     uuid        references public.profiles (id) on delete set null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,

  unique (event_id, attempt_number)
);

create index stripe_event_attempts_event_idx
  on public.stripe_event_attempts (event_id, attempt_number desc);


-- --- Operations ------------------------------------------------------------

-- Single-row configuration table. These values live in the database, not in
-- env, so that changing the grace period is an admin action, not a deploy.
create table public.billing_config (
  id                        boolean     primary key default true,
  grace_period_days         integer     not null default 7,
  -- How many days before trial_end the trial_will_end reminder is surfaced.
  trial_reminder_days       integer     not null default 3,
  -- Downgrade policy when the target plan's project limit is exceeded.
  -- See docs/ARCHITECTURE.md for the rationale.
  downgrade_archives_excess boolean     not null default true,
  updated_at                timestamptz not null default now(),

  constraint billing_config_single_row check (id),
  constraint billing_config_grace_sane check (grace_period_days between 0 and 90)
);

insert into public.billing_config (id) values (true);


-- Append-only. Every privileged mutation writes here: manual plan grants,
-- webhook replays, forced downgrades, reconciliation repairs.
--
-- actor_id and workspace_id are deliberately NOT foreign keys.
--
-- Two reasons, one principled and one mechanical. The principled one: an audit
-- entry has to outlive its subject. "Who deleted this workspace, and why" is
-- precisely the question you ask after the workspace is gone, and a cascade or
-- a SET NULL destroys the answer at the moment it becomes interesting.
--
-- The mechanical one is what forces the issue. `on delete set null` is
-- implemented as an UPDATE against this table, and the append-only trigger
-- below rejects UPDATE from everyone. So an FK here does not merely lose
-- history — it makes `delete from workspaces` fail outright with
-- "audit_log is append-only", which is a baffling error to debug from the far
-- end of a cascade. `on delete cascade` fares no better: that is a DELETE, and
-- the same trigger rejects it.
--
-- Referential integrity is traded for durability on purpose. Reads join
-- leniently and tolerate a missing counterparty, which is why actor_email is
-- captured inline rather than resolved through the profile at read time.
create table public.audit_log (
  id           uuid        primary key default gen_random_uuid(),
  actor_type   public.audit_actor_type not null,
  actor_id     uuid,
  -- Captured at write time: the actor may later be deleted, and an audit trail
  -- that forgets who acted is not an audit trail.
  actor_email  text,
  workspace_id uuid,
  -- Dotted verb, e.g. 'billing.plan_granted', 'webhook.replayed'.
  action       text        not null,
  -- Required for manual overrides; the /admin form will not submit without it.
  reason       text,
  target_table text,
  target_id    text,
  before       jsonb,
  after        jsonb,
  metadata     jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_workspace_idx on public.audit_log (workspace_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);
