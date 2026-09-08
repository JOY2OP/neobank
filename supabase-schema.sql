-- Corgi Track 3: V0 Neobank schema for Supabase Postgres
-- Target: a fresh Supabase project. Paste this entire file into the SQL editor once.
-- This script is non-destructive: it contains no DROP, TRUNCATE, UPDATE, or DELETE.

begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Stable primitives use enums. Provider, rail, and entry-kind vocabularies remain
-- data-driven so new adapters and accounting products do not require enum changes.
create type public.actor_kind as enum ('HUMAN', 'AGENT', 'SYSTEM', 'PROVIDER');
create type public.member_role as enum ('OWNER', 'ADMIN', 'MAKER', 'APPROVER', 'VIEWER');
create type public.environment_kind as enum ('TEST', 'SANDBOX', 'SIMULATED');
create type public.processing_outcome as enum ('SUCCEEDED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE');
create type public.account_class as enum ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
create type public.posting_side as enum ('DEBIT', 'CREDIT');
create type public.payment_direction as enum ('INBOUND', 'OUTBOUND', 'INTERNAL');
create type public.approval_decision as enum ('APPROVED', 'REJECTED');
create type public.reconciliation_break_type as enum ('IN_FILE_NOT_LEDGER', 'IN_LEDGER_NOT_FILE', 'AMOUNT_MISMATCH');

-- -----------------------------------------------------------------------------
-- Providers and payment rails
-- -----------------------------------------------------------------------------

create table public.providers (
  code text primary key check (code = lower(code) and code ~ '^[a-z0-9_]+$'),
  display_name text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table public.payment_rails (
  code text primary key check (code = upper(code) and code ~ '^[A-Z0-9_]+$'),
  display_name text not null,
  created_at timestamptz not null default clock_timestamp()
);

-- Reference/configuration rows, not demo customer data.
insert into public.providers (code, display_name) values
  ('stripe', 'Stripe'),
  ('persona', 'Persona'),
  ('plaid', 'Plaid'),
  ('increase', 'Increase'),
  ('circle', 'Circle'),
  ('bridge', 'Bridge'),
  ('simulator', 'V0 Simulator')
on conflict (code) do nothing;

insert into public.payment_rails (code, display_name) values
  ('ACH', 'Automated Clearing House'),
  ('CARD', 'Card Network'),
  ('USDC', 'USD Coin'),
  ('INTERNAL', 'Internal Ledger Transfer')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Identity, tenancy, and authorization
-- -----------------------------------------------------------------------------

create table public.actors (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  kind public.actor_kind not null,
  display_name text not null check (length(btrim(display_name)) > 0),
  created_at timestamptz not null default clock_timestamp()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null check (length(btrim(legal_name)) > 0),
  created_at timestamptz not null default clock_timestamp()
);

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_id uuid not null references public.actors(id) on delete restrict,
  role public.member_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (organization_id, actor_id)
);

