-- Additive helpers for the Corgi UI. Apply after supabase-schema.sql.
-- Financial rows remain append-only and are still written through the original RPCs.

begin;

-- Existing projects need the new card processor before Lithic-backed rows can be inserted.
insert into public.providers (code, display_name)
values ('lithic', 'Lithic')
on conflict (code) do update set display_name = excluded.display_name;

create table if not exists private.provider_connection_secrets (
  provider_code text not null references public.providers(code) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  external_connection_id text not null,
  access_token text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (provider_code, organization_id, external_connection_id)
);

revoke all on private.provider_connection_secrets from public, anon, authenticated;

create or replace function public.save_provider_connection_secret(
  p_provider_code text,
  p_organization_id uuid,
  p_external_connection_id text,
  p_access_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.provider_connection_secrets (
    provider_code, organization_id, external_connection_id, access_token
  ) values (
    p_provider_code, p_organization_id, p_external_connection_id, p_access_token
  )
  on conflict (provider_code, organization_id, external_connection_id)
  do update set access_token = excluded.access_token;
end;
$$;

create or replace function public.get_provider_connection_secret(
  p_provider_code text,
  p_organization_id uuid,
  p_external_connection_id text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select access_token
  from private.provider_connection_secrets
  where provider_code = p_provider_code
    and organization_id = p_organization_id
    and external_connection_id = p_external_connection_id
$$;

create or replace view public.payment_request_status
with (security_invoker = true)
as
select
  pr.*,
  case
    when pae.decision = 'REJECTED' then 'REJECTED'
    when cps.status is not null then cps.status
    when pae.decision = 'APPROVED' then 'APPROVED'
    when pr.requires_approval then 'PENDING_APPROVAL'
    else 'READY_TO_SUBMIT'
  end as status,
  pae.approver_actor_id,
  pae.reason as decision_reason,
  p.id as payment_id
from public.payment_requests pr
left join public.payment_approval_events pae on pae.payment_request_id = pr.id
left join public.payments p on p.payment_request_id = pr.id
left join public.current_payment_status cps on cps.payment_id = p.id;

create or replace view public.current_standing_orders
with (security_invoker = true)
as
select distinct on (so.id)
  so.*,
  soe.event_type as status,
  soe.occurred_at as status_changed_at,
  soe.details as status_details
from public.standing_orders so
join public.standing_order_events soe on soe.standing_order_id = so.id
order by so.id, soe.recorded_at desc, soe.id desc;

create or replace view public.business_account_activity
with (security_invoker = true)
as
select
  la.business_account_id,
  je.id as journal_entry_id,
  je.value_date,
  je.booked_at,
  je.description,
  je.entry_kind,
  je.external_reference,
  je.reversal_of_entry_id,
  case when jp.side = 'CREDIT' then jp.amount_cents else -jp.amount_cents end as signed_amount_cents
from public.ledger_accounts la
join public.journal_postings jp on jp.ledger_account_id = la.id
join public.journal_entries je on je.id = jp.journal_entry_id
where la.business_account_id is not null
  and la.purpose = 'CUSTOMER_DEPOSIT'
  and la.is_primary;

create or replace view public.latest_reconciliation_breaks
with (security_invoker = true)
as
with latest_run as (
  select distinct on (provider_code, settlement_date)
    id, provider_code, settlement_date
  from public.reconciliation_runs
  order by provider_code, settlement_date, started_at desc, id desc
), latest_results as (
  select rr.*
  from public.reconciliation_results rr
  join latest_run lr on lr.id = rr.reconciliation_run_id
), first_seen as (
  select break_fingerprint, min(detected_at) as first_detected_at
  from public.reconciliation_results
  group by break_fingerprint
), latest_event as (
  select distinct on (reconciliation_result_id) *
  from public.reconciliation_break_events
  order by reconciliation_result_id, recorded_at desc, id desc
)
select
  lr.*,
  fs.first_detected_at,
  current_date - fs.first_detected_at::date as age_days,
  coalesce(le.event_type, 'OPENED') as status,
  le.note
from latest_results lr
join first_seen fs using (break_fingerprint)
left join latest_event le on le.reconciliation_result_id = lr.id;

create or replace function public.run_scheme_reconciliation(
  p_provider_code text,
  p_settlement_date date,
  p_file_reference text,
  p_file_hash text,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'reconciliation rows must be a JSON array' using errcode = '22023';
  end if;

  select id into v_run_id
  from public.reconciliation_runs
  where provider_code = p_provider_code and file_hash = p_file_hash;
  if v_run_id is not null then return v_run_id; end if;

  insert into public.reconciliation_runs (
    provider_code, settlement_date, file_reference, file_hash, completed_at
  ) values (
    p_provider_code, p_settlement_date, p_file_reference, p_file_hash, clock_timestamp()
  ) returning id into v_run_id;

  insert into public.reconciliation_file_rows (
    reconciliation_run_id, row_number, processor_reference,
    amount_cents, value_date, raw_row
  )
  select
    v_run_id,
    ordinality::integer,
    row ->> 'processor_reference',
    (row ->> 'amount_cents')::bigint,
    (row ->> 'value_date')::date,
    row
  from jsonb_array_elements(p_rows) with ordinality as input(row, ordinality);

  if exists (
    select 1
    from public.reconciliation_file_rows rfr
    where rfr.reconciliation_run_id = v_run_id
      and rfr.value_date <> p_settlement_date
  ) then
    raise exception 'every file row value_date must match the reconciliation settlement date'
      using errcode = '23514';
  end if;

  insert into public.reconciliation_results (
    reconciliation_run_id, break_fingerprint, break_type, file_row_id,
    settlement_id, journal_entry_id, processor_reference,
    file_amount_cents, ledger_amount_cents
  )
  select
    v_run_id,
    md5(p_provider_code || '|' || p_settlement_date::text || '|FILE|' || rfr.processor_reference),
    case when csjl.journal_entry_id is null then 'IN_FILE_NOT_LEDGER'::public.reconciliation_break_type
         else 'AMOUNT_MISMATCH'::public.reconciliation_break_type end,
    rfr.id,
    cs.id,
    csjl.journal_entry_id,
    rfr.processor_reference,
    rfr.amount_cents,
    cs.amount_cents
  from public.reconciliation_file_rows rfr
  left join public.card_settlements cs
    on cs.provider_code = p_provider_code
   and cs.provider_settlement_id = rfr.processor_reference
   and cs.value_date = p_settlement_date
  left join public.card_settlement_journal_links csjl
    on csjl.settlement_id = cs.id and csjl.link_type = 'POSTING'
  where rfr.reconciliation_run_id = v_run_id
    and (csjl.journal_entry_id is null or cs.amount_cents <> rfr.amount_cents);

  insert into public.reconciliation_results (
    reconciliation_run_id, break_fingerprint, break_type, settlement_id,
    journal_entry_id, processor_reference, ledger_amount_cents
  )
  select
    v_run_id,
    md5(p_provider_code || '|' || p_settlement_date::text || '|LEDGER|' || cs.provider_settlement_id),
    'IN_LEDGER_NOT_FILE',
    cs.id,
    csjl.journal_entry_id,
    cs.provider_settlement_id,
    cs.amount_cents
  from public.card_settlements cs
  join public.card_settlement_journal_links csjl
    on csjl.settlement_id = cs.id and csjl.link_type = 'POSTING'
  where cs.provider_code = p_provider_code
    and cs.value_date = p_settlement_date
    and not exists (
      select 1 from public.reconciliation_file_rows rfr
      where rfr.reconciliation_run_id = v_run_id
        and rfr.processor_reference = cs.provider_settlement_id
    );

  return v_run_id;
end;
$$;

create or replace function public.pause_standing_order(
  p_standing_order_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  insert into public.standing_order_events (
    standing_order_id, actor_id, idempotency_key, event_type, occurred_at, details
  ) values (
    p_standing_order_id, p_actor_id, p_idempotency_key, 'PAUSED',
    clock_timestamp(), jsonb_build_object('reason', p_reason)
  ) on conflict (idempotency_key) do nothing returning id into v_id;

  if v_id is null then
    select id into v_id from public.standing_order_events
    where idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

grant select on public.payment_request_status, public.current_standing_orders,
  public.business_account_activity,
  public.latest_reconciliation_breaks to service_role;
revoke all on function public.save_provider_connection_secret(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_provider_connection_secret(text, uuid, text) from public, anon, authenticated;
revoke all on function public.run_scheme_reconciliation(text, date, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.pause_standing_order(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.save_provider_connection_secret(text, uuid, text, text) to service_role;
grant execute on function public.get_provider_connection_secret(text, uuid, text) to service_role;
grant execute on function public.run_scheme_reconciliation(text, date, text, text, jsonb) to service_role;
grant execute on function public.pause_standing_order(uuid, uuid, text, text) to service_role;

commit;
