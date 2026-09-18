-- ===========================================================================
-- 0000 — Extensions, schemas and enumerated types
-- ===========================================================================
-- `app` holds SECURITY DEFINER helper functions used by Row Level Security
-- policies. It is deliberately NOT in PostgREST's exposed schema list, so
-- nothing in here is reachable over the REST API — only from inside SQL.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;


-- --- Enumerated types ------------------------------------------------------

-- Mirrors Stripe's subscription.status verbatim. We never invent statuses:
-- the local row is a projection of Stripe, so the vocabulary has to match or
-- reconciliation becomes a translation exercise.
create type public.subscription_status as enum (
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused'
);

create type public.billing_interval as enum ('month', 'year');

-- 'stripe'  — the row is owned by Stripe; reconciliation may overwrite it.
-- 'manual'  — an admin granted this plan without payment. Reconciliation
--             leaves it alone; only an admin can revoke it.
create type public.subscription_source as enum ('stripe', 'manual');

create type public.workspace_role as enum ('owner', 'admin', 'member');

create type public.invoice_status as enum (
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void'
);

-- Lifecycle of a webhook delivery.
--   received   — persisted, not yet picked up
--   processing — a handler holds it (guards against concurrent delivery)
--   processed  — handler returned cleanly
--   failed     — handler threw; `error` is populated; replayable from /admin
--   skipped    — deliberately not handled (event type we do not subscribe to,
--                or a customer we do not know about). Not an error.
create type public.stripe_event_status as enum (
  'received',
  'processing',
  'processed',
  'failed',
  'skipped'
);

create type public.audit_actor_type as enum ('user', 'admin', 'system', 'webhook');