create table public.organization_settings (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  approval_threshold_cents bigint not null default 100000 check (approval_threshold_cents >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

-- -----------------------------------------------------------------------------
-- Generic provider-event inbox
-- -----------------------------------------------------------------------------

create table public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null references public.providers(code) on delete restrict,
  provider_account text not null default 'default' check (length(btrim(provider_account)) > 0),
  environment public.environment_kind not null,
  external_event_id text not null check (length(btrim(external_event_id)) > 0),
  event_type text not null check (length(btrim(event_type)) > 0),
  provider_created_at timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  signature_verified boolean not null check (signature_verified),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  unique (provider_code, provider_account, environment, external_event_id)
);

create table public.provider_event_processing_attempts (
  id uuid primary key default gen_random_uuid(),
  provider_event_id uuid not null references public.provider_events(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  outcome public.processing_outcome not null,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz not null,
  error_code text,
  error_message text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  unique (provider_event_id, attempt_number),
  check (completed_at >= started_at)
);

-- -----------------------------------------------------------------------------
-- KYB and business accounts
-- -----------------------------------------------------------------------------

create table public.kyb_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  provider_code text not null references public.providers(code) on delete restrict,
  external_case_id text not null check (length(btrim(external_case_id)) > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider_code, external_case_id)
);

create table public.kyb_events (
  id uuid primary key default gen_random_uuid(),
  kyb_case_id uuid not null references public.kyb_cases(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  provider_status text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create table public.business_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  account_name text not null default 'Business checking' check (length(btrim(account_name)) > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  provider_account_reference text,
  created_at timestamptz not null default clock_timestamp()
);

create table public.business_account_events (
  id uuid primary key default gen_random_uuid(),
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  actor_id uuid references public.actors(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('OPENED', 'RESTRICTED', 'UNRESTRICTED', 'CLOSED')),
  reason_code text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create table public.external_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  provider_code text not null references public.providers(code) on delete restrict,
  provider_account_id text not null check (length(btrim(provider_account_id)) > 0),
  institution_name text,
  account_name text,
  account_mask text check (account_mask is null or account_mask ~ '^[0-9]{2,4}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider_code, provider_account_id)
);

create table public.external_bank_account_events (
  id uuid primary key default gen_random_uuid(),
  external_bank_account_id uuid not null references public.external_bank_accounts(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('LINKED', 'VERIFIED', 'FAILED', 'DISCONNECTED')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

-- -----------------------------------------------------------------------------
-- Immutable double-entry ledger
-- -----------------------------------------------------------------------------

create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique check (external_key ~ '^[A-Z0-9:_-]+$'),
  organization_id uuid references public.organizations(id) on delete restrict,
  business_account_id uuid references public.business_accounts(id) on delete restrict,
  parent_account_id uuid references public.ledger_accounts(id) on delete restrict,
  provider_code text references public.providers(code) on delete restrict,
  rail_code text references public.payment_rails(code) on delete restrict,
  account_class public.account_class not null,
  purpose text not null check (purpose ~ '^[A-Z0-9_]+$'),
  name text not null check (length(btrim(name)) > 0),
  is_primary boolean not null default false,
  currency text not null default 'USD' check (currency = 'USD'),
  created_at timestamptz not null default clock_timestamp(),
  check (business_account_id is null or organization_id is not null),
  check (not is_primary or (business_account_id is not null and purpose = 'CUSTOMER_DEPOSIT'))
);

create unique index ledger_accounts_business_purpose_uidx
  on public.ledger_accounts (business_account_id, purpose)
  where business_account_id is not null and is_primary;

create unique index ledger_accounts_platform_provider_purpose_uidx
  on public.ledger_accounts (provider_code, purpose)
  where business_account_id is null and provider_code is not null and rail_code is null;

create unique index ledger_accounts_platform_rail_purpose_uidx
  on public.ledger_accounts (rail_code, purpose)
  where business_account_id is null and rail_code is not null;

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  posting_key text not null unique check (length(btrim(posting_key)) > 0),
  idempotency_fingerprint text not null,
  entry_kind text not null check (entry_kind ~ '^[A-Z0-9_]+$'),
  currency text not null default 'USD' check (currency = 'USD'),
  value_date date not null,
  booked_at timestamptz not null default clock_timestamp(),
  description text not null check (length(btrim(description)) > 0),
  external_reference text,
  reversal_of_entry_id uuid references public.journal_entries(id) on delete restrict,
  created_by_actor_id uuid references public.actors(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create unique index journal_entries_one_reversal_uidx
  on public.journal_entries (reversal_of_entry_id)
  where reversal_of_entry_id is not null;

create table public.journal_postings (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  line_number smallint not null check (line_number > 0),
  ledger_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  side public.posting_side not null,
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (journal_entry_id, line_number)
);

-- -----------------------------------------------------------------------------
-- Cards, authorizations, holds, and settlements
-- -----------------------------------------------------------------------------

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  cardholder_actor_id uuid not null references public.actors(id) on delete restrict,
  provider_code text not null references public.providers(code) on delete restrict,
  provider_card_id text not null check (length(btrim(provider_card_id)) > 0),
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider_code, provider_card_id)
);

create table public.card_events (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete restrict,
  actor_id uuid references public.actors(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('ISSUED', 'ACTIVATED', 'FROZEN', 'UNFROZEN', 'CANCELLED')),
  reason_code text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create table public.card_authorizations (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete restrict,
  provider_code text not null references public.providers(code) on delete restrict,
  provider_authorization_id text not null check (length(btrim(provider_authorization_id)) > 0),
  merchant_name text,
  merchant_category_code text,
  currency text not null default 'USD' check (currency = 'USD'),
  first_seen_at timestamptz not null default clock_timestamp(),
  unique (provider_code, provider_authorization_id)
);

create table public.card_authorization_events (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references public.card_authorizations(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('AUTHORIZED', 'INCREMENTED', 'REVERSED', 'EXPIRED', 'DECLINED')),
  authorized_total_cents bigint check (authorized_total_cents is null or authorized_total_cents >= 0),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  check (
    (event_type in ('AUTHORIZED', 'INCREMENTED') and authorized_total_cents is not null)
    or (event_type not in ('AUTHORIZED', 'INCREMENTED'))
  )
);

create table public.card_hold_events (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references public.card_authorizations(id) on delete restrict,
  authorization_event_id uuid references public.card_authorization_events(id) on delete restrict,
  settlement_id uuid,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in (
    'AUTHORIZED', 'INCREMENTED', 'CAPTURE_RELEASE', 'FINAL_CAPTURE_RELEASE', 'AUTH_REVERSAL', 'EXPIRY'
  )),
  delta_cents bigint not null,
  is_terminal boolean not null default false,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check (
    (event_type in ('AUTHORIZED', 'INCREMENTED') and delta_cents > 0 and not is_terminal)
    or (event_type = 'CAPTURE_RELEASE' and delta_cents < 0 and not is_terminal)
    or (event_type in ('FINAL_CAPTURE_RELEASE', 'AUTH_REVERSAL', 'EXPIRY') and delta_cents <= 0 and is_terminal)
  )
);

create table public.card_settlements (
  id uuid primary key default gen_random_uuid(),
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  card_id uuid not null references public.cards(id) on delete restrict,
  provider_code text not null references public.providers(code) on delete restrict,
  provider_settlement_id text not null check (length(btrim(provider_settlement_id)) > 0),
  external_authorization_id text,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  value_date date not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  explicitly_force_posted boolean not null default false,
  is_final_capture boolean not null default true,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  unique (provider_code, provider_settlement_id)
);

alter table public.card_hold_events
  add constraint card_hold_events_settlement_fk
  foreign key (settlement_id) references public.card_settlements(id) on delete restrict;

create table public.card_settlement_events (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.card_settlements(id) on delete restrict,
  actor_id uuid references public.actors(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('RECEIVED', 'UNMATCHED', 'MATCHED', 'FORCE_POST_CLASSIFIED', 'POSTED', 'REVERSED', 'QUARANTINED')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create table public.card_settlement_matches (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null unique references public.card_settlements(id) on delete restrict,
  authorization_id uuid not null references public.card_authorizations(id) on delete restrict,
  matched_by_actor_id uuid references public.actors(id) on delete restrict,
  matching_method text not null check (matching_method in ('PROVIDER_REFERENCE', 'OPERATIONS')),
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  matched_at timestamptz not null default clock_timestamp()
);

create table public.card_settlement_journal_links (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.card_settlements(id) on delete restrict,
  journal_entry_id uuid not null unique references public.journal_entries(id) on delete restrict,
  link_type text not null check (link_type in ('POSTING', 'REVERSAL')),
  created_at timestamptz not null default clock_timestamp(),
  unique (settlement_id, link_type)
);

-- -----------------------------------------------------------------------------
-- Beneficiaries, payments, approval, ACH, and USDC
-- -----------------------------------------------------------------------------

create table public.beneficiaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  rail_code text not null references public.payment_rails(code) on delete restrict,
  display_name text not null check (length(btrim(display_name)) > 0),
  provider_recipient_reference text,
  account_mask text check (account_mask is null or account_mask ~ '^[0-9]{2,4}$'),
  wallet_address text,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (rail_code = 'ACH' and provider_recipient_reference is not null and wallet_address is null)
    or (rail_code = 'USDC' and wallet_address is not null)
    or (rail_code not in ('ACH', 'USDC'))
  )
);

create table public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  beneficiary_id uuid not null references public.beneficiaries(id) on delete restrict,
  rail_code text not null references public.payment_rails(code) on delete restrict,
  initiated_by_actor_id uuid not null references public.actors(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  approval_threshold_snapshot_cents bigint not null check (approval_threshold_snapshot_cents >= 0),
  requires_approval boolean not null,
  memo text,
  requested_execution_date date not null,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  created_at timestamptz not null default clock_timestamp()
);

create table public.payment_approval_events (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.payment_requests(id) on delete restrict,
  approver_actor_id uuid not null references public.actors(id) on delete restrict,
  decision public.approval_decision not null,
  reason text,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  decided_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (payment_request_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid unique references public.payment_requests(id) on delete restrict,
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  direction public.payment_direction not null,
  rail_code text not null references public.payment_rails(code) on delete restrict,
  provider_code text references public.providers(code) on delete restrict,
  provider_payment_id text,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider_code, provider_payment_id)
);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  actor_id uuid references public.actors(id) on delete restrict,
  provider_event_id uuid references public.provider_events(id) on delete restrict,
  journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in (
    'CREATED', 'SUBMITTED', 'PENDING', 'SETTLED', 'FAILED', 'CANCELLED', 'RETURNED', 'RECALLED', 'UNKNOWN'
  )),
  value_date date,
  reason_code text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create table public.payment_reservation_events (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.payment_requests(id) on delete restrict,
  payment_event_id uuid references public.payment_events(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('RESERVED', 'RELEASED', 'CONSUMED')),
  delta_cents bigint not null check (
    (event_type = 'RESERVED' and delta_cents > 0)
    or (event_type in ('RELEASED', 'CONSUMED') and delta_cents < 0)
  ),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp()
);

create table public.ach_payment_events (
  payment_event_id uuid primary key references public.payment_events(id) on delete restrict,
  provider_transfer_id text,
  ach_return_code text check (ach_return_code is null or ach_return_code ~ '^R[0-9]{2}$'),
  sec_code text,
  created_at timestamptz not null default clock_timestamp()
);

create table public.usdc_payment_events (
  payment_event_id uuid primary key references public.payment_events(id) on delete restrict,
  atomic_amount numeric(78, 0) not null check (atomic_amount > 0),
  asset_code text not null default 'USDC' check (asset_code = 'USDC'),
  network text not null check (length(btrim(network)) > 0),
  wallet_address text not null check (length(btrim(wallet_address)) > 0),
  quote_reference text,
  transaction_hash text,
  created_at timestamptz not null default clock_timestamp()
);

create unique index usdc_payment_events_network_tx_uidx
  on public.usdc_payment_events (network, transaction_hash)
  where transaction_hash is not null;

-- -----------------------------------------------------------------------------
-- Standing orders
-- -----------------------------------------------------------------------------

create table public.standing_orders (
  id uuid primary key default gen_random_uuid(),
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  beneficiary_id uuid not null references public.beneficiaries(id) on delete restrict,
  rail_code text not null references public.payment_rails(code) on delete restrict,
  created_by_actor_id uuid not null references public.actors(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  schedule_rule text not null check (length(btrim(schedule_rule)) > 0),
  starts_on date not null,
  ends_on date,
  created_at timestamptz not null default clock_timestamp(),
  check (ends_on is null or ends_on >= starts_on)
);

create table public.standing_order_events (
  id uuid primary key default gen_random_uuid(),
  standing_order_id uuid not null references public.standing_orders(id) on delete restrict,
  actor_id uuid not null references public.actors(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('CREATED', 'PAUSED', 'RESUMED', 'CANCELLED')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create table public.standing_order_occurrences (
  id uuid primary key default gen_random_uuid(),
  standing_order_id uuid not null references public.standing_orders(id) on delete restrict,
  scheduled_for date not null,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (standing_order_id, scheduled_for)
);

create table public.standing_order_attempt_events (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references public.standing_order_occurrences(id) on delete restrict,
  payment_request_id uuid references public.payment_requests(id) on delete restrict,
  attempt_number smallint not null check (attempt_number in (1, 2)),
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('STARTED', 'INSUFFICIENT_FUNDS', 'RETRY_SCHEDULED', 'SUBMITTED', 'UNKNOWN', 'FAILED')),
  retry_at timestamptz,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (occurrence_id, attempt_number, event_type),
  check (
    (event_type = 'RETRY_SCHEDULED' and attempt_number = 1 and retry_at is not null)
    or (event_type <> 'RETRY_SCHEDULED' and retry_at is null)
  )
);

-- -----------------------------------------------------------------------------
-- Statements and scheme reconciliation
-- -----------------------------------------------------------------------------

create table public.statement_versions (
  id uuid primary key default gen_random_uuid(),
  business_account_id uuid not null references public.business_accounts(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  version integer not null check (version > 0),
  knowledge_cutoff timestamptz not null,
  generated_at timestamptz not null default clock_timestamp(),
  content_hash text not null check (length(btrim(content_hash)) > 0),
  artifact_reference text,
  unique (business_account_id, period_start, period_end, version),
  check (period_end >= period_start)
);

create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null references public.providers(code) on delete restrict,
  settlement_date date not null,
  file_reference text not null check (length(btrim(file_reference)) > 0),
  file_hash text not null check (length(btrim(file_hash)) > 0),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (provider_code, file_hash)
);

create table public.reconciliation_file_rows (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references public.reconciliation_runs(id) on delete restrict,
  row_number integer not null check (row_number > 0),
  processor_reference text not null check (length(btrim(processor_reference)) > 0),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  value_date date not null,
  raw_row jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_row) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (reconciliation_run_id, row_number),
  unique (reconciliation_run_id, processor_reference)
);

create table public.reconciliation_results (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references public.reconciliation_runs(id) on delete restrict,
  break_fingerprint text not null check (length(btrim(break_fingerprint)) > 0),
  break_type public.reconciliation_break_type not null,
  file_row_id uuid references public.reconciliation_file_rows(id) on delete restrict,
  settlement_id uuid references public.card_settlements(id) on delete restrict,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  processor_reference text,
  file_amount_cents bigint,
  ledger_amount_cents bigint,
  detected_at timestamptz not null default clock_timestamp(),
  unique (reconciliation_run_id, break_fingerprint),
  check (file_amount_cents is null or file_amount_cents > 0),
  check (ledger_amount_cents is null or ledger_amount_cents > 0),
  check (
    (break_type = 'IN_FILE_NOT_LEDGER' and file_row_id is not null and journal_entry_id is null)
    or (break_type = 'IN_LEDGER_NOT_FILE' and file_row_id is null and journal_entry_id is not null)
    or (break_type = 'AMOUNT_MISMATCH' and file_row_id is not null and journal_entry_id is not null and file_amount_cents <> ledger_amount_cents)
  )
);

create table public.reconciliation_break_events (
  id uuid primary key default gen_random_uuid(),
  reconciliation_result_id uuid not null references public.reconciliation_results(id) on delete restrict,
  actor_id uuid references public.actors(id) on delete restrict,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  event_type text not null check (event_type in ('OPENED', 'ACKNOWLEDGED', 'RESOLVED', 'REOPENED')),
  note text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp()
);

-- -----------------------------------------------------------------------------
-- Supporting indexes
-- -----------------------------------------------------------------------------

create index organization_memberships_actor_idx on public.organization_memberships (actor_id) where is_active;
create index provider_events_received_idx on public.provider_events (received_at);
create index provider_attempts_event_idx on public.provider_event_processing_attempts (provider_event_id, attempt_number desc);
create index kyb_cases_org_idx on public.kyb_cases (organization_id);
create index kyb_events_case_latest_idx on public.kyb_events (kyb_case_id, recorded_at desc, id desc);
create index business_accounts_org_idx on public.business_accounts (organization_id);
create index business_account_events_latest_idx on public.business_account_events (business_account_id, recorded_at desc, id desc);
create index external_bank_accounts_org_idx on public.external_bank_accounts (organization_id);
create index journal_entries_bitemporal_idx on public.journal_entries (value_date, booked_at, id);
create index journal_postings_account_entry_idx on public.journal_postings (ledger_account_id, journal_entry_id);
create index cards_business_idx on public.cards (business_account_id);
create index card_events_latest_idx on public.card_events (card_id, recorded_at desc, id desc);
create index card_authorizations_card_idx on public.card_authorizations (card_id);
create index card_authorization_events_latest_idx on public.card_authorization_events (authorization_id, recorded_at desc, id desc);
create index card_hold_events_auth_idx on public.card_hold_events (authorization_id, recorded_at, id);
create index card_settlements_match_idx on public.card_settlements (provider_code, external_authorization_id) where external_authorization_id is not null;
create index card_settlement_events_latest_idx on public.card_settlement_events (settlement_id, recorded_at desc, id desc);
create index payment_requests_account_idx on public.payment_requests (business_account_id, created_at desc);
create index payment_events_latest_idx on public.payment_events (payment_id, recorded_at desc, id desc);
create index payment_reservations_request_idx on public.payment_reservation_events (payment_request_id, recorded_at, id);
create index payments_account_idx on public.payments (business_account_id, created_at desc);
create index standing_order_events_latest_idx on public.standing_order_events (standing_order_id, recorded_at desc, id desc);
create index reconciliation_results_fingerprint_idx on public.reconciliation_results (break_fingerprint, detected_at);
create index reconciliation_break_events_latest_idx on public.reconciliation_break_events (reconciliation_result_id, recorded_at desc, id desc);

-- -----------------------------------------------------------------------------
-- Append-only enforcement
-- -----------------------------------------------------------------------------

create or replace function private.reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception '% is append-only; % is forbidden', tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'provider_events', 'provider_event_processing_attempts',
    'kyb_cases', 'kyb_events', 'business_accounts', 'business_account_events',
    'external_bank_accounts', 'external_bank_account_events',
    'ledger_accounts', 'journal_entries', 'journal_postings',
    'cards', 'card_events', 'card_authorizations', 'card_authorization_events',
    'card_hold_events', 'card_settlements', 'card_settlement_events',
    'card_settlement_matches', 'card_settlement_journal_links',
    'payment_requests', 'payment_approval_events', 'payments', 'payment_events',
    'payment_reservation_events', 'ach_payment_events', 'usdc_payment_events',
    'standing_orders', 'standing_order_events', 'standing_order_occurrences',
    'standing_order_attempt_events', 'statement_versions',
    'reconciliation_runs', 'reconciliation_file_rows', 'reconciliation_results',
    'reconciliation_break_events'
  ]
  loop
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function private.reject_mutation()',
      'reject_mutation_' || table_name,
      table_name
    );
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Current-state projections. These views are rebuildable; source events are not.
-- -----------------------------------------------------------------------------

create view public.current_kyb_status
with (security_invoker = true)
as
select distinct on (kc.organization_id)
  kc.organization_id,
  kc.id as kyb_case_id,
  ke.event_type as status,
  ke.occurred_at,
  ke.recorded_at
from public.kyb_cases kc
join public.kyb_events ke on ke.kyb_case_id = kc.id
order by kc.organization_id, ke.recorded_at desc, ke.id desc;

create view public.current_business_account_status
with (security_invoker = true)
as
select distinct on (bae.business_account_id)
  bae.business_account_id,
  bae.event_type as status,
  bae.reason_code,
  bae.occurred_at,
  bae.recorded_at
from public.business_account_events bae
order by bae.business_account_id, bae.recorded_at desc, bae.id desc;

create view public.current_card_status
with (security_invoker = true)
as
select distinct on (ce.card_id)
  ce.card_id,
  ce.event_type as status,
  ce.reason_code,
  ce.occurred_at,
  ce.recorded_at
from public.card_events ce
order by ce.card_id, ce.recorded_at desc, ce.id desc;

create view public.current_payment_status
with (security_invoker = true)
as
select distinct on (pe.payment_id)
  pe.payment_id,
  pe.event_type as status,
  pe.reason_code,
  pe.value_date,
  pe.occurred_at,
  pe.recorded_at
from public.payment_events pe
order by pe.payment_id, pe.recorded_at desc, pe.id desc;

create view public.current_provider_event_status
with (security_invoker = true)
as
select
  pe.id as provider_event_id,
  coalesce(latest.outcome::text, 'RECEIVED') as status,
  latest.attempt_number,
  latest.completed_at,
  latest.error_code,
  latest.error_message
from public.provider_events pe
left join lateral (
  select pea.outcome, pea.attempt_number, pea.completed_at, pea.error_code, pea.error_message
  from public.provider_event_processing_attempts pea
  where pea.provider_event_id = pe.id
  order by pea.attempt_number desc, pea.id desc
  limit 1
) latest on true;

create view public.active_card_holds
with (security_invoker = true)
as
select
  ca.id as authorization_id,
  c.business_account_id,
  sum(he.delta_cents)::bigint as active_amount_cents,
  max(he.recorded_at) as last_recorded_at
from public.card_authorizations ca
join public.cards c on c.id = ca.card_id
join public.card_hold_events he on he.authorization_id = ca.id
group by ca.id, c.business_account_id
having sum(he.delta_cents) > 0
   and not bool_or(he.is_terminal);

create view public.active_payment_reservations
with (security_invoker = true)
as
select
  pr.id as payment_request_id,
  pr.business_account_id,
  sum(pre.delta_cents)::bigint as active_amount_cents,
  max(pre.recorded_at) as last_recorded_at
from public.payment_requests pr
join public.payment_reservation_events pre on pre.payment_request_id = pr.id
group by pr.id, pr.business_account_id
having sum(pre.delta_cents) > 0;

create view public.current_reconciliation_breaks
with (security_invoker = true)
as
with latest_break_event as (
  select distinct on (rbe.reconciliation_result_id)
    rbe.reconciliation_result_id,
    rbe.event_type,
    rbe.note,
    rbe.recorded_at
  from public.reconciliation_break_events rbe
  order by rbe.reconciliation_result_id, rbe.recorded_at desc, rbe.id desc
), first_seen as (
  select break_fingerprint, min(detected_at) as first_detected_at
  from public.reconciliation_results
  group by break_fingerprint
)
select
  rr.id as reconciliation_result_id,
  rr.reconciliation_run_id,
  rr.break_fingerprint,
  rr.break_type,
  rr.processor_reference,
  rr.file_amount_cents,
  rr.ledger_amount_cents,
  fs.first_detected_at,
  (current_date - fs.first_detected_at::date) as age_days,
  coalesce(lbe.event_type, 'OPENED') as status,
  lbe.note,
  lbe.recorded_at as status_recorded_at
from public.reconciliation_results rr
join first_seen fs on fs.break_fingerprint = rr.break_fingerprint
left join latest_break_event lbe on lbe.reconciliation_result_id = rr.id;

-- -----------------------------------------------------------------------------
-- Read helpers
-- -----------------------------------------------------------------------------

create or replace function public.account_balance_as_of(
  p_ledger_account_id uuid,
  p_value_date date default current_date,
  p_known_at timestamptz default 'infinity'::timestamptz
)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(
    case
      when la.account_class in ('ASSET', 'EXPENSE') and jp.side = 'DEBIT' then jp.amount_cents
      when la.account_class in ('ASSET', 'EXPENSE') and jp.side = 'CREDIT' then -jp.amount_cents
      when la.account_class in ('LIABILITY', 'EQUITY', 'REVENUE') and jp.side = 'CREDIT' then jp.amount_cents
      else -jp.amount_cents
    end
  ), 0)::bigint
  from public.ledger_accounts la
  left join public.journal_postings jp on jp.ledger_account_id = la.id
  left join public.journal_entries je
    on je.id = jp.journal_entry_id
   and je.value_date <= p_value_date
   and je.booked_at <= p_known_at
  where la.id = p_ledger_account_id
    and (jp.id is null or je.id is not null)
$$;

create or replace function private.available_balance(p_business_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select public.account_balance_as_of(la.id, current_date, 'infinity'::timestamptz)
      from public.ledger_accounts la
      where la.business_account_id = p_business_account_id
        and la.purpose = 'CUSTOMER_DEPOSIT'
        and la.is_primary
    ), 0)
    - coalesce((
      select sum(ach.active_amount_cents)
      from public.active_card_holds ach
      where ach.business_account_id = p_business_account_id
    ), 0)
    - coalesce((
      select sum(apr.active_amount_cents)
      from public.active_payment_reservations apr
      where apr.business_account_id = p_business_account_id
    ), 0)
