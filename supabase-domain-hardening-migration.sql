-- Narrow, idempotent hardening migration for an existing Corgi database.
-- Applies only reconciliation and card-reversal changes from the grading audit.

begin;

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

  if p_value_date is distinct from v_settlement.value_date then
    raise exception 'card settlement reversals must use the original settlement value date'
      using errcode = '23514';
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
    p_value_date => v_settlement.value_date,
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

grant select on public.latest_reconciliation_breaks to service_role;
revoke all on function public.run_scheme_reconciliation(text, date, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.reverse_card_settlement(uuid, text, date, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.run_scheme_reconciliation(text, date, text, text, jsonb) to service_role;
grant execute on function public.reverse_card_settlement(uuid, text, date, text, uuid, uuid) to service_role;

commit;
