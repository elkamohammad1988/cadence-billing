-- 0000 — Extensions, schemas and enumerated types
--
-- `app` holds the SECURITY DEFINER helpers that RLS policies call. It is
-- deliberately absent from PostgREST's exposed schema list, so nothing in it
-- is reachable over HTTP whatever key the caller holds.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;


-- Mirrors Stripe's subscription.status verbatim. Inventing a status would make
-- reconciliation a translation exercise.
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

-- 'manual' rows are admin grants: reconciliation leaves them alone.
create type public.subscription_source as enum ('stripe', 'manual');

create type public.workspace_role as enum ('owner', 'admin', 'member');

create type public.invoice_status as enum (
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void'
);

-- 'skipped' is not a failure: an event type we do not subscribe to, or a
-- customer we have never seen.
create type public.stripe_event_status as enum (
  'received',
  'processing',
  'processed',
  'failed',
  'skipped'
);

create type public.audit_actor_type as enum ('user', 'admin', 'system', 'webhook');