$$;

create view public.business_account_balances
with (security_invoker = true)
as
select
  ba.id as business_account_id,
  coalesce(public.account_balance_as_of(la.id, current_date, 'infinity'::timestamptz), 0) as ledger_balance_cents,
  coalesce(h.held_cents, 0)::bigint as held_cents,
  coalesce(r.reserved_cents, 0)::bigint as reserved_cents,
  coalesce(pi.pending_incoming_cents, 0)::bigint as pending_incoming_cents,
  (
    coalesce(public.account_balance_as_of(la.id, current_date, 'infinity'::timestamptz), 0)
    - coalesce(h.held_cents, 0)
    - coalesce(r.reserved_cents, 0)
  )::bigint as available_balance_cents
from public.business_accounts ba
left join public.ledger_accounts la
 on la.business_account_id = ba.id
 and la.purpose = 'CUSTOMER_DEPOSIT'
 and la.is_primary
left join lateral (
  select sum(active_amount_cents)::bigint as held_cents
  from public.active_card_holds
  where business_account_id = ba.id
) h on true
left join lateral (
  select sum(active_amount_cents)::bigint as reserved_cents
  from public.active_payment_reservations
  where business_account_id = ba.id
) r on true
left join lateral (
  select sum(p.amount_cents)::bigint as pending_incoming_cents
  from public.payments p
  join public.current_payment_status cps on cps.payment_id = p.id
  where p.business_account_id = ba.id
    and p.direction = 'INBOUND'
    and cps.status in ('CREATED', 'SUBMITTED', 'PENDING', 'UNKNOWN')
) pi on true;

create or replace function public.statement_lines(
  p_business_account_id uuid,
  p_period_start date,
  p_period_end date,
  p_known_at timestamptz default 'infinity'::timestamptz
)
returns table (
  journal_entry_id uuid,
  posting_key text,
  entry_kind text,
  value_date date,
  booked_at timestamptz,
  description text,
  signed_amount_cents bigint,
  reversal_of_entry_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    je.id,
    je.posting_key,
    je.entry_kind,
    je.value_date,
    je.booked_at,
    je.description,
    case when jp.side = 'CREDIT' then jp.amount_cents else -jp.amount_cents end,
    je.reversal_of_entry_id
  from public.ledger_accounts la
  join public.journal_postings jp on jp.ledger_account_id = la.id
  join public.journal_entries je on je.id = jp.journal_entry_id
  where la.business_account_id = p_business_account_id
    and la.purpose = 'CUSTOMER_DEPOSIT'
    and la.is_primary
    and je.value_date between p_period_start and p_period_end
    and je.booked_at <= p_known_at
  order by je.value_date, je.booked_at, je.id, jp.line_number
$$;

-- -----------------------------------------------------------------------------
-- Atomic provider inbox and double-entry journal commands
-- -----------------------------------------------------------------------------

create or replace function public.ingest_provider_event(
  p_provider_code text,
  p_provider_account text,
  p_environment public.environment_kind,
  p_external_event_id text,
  p_event_type text,
  p_provider_created_at timestamptz,
  p_signature_verified boolean,
  p_payload jsonb
)
returns table (provider_event_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing_payload jsonb;
  v_inserted boolean := false;
begin
  if not coalesce(p_signature_verified, false) then
    raise exception 'provider event signature is not verified' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'provider payload must be a JSON object' using errcode = '22023';
  end if;

  insert into public.provider_events (
    provider_code, provider_account, environment, external_event_id,
    event_type, provider_created_at, signature_verified, payload
  ) values (
    p_provider_code, p_provider_account, p_environment, p_external_event_id,
    p_event_type, p_provider_created_at, true, p_payload
  )
  on conflict (provider_code, provider_account, environment, external_event_id) do nothing
  returning id into v_id;

  if v_id is not null then
    v_inserted := true;
  else
    select pe.id, pe.payload
      into v_id, v_existing_payload
    from public.provider_events pe
    where pe.provider_code = p_provider_code
      and pe.provider_account = p_provider_account
      and pe.environment = p_environment
      and pe.external_event_id = p_external_event_id;

    if v_existing_payload is distinct from p_payload then
      raise exception 'provider event id reused with a different payload' using errcode = '23505';
    end if;
  end if;

  return query select v_id, v_inserted;
end;
$$;

create or replace function public.record_provider_event_attempt(
  p_provider_event_id uuid,
  p_attempt_number integer,
  p_outcome public.processing_outcome,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_error_code text default null,
  p_error_message text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.provider_event_processing_attempts (
    provider_event_id, attempt_number, outcome, started_at, completed_at,
    error_code, error_message, details
  ) values (
    p_provider_event_id, p_attempt_number, p_outcome, p_started_at, p_completed_at,
    p_error_code, p_error_message, p_details
  )
  on conflict (provider_event_id, attempt_number) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
    from public.provider_event_processing_attempts
    where provider_event_id = p_provider_event_id
      and attempt_number = p_attempt_number;
  end if;
  return v_id;
end;
$$;

create or replace function public.post_journal_entry(
  p_posting_key text,
  p_entry_kind text,
  p_value_date date,
  p_description text,
  p_postings jsonb,
  p_external_reference text default null,
  p_reversal_of_entry_id uuid default null,
  p_created_by_actor_id uuid default null,
  p_provider_event_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_line_count integer;
  v_debits bigint;
  v_credits bigint;
  v_account_count integer;
begin
  if p_posting_key is null or length(btrim(p_posting_key)) = 0 then
    raise exception 'posting_key is required' using errcode = '22023';
  end if;
  if p_entry_kind is null or p_entry_kind !~ '^[A-Z0-9_]+$' then
    raise exception 'entry_kind must be an uppercase code' using errcode = '22023';
  end if;
  if p_value_date is null or p_description is null or length(btrim(p_description)) = 0 then
    raise exception 'value_date and description are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_postings) <> 'array' or jsonb_array_length(p_postings) < 2 then
    raise exception 'postings must be a JSON array with at least two lines' using errcode = '22023';
  end if;
  if jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be a JSON object' using errcode = '22023';
  end if;

  with lines as (
    select
      (item ->> 'ledger_account_id')::uuid as ledger_account_id,
      (item ->> 'side') as side,
      (item ->> 'amount_cents')::bigint as amount_cents
    from jsonb_array_elements(p_postings) as items(item)
  )
  select
    count(*),
    coalesce(sum(amount_cents) filter (where side = 'DEBIT'), 0),
    coalesce(sum(amount_cents) filter (where side = 'CREDIT'), 0),
    count(la.id)
  into v_line_count, v_debits, v_credits, v_account_count
  from lines l
  left join public.ledger_accounts la
    on la.id = l.ledger_account_id
   and la.currency = 'USD'
  where l.side in ('DEBIT', 'CREDIT')
    and l.amount_cents > 0;

  if v_line_count <> jsonb_array_length(p_postings)
     or v_account_count <> jsonb_array_length(p_postings) then
    raise exception 'every posting needs a valid USD account, DEBIT/CREDIT side, and positive integer cents'
      using errcode = '22023';
  end if;
  if v_debits <> v_credits then
    raise exception 'journal is unbalanced: debits %, credits %', v_debits, v_credits
      using errcode = '23514';
  end if;

  if p_reversal_of_entry_id is not null
     and not exists (select 1 from public.journal_entries where id = p_reversal_of_entry_id) then
    raise exception 'reversal target does not exist' using errcode = '23503';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.concat_ws('|',
    p_entry_kind,
    p_value_date::text,
    p_description,
    coalesce(p_external_reference, ''),
    coalesce(p_reversal_of_entry_id::text, ''),
    coalesce(p_created_by_actor_id::text, ''),
    coalesce(p_provider_event_id::text, ''),
    p_metadata::text,
    p_postings::text
  ));

  insert into public.journal_entries (
    posting_key, idempotency_fingerprint, entry_kind, value_date, description,
    external_reference, reversal_of_entry_id, created_by_actor_id,
    provider_event_id, metadata
  ) values (
    p_posting_key, v_fingerprint, p_entry_kind, p_value_date, p_description,
    p_external_reference, p_reversal_of_entry_id, p_created_by_actor_id,
    p_provider_event_id, p_metadata
  )
  on conflict (posting_key) do nothing
  returning id into v_entry_id;

  if v_entry_id is null then
    select je.id, je.idempotency_fingerprint
      into v_entry_id, v_existing_fingerprint
    from public.journal_entries je
    where je.posting_key = p_posting_key;

    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception 'posting_key reused with different journal content' using errcode = '23505';
    end if;
    return v_entry_id;
  end if;

  insert into public.journal_postings (
    journal_entry_id, line_number, ledger_account_id, side, amount_cents
  )
  select
    v_entry_id,
    item.ordinality::smallint,
    (item.value ->> 'ledger_account_id')::uuid,
    (item.value ->> 'side')::public.posting_side,
    (item.value ->> 'amount_cents')::bigint
  from jsonb_array_elements(p_postings) with ordinality as item(value, ordinality)
  order by item.ordinality;

  return v_entry_id;
end;
$$;

create or replace function public.reverse_journal_entry(
  p_original_entry_id uuid,
  p_posting_key text,
  p_value_date date,
  p_reason text,
  p_created_by_actor_id uuid default null,
  p_provider_event_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original public.journal_entries%rowtype;
  v_postings jsonb;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reversal reason is required' using errcode = '22023';
  end if;

  select * into v_original
  from public.journal_entries
  where id = p_original_entry_id;

  if not found then
    raise exception 'journal entry not found' using errcode = 'P0002';
  end if;

  select jsonb_agg(jsonb_build_object(
    'ledger_account_id', jp.ledger_account_id,
    'side', case when jp.side = 'DEBIT' then 'CREDIT' else 'DEBIT' end,
    'amount_cents', jp.amount_cents
  ) order by jp.line_number)
  into v_postings
  from public.journal_postings jp
  where jp.journal_entry_id = p_original_entry_id;

  return public.post_journal_entry(
    p_posting_key => p_posting_key,
    p_entry_kind => v_original.entry_kind || '_REVERSAL',
    p_value_date => p_value_date,
    p_description => 'Reversal: ' || p_reason,
    p_postings => v_postings,
    p_external_reference => v_original.external_reference,
    p_reversal_of_entry_id => p_original_entry_id,
    p_created_by_actor_id => p_created_by_actor_id,
    p_provider_event_id => p_provider_event_id,
    p_metadata => jsonb_build_object('reason', p_reason)
  );
end;
$$;

create or replace function public.create_ledger_account(
  p_external_key text,
  p_account_class public.account_class,
  p_purpose text,
  p_name text,
  p_organization_id uuid default null,
  p_business_account_id uuid default null,
  p_parent_account_id uuid default null,
  p_provider_code text default null,
  p_rail_code text default null,
  p_is_primary boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_org_id uuid;
begin
  if p_external_key is null or p_external_key !~ '^[A-Z0-9:_-]+$' then
    raise exception 'external_key must be an uppercase accounting key' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose !~ '^[A-Z0-9_]+$' then
    raise exception 'purpose must be an uppercase code' using errcode = '22023';
  end if;

  if p_business_account_id is not null then
    select organization_id into v_org_id
    from public.business_accounts
    where id = p_business_account_id;
    if not found then
      raise exception 'business account not found' using errcode = 'P0002';
    end if;
    if p_organization_id is distinct from v_org_id then
      raise exception 'ledger organization does not own the business account' using errcode = '23514';
    end if;
  end if;

  insert into public.ledger_accounts (
    external_key, organization_id, business_account_id, parent_account_id,
    provider_code, rail_code, account_class, purpose, name, is_primary
  ) values (
    p_external_key, p_organization_id, p_business_account_id, p_parent_account_id,
    p_provider_code, p_rail_code, p_account_class, p_purpose, p_name, p_is_primary
  )
  on conflict (external_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.ledger_accounts where external_key = p_external_key;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Card authorization and settlement commands
-- -----------------------------------------------------------------------------

create or replace function private.apply_card_settlement(
  p_settlement_id uuid,
  p_authorization_id uuid,
  p_matched_by_actor_id uuid,
  p_matching_method text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement public.card_settlements%rowtype;
  v_authorization public.card_authorizations%rowtype;
  v_existing_journal_id uuid;
  v_customer_account_id uuid;
  v_card_payable_account_id uuid;
  v_journal_id uuid;
  v_active_hold bigint := 0;
  v_terminal boolean := false;
  v_release bigint := 0;
  v_existing_match uuid;
begin
  select * into v_settlement
  from public.card_settlements
  where id = p_settlement_id
  for update;

  if not found then
    raise exception 'card settlement not found' using errcode = 'P0002';
  end if;

  select csjl.journal_entry_id into v_existing_journal_id
  from public.card_settlement_journal_links csjl
  where csjl.settlement_id = p_settlement_id
    and csjl.link_type = 'POSTING';

  if v_existing_journal_id is not null then
    return v_existing_journal_id;
  end if;

  if p_authorization_id is not null then
    select * into v_authorization
    from public.card_authorizations
    where id = p_authorization_id
    for update;

    if not found or v_authorization.card_id <> v_settlement.card_id then
      raise exception 'authorization does not belong to the settlement card' using errcode = '23514';
    end if;

    select authorization_id into v_existing_match
    from public.card_settlement_matches
    where settlement_id = p_settlement_id;

    if v_existing_match is not null and v_existing_match <> p_authorization_id then
      raise exception 'settlement is already matched to another authorization' using errcode = '23505';
    end if;

    insert into public.card_settlement_matches (
      settlement_id, authorization_id, matched_by_actor_id, matching_method, idempotency_key
    ) values (
      p_settlement_id, p_authorization_id, p_matched_by_actor_id, p_matching_method,
      'settlement-match:' || p_settlement_id::text
    )
    on conflict (settlement_id) do nothing;

    insert into public.card_settlement_events (
      settlement_id, actor_id, provider_event_id, idempotency_key,
      event_type, occurred_at, details
    ) values (
      p_settlement_id, p_matched_by_actor_id, v_settlement.provider_event_id,
      'settlement-matched:' || p_settlement_id::text,
      'MATCHED', clock_timestamp(),
      jsonb_build_object('authorization_id', p_authorization_id, 'method', p_matching_method)
    )
    on conflict (idempotency_key) do nothing;
  elsif not v_settlement.explicitly_force_posted then
    raise exception 'an unmatched non-force-post settlement must be matched before posting'
      using errcode = '23514';
  end if;

  select la.id into strict v_customer_account_id
  from public.ledger_accounts la
  where la.business_account_id = v_settlement.business_account_id
    and la.purpose = 'CUSTOMER_DEPOSIT'
    and la.is_primary;

  select la.id into strict v_card_payable_account_id
  from public.ledger_accounts la
  where la.business_account_id is null
    and la.provider_code = v_settlement.provider_code
    and la.rail_code is null
    and la.purpose = 'CARD_NETWORK_PAYABLE';

  v_journal_id := public.post_journal_entry(
    p_posting_key => 'card-settlement:' || v_settlement.provider_code || ':' || v_settlement.provider_settlement_id,
    p_entry_kind => case when v_settlement.explicitly_force_posted then 'CARD_FORCE_POST' else 'CARD_SETTLEMENT' end,
    p_value_date => v_settlement.value_date,
    p_description => case when v_settlement.explicitly_force_posted then 'Card force-post settlement' else 'Card settlement' end,
    p_postings => jsonb_build_array(
      jsonb_build_object('ledger_account_id', v_customer_account_id, 'side', 'DEBIT', 'amount_cents', v_settlement.amount_cents),
      jsonb_build_object('ledger_account_id', v_card_payable_account_id, 'side', 'CREDIT', 'amount_cents', v_settlement.amount_cents)
    ),
    p_external_reference => v_settlement.provider_settlement_id,
    p_provider_event_id => v_settlement.provider_event_id,
    p_metadata => jsonb_build_object('settlement_id', v_settlement.id)
  );

  insert into public.card_settlement_journal_links (settlement_id, journal_entry_id, link_type)
  values (p_settlement_id, v_journal_id, 'POSTING')
  on conflict (settlement_id, link_type) do nothing;

  if p_authorization_id is not null then
    select
      coalesce(sum(he.delta_cents), 0),
      coalesce(bool_or(he.is_terminal), false)
    into v_active_hold, v_terminal
    from public.card_hold_events he
    where he.authorization_id = p_authorization_id;

    if not v_terminal and (v_active_hold > 0 or v_settlement.is_final_capture) then
      v_release := case
        when v_settlement.is_final_capture then v_active_hold
        else least(v_active_hold, v_settlement.amount_cents)
      end;

      if v_release > 0 or v_settlement.is_final_capture then
        insert into public.card_hold_events (
          authorization_id, settlement_id, idempotency_key, event_type,
          delta_cents, is_terminal, occurred_at
        ) values (
          p_authorization_id,
          p_settlement_id,
          'settlement-hold-release:' || p_settlement_id::text,
          case when v_settlement.is_final_capture then 'FINAL_CAPTURE_RELEASE' else 'CAPTURE_RELEASE' end,
          -v_release,
          v_settlement.is_final_capture,
          v_settlement.occurred_at
        )
        on conflict (idempotency_key) do nothing;
      end if;
    end if;
  end if;

  insert into public.card_settlement_events (
    settlement_id, actor_id, provider_event_id, idempotency_key,
    event_type, occurred_at, details
  ) values (
    p_settlement_id, p_matched_by_actor_id, v_settlement.provider_event_id,
    'settlement-posted:' || p_settlement_id::text,
    'POSTED', clock_timestamp(),
    jsonb_build_object('journal_entry_id', v_journal_id)
  )
  on conflict (idempotency_key) do nothing;

  return v_journal_id;
exception
  when no_data_found then
    raise exception 'required CUSTOMER_DEPOSIT or CARD_NETWORK_PAYABLE ledger account is missing'
      using errcode = 'P0002';
  when too_many_rows then
    raise exception 'ledger account purpose is ambiguous' using errcode = '21000';
end;
$$;

create or replace function public.record_card_settlement(
  p_provider_code text,
  p_provider_settlement_id text,
  p_card_id uuid,
  p_external_authorization_id text,
  p_amount_cents bigint,
  p_value_date date,
  p_occurred_at timestamptz,
  p_explicit_force_post boolean,
  p_is_final_capture boolean,
  p_idempotency_key text,
  p_provider_event_id uuid default null,
  p_actor_id uuid default null
)
returns table (settlement_id uuid, settlement_state text, journal_entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement_id uuid;
  v_business_account_id uuid;
  v_card_provider text;
  v_authorization_id uuid;
  v_journal_id uuid;
begin
  if p_amount_cents <= 0 then
    raise exception 'settlement amount must be positive cents' using errcode = '22023';
  end if;

  select c.business_account_id, c.provider_code
    into v_business_account_id, v_card_provider
  from public.cards c
  where c.id = p_card_id;

  if not found or v_card_provider <> p_provider_code then
    raise exception 'card/provider mismatch' using errcode = '23514';
  end if;

  select cs.id into v_settlement_id
  from public.card_settlements cs
  where cs.idempotency_key = p_idempotency_key;

  if v_settlement_id is not null then
    select csjl.journal_entry_id into v_journal_id
    from public.card_settlement_journal_links csjl
    where csjl.settlement_id = v_settlement_id and csjl.link_type = 'POSTING';
    return query select v_settlement_id, case when v_journal_id is null then 'UNMATCHED' else 'POSTED' end, v_journal_id;
    return;
  end if;

  insert into public.card_settlements (
    business_account_id, card_id, provider_code, provider_settlement_id,
    external_authorization_id, amount_cents, value_date, occurred_at,
    explicitly_force_posted, is_final_capture, provider_event_id, idempotency_key
  ) values (
    v_business_account_id, p_card_id, p_provider_code, p_provider_settlement_id,
    p_external_authorization_id, p_amount_cents, p_value_date, p_occurred_at,
    p_explicit_force_post, p_is_final_capture, p_provider_event_id, p_idempotency_key
  )
  returning id into v_settlement_id;

  insert into public.card_settlement_events (
    settlement_id, actor_id, provider_event_id, idempotency_key, event_type, occurred_at
  ) values (
    v_settlement_id, p_actor_id, p_provider_event_id,
    'settlement-received:' || v_settlement_id::text, 'RECEIVED', p_occurred_at
  );

  if p_external_authorization_id is not null then
    select ca.id into v_authorization_id
    from public.card_authorizations ca
    where ca.provider_code = p_provider_code
      and ca.provider_authorization_id = p_external_authorization_id
      and ca.card_id = p_card_id;
  end if;

  if v_authorization_id is not null then
    v_journal_id := private.apply_card_settlement(
      v_settlement_id, v_authorization_id, p_actor_id, 'PROVIDER_REFERENCE'
    );
    return query select v_settlement_id, 'POSTED'::text, v_journal_id;
  elsif p_explicit_force_post then
    insert into public.card_settlement_events (
      settlement_id, actor_id, provider_event_id, idempotency_key, event_type, occurred_at
    ) values (
      v_settlement_id, p_actor_id, p_provider_event_id,
      'settlement-force-post:' || v_settlement_id::text, 'FORCE_POST_CLASSIFIED', p_occurred_at
    );
    v_journal_id := private.apply_card_settlement(
      v_settlement_id, null, p_actor_id, 'PROVIDER_REFERENCE'
    );
    return query select v_settlement_id, 'POSTED'::text, v_journal_id;
  else
    insert into public.card_settlement_events (
      settlement_id, actor_id, provider_event_id, idempotency_key, event_type, occurred_at
    ) values (
      v_settlement_id, p_actor_id, p_provider_event_id,
      'settlement-unmatched:' || v_settlement_id::text, 'UNMATCHED', p_occurred_at
    );
    return query select v_settlement_id, 'UNMATCHED'::text, null::uuid;
  end if;
end;
$$;

create or replace function public.match_parked_settlement(
  p_settlement_id uuid,
  p_authorization_id uuid,
  p_matched_by_actor_id uuid default null,
  p_matching_method text default 'PROVIDER_REFERENCE'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_matching_method not in ('PROVIDER_REFERENCE', 'OPERATIONS') then
    raise exception 'invalid matching method' using errcode = '22023';
  end if;
  return private.apply_card_settlement(
    p_settlement_id, p_authorization_id, p_matched_by_actor_id, p_matching_method
  );
end;
$$;

create or replace function public.record_authorization_event(
  p_provider_code text,
  p_provider_authorization_id text,
  p_card_id uuid,
  p_event_type text,
  p_authorized_total_cents bigint,
  p_occurred_at timestamptz,
  p_idempotency_key text,
  p_provider_event_id uuid default null,
  p_merchant_name text default null,
  p_merchant_category_code text default null,
  p_details jsonb default '{}'::jsonb
)
returns table (authorization_id uuid, active_hold_cents bigint, matched_settlement_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization_id uuid;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_current_hold bigint := 0;
  v_terminal boolean := false;
  v_capture_total bigint := 0;
  v_desired_hold bigint := 0;
  v_delta bigint := 0;
  v_previous_total bigint;
  v_matched_count integer := 0;
  v_settlement record;
begin
  if p_event_type not in ('AUTHORIZED', 'INCREMENTED', 'REVERSED', 'EXPIRED', 'DECLINED') then
    raise exception 'invalid authorization event type' using errcode = '22023';
  end if;
  if p_event_type in ('AUTHORIZED', 'INCREMENTED') and coalesce(p_authorized_total_cents, -1) < 0 then
    raise exception 'authorized total must be non-negative cents' using errcode = '22023';
  end if;

  select cae.id, cae.authorization_id
    into v_existing_event_id, v_authorization_id
  from public.card_authorization_events cae
  where cae.idempotency_key = p_idempotency_key;

  if v_existing_event_id is not null then
    select coalesce(sum(delta_cents), 0) into v_current_hold
    from public.card_hold_events he where he.authorization_id = v_authorization_id;
    return query select v_authorization_id, greatest(v_current_hold, 0), 0;
    return;
  end if;

  insert into public.card_authorizations (
    card_id, provider_code, provider_authorization_id,
    merchant_name, merchant_category_code, first_seen_at
  ) values (
    p_card_id, p_provider_code, p_provider_authorization_id,
    p_merchant_name, p_merchant_category_code, p_occurred_at
  )
  on conflict (provider_code, provider_authorization_id) do nothing
  returning id into v_authorization_id;

  if v_authorization_id is null then
    select ca.id into v_authorization_id
    from public.card_authorizations ca
    where ca.provider_code = p_provider_code
      and ca.provider_authorization_id = p_provider_authorization_id;
  end if;

  perform 1
  from public.card_authorizations ca
  where ca.id = v_authorization_id and ca.card_id = p_card_id
  for update;
  if not found then
    raise exception 'authorization/card mismatch' using errcode = '23514';
  end if;

  select cae.authorized_total_cents into v_previous_total
  from public.card_authorization_events cae
  where cae.authorization_id = v_authorization_id
    and cae.event_type in ('AUTHORIZED', 'INCREMENTED')
  order by cae.recorded_at desc, cae.id desc
  limit 1;

  if p_event_type = 'INCREMENTED'
     and v_previous_total is not null
     and p_authorized_total_cents < v_previous_total then
    raise exception 'incremental authorization cannot reduce the authorized total'
      using errcode = '23514';
  end if;

  insert into public.card_authorization_events (
    authorization_id, provider_event_id, idempotency_key, event_type,
    authorized_total_cents, occurred_at, details
  ) values (
    v_authorization_id, p_provider_event_id, p_idempotency_key, p_event_type,
    p_authorized_total_cents, p_occurred_at, p_details
  )
  returning id into v_event_id;

  if p_event_type in ('AUTHORIZED', 'INCREMENTED') then
    -- Match and post any settlement that arrived before this authorization.
    for v_settlement in
      select cs.id
      from public.card_settlements cs
      where cs.card_id = p_card_id
        and cs.provider_code = p_provider_code
        and cs.external_authorization_id = p_provider_authorization_id
        and not exists (
          select 1 from public.card_settlement_journal_links csjl
          where csjl.settlement_id = cs.id and csjl.link_type = 'POSTING'
        )
      order by cs.recorded_at, cs.id
    loop
      perform private.apply_card_settlement(
        v_settlement.id, v_authorization_id, null, 'PROVIDER_REFERENCE'
      );
      v_matched_count := v_matched_count + 1;
    end loop;

    select coalesce(sum(cs.amount_cents), 0) into v_capture_total
    from public.card_settlements cs
    join public.card_settlement_matches csm on csm.settlement_id = cs.id
    join public.card_settlement_journal_links csjl
      on csjl.settlement_id = cs.id and csjl.link_type = 'POSTING'
    where csm.authorization_id = v_authorization_id;

    select
      coalesce(sum(he.delta_cents), 0),
      coalesce(bool_or(he.is_terminal), false)
    into v_current_hold, v_terminal
    from public.card_hold_events he
    where he.authorization_id = v_authorization_id;

    if not v_terminal then
      v_desired_hold := greatest(p_authorized_total_cents - v_capture_total, 0);
      v_delta := v_desired_hold - v_current_hold;
      if v_delta > 0 then
        insert into public.card_hold_events (
          authorization_id, authorization_event_id, idempotency_key,
          event_type, delta_cents, is_terminal, occurred_at
        ) values (
          v_authorization_id, v_event_id,
          'authorization-hold:' || v_event_id::text,
          case when p_event_type = 'AUTHORIZED' then 'AUTHORIZED' else 'INCREMENTED' end,
          v_delta, false, p_occurred_at
        );
      elsif v_delta < 0 then
        raise exception 'authorization total would reduce an active hold without a release event'
          using errcode = '23514';
      end if;
    end if;
  elsif p_event_type in ('REVERSED', 'EXPIRED') then
    select
      coalesce(sum(he.delta_cents), 0),
      coalesce(bool_or(he.is_terminal), false)
    into v_current_hold, v_terminal
    from public.card_hold_events he
    where he.authorization_id = v_authorization_id;

    if not v_terminal then
      insert into public.card_hold_events (
        authorization_id, authorization_event_id, idempotency_key,
        event_type, delta_cents, is_terminal, occurred_at
      ) values (
        v_authorization_id, v_event_id,
        'authorization-terminal:' || v_event_id::text,
        case when p_event_type = 'REVERSED' then 'AUTH_REVERSAL' else 'EXPIRY' end,
        -v_current_hold, true, p_occurred_at
      );
    end if;
  end if;

  select coalesce(sum(delta_cents), 0) into v_current_hold
  from public.card_hold_events he where he.authorization_id = v_authorization_id;

  return query select v_authorization_id, greatest(v_current_hold, 0), v_matched_count;
end;
$$;

create or replace function public.reverse_card_settlement(
  p_settlement_id uuid,
  p_idempotency_key text,
  p_value_date date,
  p_reason text,
  p_actor_id uuid default null,
  p_provider_event_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement public.card_settlements%rowtype;
  v_original_journal_id uuid;
  v_reversal_journal_id uuid;
begin
  select * into v_settlement
  from public.card_settlements
  where id = p_settlement_id
  for update;
  if not found then
    raise exception 'card settlement not found' using errcode = 'P0002';
  end if;

  select journal_entry_id into v_reversal_journal_id
  from public.card_settlement_journal_links
  where settlement_id = p_settlement_id and link_type = 'REVERSAL';
  if v_reversal_journal_id is not null then
    return v_reversal_journal_id;
  end if;

  select journal_entry_id into v_original_journal_id
  from public.card_settlement_journal_links
  where settlement_id = p_settlement_id and link_type = 'POSTING';
  if v_original_journal_id is null then
    raise exception 'cannot reverse an unposted settlement' using errcode = '23514';
  end if;

  v_reversal_journal_id := public.reverse_journal_entry(
    p_original_entry_id => v_original_journal_id,
    p_posting_key => 'card-settlement-reversal:' || v_settlement.provider_code || ':' || v_settlement.provider_settlement_id,
    p_value_date => p_value_date,
    p_reason => p_reason,
    p_created_by_actor_id => p_actor_id,
    p_provider_event_id => p_provider_event_id
  );

  insert into public.card_settlement_journal_links (settlement_id, journal_entry_id, link_type)
  values (p_settlement_id, v_reversal_journal_id, 'REVERSAL');

  insert into public.card_settlement_events (
    settlement_id, actor_id, provider_event_id, idempotency_key,
    event_type, occurred_at, details
  ) values (
    p_settlement_id, p_actor_id, p_provider_event_id, p_idempotency_key,
    'REVERSED', clock_timestamp(),
    jsonb_build_object('journal_entry_id', v_reversal_journal_id, 'reason', p_reason)
  );

  return v_reversal_journal_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Payment approval and rail lifecycle commands
-- -----------------------------------------------------------------------------

create or replace function private.assert_business_transactable(p_business_account_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_kyb_status text;
  v_account_status text;
begin
  select organization_id into v_organization_id
  from public.business_accounts
  where id = p_business_account_id;
  if not found then
    raise exception 'business account not found' using errcode = 'P0002';
  end if;

  select status into v_kyb_status
  from public.current_kyb_status
  where organization_id = v_organization_id;

  select status into v_account_status
  from public.current_business_account_status
  where business_account_id = p_business_account_id;

  if v_kyb_status is distinct from 'APPROVED' then
    raise exception 'business is not KYB approved' using errcode = '42501';
  end if;
  if v_account_status not in ('OPENED', 'UNRESTRICTED') then
    raise exception 'business account is not transactable; current status is %', coalesce(v_account_status, 'NONE')
      using errcode = '42501';
  end if;
  return v_organization_id;
end;
$$;

create or replace function private.enforce_card_issuance_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_business_transactable(new.business_account_id);
  return new;
end;
$$;

create trigger enforce_card_issuance_gate
before insert on public.cards
for each row execute function private.enforce_card_issuance_gate();

create or replace function private.assert_active_member(
  p_organization_id uuid,
  p_actor_id uuid,
  p_allowed_roles public.member_role[] default null
)
returns public.actor_kind
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind public.actor_kind;
  v_role public.member_role;
begin
  select a.kind, om.role into v_kind, v_role
  from public.organization_memberships om
  join public.actors a on a.id = om.actor_id
  where om.organization_id = p_organization_id
    and om.actor_id = p_actor_id
    and om.is_active;
  if not found then
    raise exception 'actor is not an active organization member' using errcode = '42501';
  end if;
  if p_allowed_roles is not null and not (v_role = any(p_allowed_roles)) then
    raise exception 'actor role % is not permitted', v_role using errcode = '42501';
  end if;
  return v_kind;
end;
$$;

create or replace function public.create_payment_request(
  p_business_account_id uuid,
  p_beneficiary_id uuid,
  p_rail_code text,
  p_initiated_by_actor_id uuid,
  p_amount_cents bigint,
  p_requested_execution_date date,
  p_idempotency_key text,
  p_memo text default null
)
returns table (payment_request_id uuid, requires_approval boolean, request_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_organization_id uuid;
  v_beneficiary_org_id uuid;
  v_threshold bigint;
  v_actor_kind public.actor_kind;
  v_requires_approval boolean;
  v_existing public.payment_requests%rowtype;
begin
  if p_amount_cents <= 0 then
    raise exception 'payment amount must be positive cents' using errcode = '22023';
  end if;
  if p_rail_code not in ('ACH', 'USDC', 'INTERNAL') then
    raise exception 'unsupported outbound payment rail' using errcode = '22023';
  end if;

  select * into v_existing
  from public.payment_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.business_account_id <> p_business_account_id
       or v_existing.beneficiary_id <> p_beneficiary_id
       or v_existing.amount_cents <> p_amount_cents
       or v_existing.rail_code <> p_rail_code then
      raise exception 'payment idempotency key reused with different content' using errcode = '23505';
    end if;
    return query select v_existing.id, v_existing.requires_approval,
      case when v_existing.requires_approval then 'PENDING_APPROVAL' else 'READY_TO_SUBMIT' end;
    return;
  end if;

  select organization_id into v_organization_id
  from public.business_accounts
  where id = p_business_account_id
  for update;
  if not found then
    raise exception 'business account not found' using errcode = 'P0002';
  end if;
  perform private.assert_business_transactable(p_business_account_id);
  v_actor_kind := private.assert_active_member(v_organization_id, p_initiated_by_actor_id, null);

  select organization_id into v_beneficiary_org_id
  from public.beneficiaries where id = p_beneficiary_id;
  if v_beneficiary_org_id is distinct from v_organization_id then
    raise exception 'beneficiary does not belong to the organization' using errcode = '23514';
  end if;

  select coalesce(os.approval_threshold_cents, 100000) into v_threshold
  from (select v_organization_id as organization_id) x
  left join public.organization_settings os using (organization_id);

  v_requires_approval := v_actor_kind = 'AGENT' or p_amount_cents > v_threshold;

  if not v_requires_approval and private.available_balance(p_business_account_id) < p_amount_cents then
    raise exception 'insufficient available balance' using errcode = 'P0001';
  end if;

  insert into public.payment_requests (
    business_account_id, beneficiary_id, rail_code, initiated_by_actor_id,
    amount_cents, approval_threshold_snapshot_cents, requires_approval,
    memo, requested_execution_date, idempotency_key
  ) values (
    p_business_account_id, p_beneficiary_id, p_rail_code, p_initiated_by_actor_id,
    p_amount_cents, v_threshold, v_requires_approval,
    p_memo, p_requested_execution_date, p_idempotency_key
  ) returning id into v_request_id;

  if not v_requires_approval then
    insert into public.payment_reservation_events (
      payment_request_id, idempotency_key, event_type, delta_cents, occurred_at
    ) values (
      v_request_id, 'payment-reserve:' || v_request_id::text,
      'RESERVED', p_amount_cents, clock_timestamp()
    );
  end if;

  return query select v_request_id, v_requires_approval,
    case when v_requires_approval then 'PENDING_APPROVAL' else 'READY_TO_SUBMIT' end;
end;
$$;

create or replace function public.decide_payment_request(
  p_payment_request_id uuid,
  p_approver_actor_id uuid,
  p_decision public.approval_decision,
  p_idempotency_key text,
  p_reason text default null,
  p_decided_at timestamptz default clock_timestamp()
)
returns table (approval_event_id uuid, request_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.payment_requests%rowtype;
  v_organization_id uuid;
  v_actor_kind public.actor_kind;
  v_event_id uuid;
  v_existing public.payment_approval_events%rowtype;
begin
  select * into v_existing
  from public.payment_approval_events
  where idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, v_existing.decision::text;
    return;
  end if;

  select * into v_request
  from public.payment_requests
  where id = p_payment_request_id
  for update;
  if not found then
    raise exception 'payment request not found' using errcode = 'P0002';
  end if;
  if not v_request.requires_approval then
    raise exception 'payment request does not require approval' using errcode = '23514';
  end if;
  if v_request.initiated_by_actor_id = p_approver_actor_id then
    raise exception 'initiator cannot approve their own payment' using errcode = '42501';
  end if;

  select organization_id into v_organization_id
  from public.business_accounts where id = v_request.business_account_id;
  v_actor_kind := private.assert_active_member(
    v_organization_id,
    p_approver_actor_id,
    array['OWNER', 'ADMIN', 'APPROVER']::public.member_role[]
  );
  if v_actor_kind <> 'HUMAN' then
    raise exception 'only a human may approve a payment' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.payment_approval_events pae
    where pae.payment_request_id = p_payment_request_id
  ) then
    raise exception 'payment request already has a decision' using errcode = '23505';
  end if;

  if p_decision = 'APPROVED' then
    perform 1 from public.business_accounts where id = v_request.business_account_id for update;
    perform private.assert_business_transactable(v_request.business_account_id);
    if private.available_balance(v_request.business_account_id) < v_request.amount_cents then
      raise exception 'insufficient available balance at approval time' using errcode = 'P0001';
    end if;
  end if;

  insert into public.payment_approval_events (
    payment_request_id, approver_actor_id, decision, reason,
    idempotency_key, decided_at
  ) values (
    p_payment_request_id, p_approver_actor_id, p_decision, p_reason,
    p_idempotency_key, p_decided_at
  ) returning id into v_event_id;

  if p_decision = 'APPROVED' then
    insert into public.payment_reservation_events (
      payment_request_id, idempotency_key, event_type, delta_cents, occurred_at
    ) values (
      p_payment_request_id, 'payment-reserve:' || p_payment_request_id::text,
      'RESERVED', v_request.amount_cents, p_decided_at
    );
  end if;

  return query select v_event_id, p_decision::text;
end;
$$;

create or replace function public.record_payment_event(
  p_payment_idempotency_key text,
  p_event_idempotency_key text,
  p_business_account_id uuid,
  p_direction public.payment_direction,
  p_rail_code text,
  p_amount_cents bigint,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payment_request_id uuid default null,
  p_provider_code text default null,
  p_provider_payment_id text default null,
  p_provider_event_id uuid default null,
  p_actor_id uuid default null,
  p_value_date date default null,
  p_reason_code text default null,
  p_details jsonb default '{}'::jsonb,
  p_rail_details jsonb default '{}'::jsonb
)
returns table (payment_id uuid, payment_event_id uuid, journal_entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_request public.payment_requests%rowtype;
  v_event_id uuid;
  v_journal_id uuid;
  v_original_journal_id uuid;
  v_customer_account_id uuid;
  v_clearing_account_id uuid;
  v_active_reservation bigint := 0;
  v_existing_event public.payment_events%rowtype;
begin
  if p_amount_cents <= 0 then
    raise exception 'payment amount must be positive cents' using errcode = '22023';
  end if;
  if p_event_type not in ('CREATED', 'SUBMITTED', 'PENDING', 'SETTLED', 'FAILED', 'CANCELLED', 'RETURNED', 'RECALLED', 'UNKNOWN') then
    raise exception 'invalid payment event type' using errcode = '22023';
  end if;
  if p_event_type in ('SETTLED', 'RETURNED', 'RECALLED') and p_value_date is null then
    raise exception 'value_date is required for a financial payment event' using errcode = '22023';
  end if;
  if p_direction = 'OUTBOUND' and p_payment_request_id is null then
    raise exception 'outbound payments require an authorized payment request' using errcode = '23514';
  end if;

  select * into v_existing_event
  from public.payment_events
  where idempotency_key = p_event_idempotency_key;
  if found then
    return query select v_existing_event.payment_id, v_existing_event.id, v_existing_event.journal_entry_id;
    return;
  end if;

  perform 1 from public.business_accounts where id = p_business_account_id for update;
  if not found then
    raise exception 'business account not found' using errcode = 'P0002';
  end if;

  if p_payment_request_id is not null then
    select * into v_request from public.payment_requests where id = p_payment_request_id;
    if not found
       or v_request.business_account_id <> p_business_account_id
       or v_request.rail_code <> p_rail_code
       or v_request.amount_cents <> p_amount_cents then
      raise exception 'payment does not match its request' using errcode = '23514';
    end if;
    if v_request.requires_approval and not exists (
      select 1 from public.payment_approval_events pae
      where pae.payment_request_id = p_payment_request_id and pae.decision = 'APPROVED'
    ) then
      raise exception 'payment request has not been approved' using errcode = '42501';
    end if;
  end if;

  select * into v_payment
  from public.payments
  where idempotency_key = p_payment_idempotency_key;

  if not found then
    insert into public.payments (
      payment_request_id, business_account_id, direction, rail_code,
      provider_code, provider_payment_id, amount_cents, idempotency_key
    ) values (
      p_payment_request_id, p_business_account_id, p_direction, p_rail_code,
      p_provider_code, p_provider_payment_id, p_amount_cents, p_payment_idempotency_key
    ) returning * into v_payment;
  elsif v_payment.business_account_id <> p_business_account_id
     or v_payment.direction <> p_direction
     or v_payment.rail_code <> p_rail_code
     or v_payment.amount_cents <> p_amount_cents then
    raise exception 'payment idempotency key reused with different content' using errcode = '23505';
  end if;

  perform 1 from public.payments where id = v_payment.id for update;

  if p_event_type = 'SETTLED' then
    if exists (
      select 1 from public.payment_events pe
      where pe.payment_id = v_payment.id and pe.event_type = 'SETTLED'
    ) then
      raise exception 'payment is already settled' using errcode = '23505';
    end if;

    select id into strict v_customer_account_id
    from public.ledger_accounts
    where business_account_id = p_business_account_id
      and purpose = 'CUSTOMER_DEPOSIT'
      and is_primary;

    select id into strict v_clearing_account_id
    from public.ledger_accounts
    where business_account_id is null
      and rail_code = p_rail_code
      and purpose = 'RAIL_CLEARING';

    v_journal_id := public.post_journal_entry(
      p_posting_key => 'payment-settlement:' || v_payment.id::text,
      p_entry_kind => p_rail_code || '_SETTLEMENT',
      p_value_date => p_value_date,
      p_description => initcap(lower(p_rail_code)) || ' payment settlement',
      p_postings => case
        when p_direction = 'INBOUND' then jsonb_build_array(
          jsonb_build_object('ledger_account_id', v_clearing_account_id, 'side', 'DEBIT', 'amount_cents', p_amount_cents),
          jsonb_build_object('ledger_account_id', v_customer_account_id, 'side', 'CREDIT', 'amount_cents', p_amount_cents)
        )
        else jsonb_build_array(
          jsonb_build_object('ledger_account_id', v_customer_account_id, 'side', 'DEBIT', 'amount_cents', p_amount_cents),
          jsonb_build_object('ledger_account_id', v_clearing_account_id, 'side', 'CREDIT', 'amount_cents', p_amount_cents)
        )
      end,
      p_external_reference => p_provider_payment_id,
      p_created_by_actor_id => p_actor_id,
      p_provider_event_id => p_provider_event_id,
      p_metadata => jsonb_build_object('payment_id', v_payment.id, 'direction', p_direction)
    );
  elsif p_event_type in ('RETURNED', 'RECALLED') then
    if (p_event_type = 'RETURNED' and p_direction <> 'OUTBOUND')
       or (p_event_type = 'RECALLED' and p_direction <> 'INBOUND') then
      raise exception 'RETURNED is outbound and RECALLED is inbound' using errcode = '23514';
    end if;

    select pe.journal_entry_id into v_original_journal_id
    from public.payment_events pe
    where pe.payment_id = v_payment.id
      and pe.event_type = 'SETTLED'
      and pe.journal_entry_id is not null
    order by pe.recorded_at
    limit 1;
    if v_original_journal_id is null then
      raise exception 'cannot return or recall an unsettled payment' using errcode = '23514';
    end if;

    v_journal_id := public.reverse_journal_entry(
      p_original_entry_id => v_original_journal_id,
      p_posting_key => 'payment-' || lower(p_event_type) || ':' || v_payment.id::text,
      p_value_date => p_value_date,
      p_reason => coalesce(p_reason_code, p_event_type),
      p_created_by_actor_id => p_actor_id,
      p_provider_event_id => p_provider_event_id
    );
  end if;

  insert into public.payment_events (
    payment_id, actor_id, provider_event_id, journal_entry_id,
    idempotency_key, event_type, value_date, reason_code,
    occurred_at, details
  ) values (
    v_payment.id, p_actor_id, p_provider_event_id, v_journal_id,
    p_event_idempotency_key, p_event_type, p_value_date, p_reason_code,
    p_occurred_at, p_details
  ) returning id into v_event_id;

  if p_payment_request_id is not null then
    select coalesce(sum(delta_cents), 0) into v_active_reservation
    from public.payment_reservation_events
    where payment_request_id = p_payment_request_id;

    if p_event_type = 'SETTLED' and v_active_reservation > 0 then
      insert into public.payment_reservation_events (
        payment_request_id, payment_event_id, idempotency_key,
        event_type, delta_cents, occurred_at
      ) values (
        p_payment_request_id, v_event_id, 'payment-reservation-consume:' || v_payment.id::text,
        'CONSUMED', -v_active_reservation, p_occurred_at
      );
    elsif p_event_type in ('FAILED', 'CANCELLED') and v_active_reservation > 0 then
      insert into public.payment_reservation_events (
        payment_request_id, payment_event_id, idempotency_key,
        event_type, delta_cents, occurred_at
      ) values (
        p_payment_request_id, v_event_id, 'payment-reservation-release:' || v_payment.id::text,
        'RELEASED', -v_active_reservation, p_occurred_at
      );
    end if;
  end if;

  if p_rail_code = 'ACH' and p_rail_details <> '{}'::jsonb then
    insert into public.ach_payment_events (
      payment_event_id, provider_transfer_id, ach_return_code, sec_code
    ) values (
      v_event_id,
      p_rail_details ->> 'provider_transfer_id',
      p_rail_details ->> 'ach_return_code',
      p_rail_details ->> 'sec_code'
    );
  elsif p_rail_code = 'USDC' and p_rail_details <> '{}'::jsonb then
    insert into public.usdc_payment_events (
      payment_event_id, atomic_amount, network, wallet_address,
      quote_reference, transaction_hash
    ) values (
      v_event_id,
      (p_rail_details ->> 'atomic_amount')::numeric,
      p_rail_details ->> 'network',
      p_rail_details ->> 'wallet_address',
      p_rail_details ->> 'quote_reference',
      p_rail_details ->> 'transaction_hash'
    );
  end if;

  if p_event_type = 'RECALLED' and private.available_balance(p_business_account_id) < 0 then
    insert into public.business_account_events (
      business_account_id, actor_id, provider_event_id, idempotency_key,
      event_type, reason_code, occurred_at, details
    ) values (
      p_business_account_id, p_actor_id, p_provider_event_id,
      'negative-balance-restriction:' || v_payment.id::text,
      'RESTRICTED', coalesce(p_reason_code, 'INBOUND_RECALL'), p_occurred_at,
      jsonb_build_object('payment_id', v_payment.id)
    )
    on conflict (idempotency_key) do nothing;

    insert into public.card_events (
      card_id, actor_id, provider_event_id, idempotency_key,
      event_type, reason_code, occurred_at, details
    )
    select
      c.id, p_actor_id, p_provider_event_id,
      'negative-balance-card-freeze:' || v_payment.id::text || ':' || c.id::text,
      'FROZEN', 'NEGATIVE_BALANCE', p_occurred_at,
      jsonb_build_object('payment_id', v_payment.id)
    from public.cards c
    where c.business_account_id = p_business_account_id
    on conflict (idempotency_key) do nothing;
  end if;

  return query select v_payment.id, v_event_id, v_journal_id;
exception
  when no_data_found then
    raise exception 'required CUSTOMER_DEPOSIT or RAIL_CLEARING ledger account is missing'
      using errcode = 'P0002';
  when too_many_rows then
    raise exception 'ledger account purpose is ambiguous' using errcode = '21000';
end;
$$;

-- -----------------------------------------------------------------------------
-- Standing-order occurrence commands
-- -----------------------------------------------------------------------------

create or replace function public.create_standing_order_occurrence(
  p_standing_order_id uuid,
  p_scheduled_for date,
  p_idempotency_key text
)
returns table (occurrence_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_inserted boolean := false;
begin
  insert into public.standing_order_occurrences (
    standing_order_id, scheduled_for, idempotency_key
  ) values (
    p_standing_order_id, p_scheduled_for, p_idempotency_key
  )
  on conflict (standing_order_id, scheduled_for) do nothing
  returning id into v_id;

  if v_id is not null then
    v_inserted := true;
  else
    select id into v_id
    from public.standing_order_occurrences
    where standing_order_id = p_standing_order_id
      and scheduled_for = p_scheduled_for;
  end if;
  return query select v_id, v_inserted;
end;
$$;

create or replace function public.record_standing_order_attempt(
  p_occurrence_id uuid,
  p_attempt_number smallint,
  p_event_type text,
  p_occurred_at timestamptz,
  p_idempotency_key text,
  p_payment_request_id uuid default null,
  p_retry_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_attempt_number not in (1, 2) then
    raise exception 'standing-order attempts are limited to the initial attempt and one retry'
      using errcode = '22023';
  end if;
  if p_event_type not in ('STARTED', 'INSUFFICIENT_FUNDS', 'RETRY_SCHEDULED', 'SUBMITTED', 'UNKNOWN', 'FAILED') then
    raise exception 'invalid standing-order attempt event type' using errcode = '22023';
  end if;
  if p_event_type = 'RETRY_SCHEDULED'
     and (p_attempt_number <> 1 or p_retry_at is null or p_retry_at < p_occurred_at + interval '24 hours') then
    raise exception 'the single retry must be scheduled at least 24 hours after the first attempt'
      using errcode = '23514';
  end if;
  if p_attempt_number = 2 and not exists (
    select 1 from public.standing_order_attempt_events soae
    where soae.occurrence_id = p_occurrence_id
      and soae.attempt_number = 1
      and soae.event_type = 'RETRY_SCHEDULED'
  ) then
    raise exception 'second attempt requires a first-attempt retry schedule' using errcode = '23514';
  end if;

  insert into public.standing_order_attempt_events (
    occurrence_id, payment_request_id, attempt_number, idempotency_key,
    event_type, retry_at, occurred_at
  ) values (
    p_occurrence_id, p_payment_request_id, p_attempt_number, p_idempotency_key,
    p_event_type, p_retry_at, p_occurred_at
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.standing_order_attempt_events
    where idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS and least-privilege grants
-- -----------------------------------------------------------------------------

-- RLS is enabled even though V0 routes all access through the server. There are
-- deliberately no anon/authenticated policies: browser credentials see nothing.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'providers', 'payment_rails', 'actors', 'organizations',
    'organization_memberships', 'organization_settings',
    'provider_events', 'provider_event_processing_attempts',
    'kyb_cases', 'kyb_events', 'business_accounts', 'business_account_events',
    'external_bank_accounts', 'external_bank_account_events',
    'ledger_accounts', 'journal_entries', 'journal_postings',
    'cards', 'card_events', 'card_authorizations', 'card_authorization_events',
    'card_hold_events', 'card_settlements', 'card_settlement_events',
    'card_settlement_matches', 'card_settlement_journal_links',
    'beneficiaries', 'payment_requests', 'payment_approval_events', 'payments',
    'payment_events', 'payment_reservation_events', 'ach_payment_events',
    'usdc_payment_events', 'standing_orders', 'standing_order_events',
    'standing_order_occurrences', 'standing_order_attempt_events',
    'statement_versions', 'reconciliation_runs', 'reconciliation_file_rows',
    'reconciliation_results', 'reconciliation_break_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', table_name);
    execute format('grant select on table public.%I to service_role', table_name);
  end loop;
end;
$$;

-- Server-side configuration and operational ingestion may append these records.
-- Financial state transitions remain function-only.
grant insert on table
  public.actors,
  public.organizations,
  public.organization_memberships,
  public.organization_settings,
  public.kyb_cases,
  public.kyb_events,
  public.business_accounts,
  public.business_account_events,
  public.external_bank_accounts,
  public.external_bank_account_events,
  public.cards,
  public.card_events,
  public.beneficiaries,
  public.standing_orders,
  public.standing_order_events,
  public.statement_versions,
  public.reconciliation_runs,
  public.reconciliation_file_rows,
  public.reconciliation_results,
  public.reconciliation_break_events
to service_role;

grant update on table
  public.actors,
  public.organizations,
  public.organization_memberships,
  public.organization_settings,
  public.beneficiaries
to service_role;

grant select on table
  public.current_kyb_status,
  public.current_business_account_status,
  public.current_card_status,
  public.current_payment_status,
  public.current_provider_event_status,
  public.active_card_holds,
  public.active_payment_reservations,
  public.current_reconciliation_breaks,
  public.business_account_balances
to service_role;

revoke all on all functions in schema private from public, anon, authenticated, service_role;

do $$
declare
  function_signature text;
begin
  for function_signature in
    select format(
      '%I.%I(%s)',
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid)
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'account_balance_as_of', 'statement_lines',
        'ingest_provider_event', 'record_provider_event_attempt',
        'post_journal_entry', 'reverse_journal_entry', 'create_ledger_account',
        'record_card_settlement', 'match_parked_settlement',
        'record_authorization_event', 'reverse_card_settlement',
        'create_payment_request', 'decide_payment_request', 'record_payment_event',
        'create_standing_order_occurrence', 'record_standing_order_attempt'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', function_signature);
    execute format('grant execute on function %s to service_role', function_signature);
  end loop;
end;
$$;

-- Prevent future public functions/tables created by the dashboard owner from
-- accidentally inheriting permissive browser grants.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;

commit;

-- =============================================================================
-- READ-ONLY VERIFICATION QUERIES (run separately after the schema commits)
-- =============================================================================

-- 1. All V0 source tables have RLS enabled.
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relkind = 'r'
-- order by c.relname;

-- 2. Browser roles have no table privileges; service_role has SELECT.
-- select
--   table_name,
--   has_table_privilege('anon', format('public.%I', table_name), 'SELECT') as anon_select,
--   has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT') as authenticated_select,
--   has_table_privilege('service_role', format('public.%I', table_name), 'SELECT') as service_select
-- from information_schema.tables
-- where table_schema = 'public'
-- order by table_name;

-- 3. No committed journal is unbalanced or has fewer than two lines.
-- select
--   je.id,
--   je.posting_key,
--   count(jp.id) as line_count,
--   coalesce(sum(jp.amount_cents) filter (where jp.side = 'DEBIT'), 0) as debits,
--   coalesce(sum(jp.amount_cents) filter (where jp.side = 'CREDIT'), 0) as credits
-- from public.journal_entries je
-- left join public.journal_postings jp on jp.journal_entry_id = je.id
-- group by je.id, je.posting_key
-- having count(jp.id) < 2
--     or coalesce(sum(jp.amount_cents) filter (where jp.side = 'DEBIT'), 0)
--        <> coalesce(sum(jp.amount_cents) filter (where jp.side = 'CREDIT'), 0);

-- 4. No hold or reservation projection is negative.
-- select authorization_id, sum(delta_cents) as hold_cents
-- from public.card_hold_events
-- group by authorization_id
-- having sum(delta_cents) < 0;
--
-- select payment_request_id, sum(delta_cents) as reserved_cents
-- from public.payment_reservation_events
-- group by payment_request_id
-- having sum(delta_cents) < 0;

-- 5. Live-fire scenario checklist for a later deterministic seed/test script:
--    a. Provision CUSTOMER_DEPOSIT and provider/rail clearing ledger accounts.
--    b. Post settled funding, then record a 5000-cent authorization.
--    c. Confirm ledger is unchanged and available is lower by 5000 cents.
--    d. Record a final 7340-cent settlement; replay its provider and domain keys.
--    e. Confirm one journal, a zero hold, and no duplicate effect.
--    f. Reverse it with the original value_date and a later booked_at.
--    g. Compare statement_lines(..., Wednesday cutoff) with the corrected view.
--    h. Record settlement-before-auth and confirm UNMATCHED, then record auth and
--       confirm exactly one settlement journal and no double-released hold.
--    i. Attempt maker self-approval and agent approval; both must raise 42501.
--    j. Remove a scheme row from the input and confirm IN_LEDGER_NOT_FILE with age.
