-- Transactional database gauntlet. Run after supabase-domain-hardening-migration.sql.
-- It requires seeded simulator accounts, proves the hostile accounting cases, and
-- rolls every test row back at the end.

begin;

do $gauntlet$
declare
  v_prefix text := 'gauntlet_' || replace(gen_random_uuid()::text, '-', '');
  v_card public.cards%rowtype;
  v_business_account_id uuid;
  v_auth_id uuid;
  v_partial_auth_id uuid;
  v_out_of_order_auth_id uuid;
  v_recon_auth_id uuid;
  v_settlement_id uuid;
  v_out_of_order_settlement_id uuid;
  v_recon_settlement_id uuid;
  v_journal_id uuid;
  v_replayed_journal_id uuid;
  v_reversal_id uuid;
  v_ledger_before bigint;
  v_available_before bigint;
  v_ledger_after bigint;
  v_available_after bigint;
  v_hold bigint;
  v_before_statement bigint;
  v_after_statement bigint;
  v_cutoff timestamptz;
  v_value_date date := current_date - 2;
  v_recon_date date := current_date - 400;
  v_recon_reference text;
  v_run_id uuid;
begin
  select c.* into v_card
  from public.cards c
  where c.provider_code = 'simulator'
  order by c.created_at, c.id
  limit 1;
  if not found then
    raise exception 'Gauntlet requires a seeded simulator card. Run npm run seed first.';
  end if;
  v_business_account_id := v_card.business_account_id;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'business_accounts'
      and column_name in ('balance', 'balance_cents', 'available_balance', 'available_balance_cents')
  ) then
    raise exception 'Available balance is stored on business_accounts instead of derived';
  end if;

  select ledger_balance_cents, available_balance_cents
    into v_ledger_before, v_available_before
  from public.business_account_balances
  where business_account_id = v_business_account_id;

  -- $50 authorization: ledger stays still and available falls by the hold.
  select result.authorization_id into v_auth_id
  from public.record_authorization_event(
    p_provider_code => 'simulator',
    p_provider_authorization_id => v_prefix || '_overcapture_auth',
    p_card_id => v_card.id,
    p_event_type => 'AUTHORIZED',
    p_authorized_total_cents => 5000,
    p_occurred_at => clock_timestamp(),
    p_idempotency_key => v_prefix || ':overcapture:auth'
  ) result;

  select ledger_balance_cents, available_balance_cents
    into v_ledger_after, v_available_after
  from public.business_account_balances
  where business_account_id = v_business_account_id;
  if v_ledger_after <> v_ledger_before or v_available_after <> v_available_before - 5000 then
    raise exception 'Authorization changed ledger or failed to reserve exactly 5000 cents';
  end if;

  -- $73.40 final capture: post once, release the $50 hold once.
  select result.settlement_id, result.journal_entry_id
    into v_settlement_id, v_journal_id
  from public.record_card_settlement(
    p_provider_code => 'simulator',
    p_provider_settlement_id => v_prefix || '_overcapture_settlement',
    p_card_id => v_card.id,
    p_external_authorization_id => v_prefix || '_overcapture_auth',
    p_amount_cents => 7340,
    p_value_date => v_value_date,
    p_occurred_at => clock_timestamp(),
    p_explicit_force_post => false,
    p_is_final_capture => true,
    p_idempotency_key => v_prefix || ':overcapture:settlement'
  ) result;

  select coalesce(sum(delta_cents), 0) into v_hold
  from public.card_hold_events where authorization_id = v_auth_id;
  if v_hold <> 0 then
    raise exception 'Final over-capture left a stale hold of % cents', v_hold;
  end if;

  select ledger_balance_cents, available_balance_cents
    into v_ledger_after, v_available_after
  from public.business_account_balances
  where business_account_id = v_business_account_id;
  if v_ledger_after <> v_ledger_before - 7340 or v_available_after <> v_available_before - 7340 then
    raise exception 'Over-capture did not post 7340 cents exactly once';
  end if;

  select result.journal_entry_id into v_replayed_journal_id
  from public.record_card_settlement(
    p_provider_code => 'simulator',
    p_provider_settlement_id => v_prefix || '_overcapture_settlement',
    p_card_id => v_card.id,
    p_external_authorization_id => v_prefix || '_overcapture_auth',
    p_amount_cents => 7340,
    p_value_date => v_value_date,
    p_occurred_at => clock_timestamp(),
    p_explicit_force_post => false,
    p_is_final_capture => true,
    p_idempotency_key => v_prefix || ':overcapture:settlement'
  ) result;
  if v_replayed_journal_id is distinct from v_journal_id then
    raise exception 'Duplicate settlement did not return the original journal';
  end if;
  if (select count(*) from public.card_settlement_journal_links where settlement_id = v_settlement_id and link_type = 'POSTING') <> 1 then
    raise exception 'Duplicate settlement created more than one posting';
  end if;

  -- Bitemporal correction: reject a wrong value date, then reverse on the
  -- original financial day while preserving the earlier knowledge view.
  v_cutoff := clock_timestamp();
  perform pg_sleep(0.01);
  begin
    perform public.reverse_card_settlement(
      v_settlement_id, v_prefix || ':wrong-date', v_value_date + 1,
      'This incorrect date must be rejected'
    );
    raise exception 'Card reversal accepted a value date different from the original settlement';
  exception when check_violation then
    null;
  end;

  v_reversal_id := public.reverse_card_settlement(
    v_settlement_id, v_prefix || ':reversal', v_value_date,
    'Gauntlet merchant reversal'
  );
  if not exists (
    select 1 from public.journal_entries
    where id = v_reversal_id
      and reversal_of_entry_id = v_journal_id
      and value_date = v_value_date
      and booked_at > v_cutoff
  ) then
    raise exception 'Reversal did not preserve value date and later knowledge time';
  end if;

  select coalesce(sum(signed_amount_cents), 0) into v_before_statement
  from public.statement_lines(v_business_account_id, v_value_date, v_value_date, v_cutoff);
  select coalesce(sum(signed_amount_cents), 0) into v_after_statement
  from public.statement_lines(v_business_account_id, v_value_date, v_value_date, 'infinity');
  if v_after_statement - v_before_statement <> 7340 then
    raise exception 'Statement cutoff did not expose the 7340-cent later correction';
  end if;

  -- Increment to $75, then capture $30 + $20 + $25. Only the final capture
  -- terminates the remaining hold.
  select result.authorization_id into v_partial_auth_id
  from public.record_authorization_event(
    'simulator', v_prefix || '_partial_auth', v_card.id, 'AUTHORIZED', 5000,
    clock_timestamp(), v_prefix || ':partial:auth'
  ) result;
  perform public.record_authorization_event(
    'simulator', v_prefix || '_partial_auth', v_card.id, 'INCREMENTED', 7500,
    clock_timestamp(), v_prefix || ':partial:increment'
  );

  perform public.record_card_settlement(
    'simulator', v_prefix || '_capture_1', v_card.id, v_prefix || '_partial_auth',
    3000, current_date - 1, clock_timestamp(), false, false, v_prefix || ':capture:1'
  );
  select coalesce(sum(delta_cents), 0) into v_hold
  from public.card_hold_events where authorization_id = v_partial_auth_id;
  if v_hold <> 4500 then raise exception 'First partial capture expected 4500 hold, got %', v_hold; end if;

  perform public.record_card_settlement(
    'simulator', v_prefix || '_capture_2', v_card.id, v_prefix || '_partial_auth',
    2000, current_date, clock_timestamp(), false, false, v_prefix || ':capture:2'
  );
  select coalesce(sum(delta_cents), 0) into v_hold
  from public.card_hold_events where authorization_id = v_partial_auth_id;
  if v_hold <> 2500 then raise exception 'Second partial capture expected 2500 hold, got %', v_hold; end if;

  perform public.record_card_settlement(
    'simulator', v_prefix || '_capture_3', v_card.id, v_prefix || '_partial_auth',
    2500, current_date, clock_timestamp(), false, true, v_prefix || ':capture:3'
  );
  select coalesce(sum(delta_cents), 0) into v_hold
  from public.card_hold_events where authorization_id = v_partial_auth_id;
  if v_hold <> 0 then raise exception 'Final multiple capture left % cents held', v_hold; end if;

  -- Settlement-before-auth parks without posting, then matches automatically.
  select result.settlement_id into v_out_of_order_settlement_id
  from public.record_card_settlement(
    'simulator', v_prefix || '_out_of_order_settlement', v_card.id,
    v_prefix || '_late_auth', 3200, current_date, clock_timestamp(),
    false, true, v_prefix || ':out-of-order:settlement'
  ) result;
  if exists (select 1 from public.card_settlement_journal_links where settlement_id = v_out_of_order_settlement_id) then
    raise exception 'Settlement-before-auth posted instead of parking';
  end if;

  select result.authorization_id into v_out_of_order_auth_id
  from public.record_authorization_event(
    'simulator', v_prefix || '_late_auth', v_card.id, 'AUTHORIZED', 3200,
    clock_timestamp(), v_prefix || ':out-of-order:auth'
  ) result;
  if not exists (
    select 1 from public.card_settlement_journal_links
    where settlement_id = v_out_of_order_settlement_id and link_type = 'POSTING'
  ) then
    raise exception 'Late authorization did not post its parked settlement';
  end if;
  select coalesce(sum(delta_cents), 0) into v_hold
  from public.card_hold_events where authorization_id = v_out_of_order_auth_id;
  if v_hold <> 0 then raise exception 'Late authorization created a stale hold of % cents', v_hold; end if;

  -- Force post must post without inventing an authorization.
  select result.journal_entry_id into v_journal_id
  from public.record_card_settlement(
    'simulator', v_prefix || '_force_post', v_card.id, null,
    1899, current_date, clock_timestamp(), true, true, v_prefix || ':force-post'
  ) result;
  if v_journal_id is null then raise exception 'Force post did not create a journal'; end if;

  -- Reconciliation must classify a parked settlement as in-file-not-ledger.
  v_recon_reference := v_prefix || '_parked_recon';
  select result.settlement_id into v_recon_settlement_id
  from public.record_card_settlement(
    'simulator', v_recon_reference, v_card.id, v_prefix || '_recon_auth',
    4100, v_recon_date, clock_timestamp(), false, true, v_prefix || ':recon:parked'
  ) result;
  v_run_id := public.run_scheme_reconciliation(
    'simulator', v_recon_date, v_prefix || '_first.csv', v_prefix || '_hash_1',
    jsonb_build_array(jsonb_build_object(
      'processor_reference', v_recon_reference,
      'amount_cents', 4100,
      'value_date', v_recon_date
    ))
  );
  if not exists (
    select 1 from public.reconciliation_results
    where reconciliation_run_id = v_run_id
      and settlement_id = v_recon_settlement_id
      and break_type = 'IN_FILE_NOT_LEDGER'
      and journal_entry_id is null
  ) then
    raise exception 'Parked settlement was incorrectly treated as ledger truth';
  end if;

  select result.authorization_id into v_recon_auth_id
  from public.record_authorization_event(
    'simulator', v_prefix || '_recon_auth', v_card.id, 'AUTHORIZED', 4100,
    clock_timestamp(), v_prefix || ':recon:auth'
  ) result;
  v_run_id := public.run_scheme_reconciliation(
    'simulator', v_recon_date, v_prefix || '_clean.csv', v_prefix || '_hash_2',
    jsonb_build_array(jsonb_build_object(
      'processor_reference', v_recon_reference,
      'amount_cents', 4100,
      'value_date', v_recon_date
    ))
  );
  if exists (
    select 1 from public.latest_reconciliation_breaks
    where processor_reference = v_recon_reference
  ) then
    raise exception 'A clean rerun left the old reconciliation break open';
  end if;

  -- The journal command and append-only trigger remain hard boundaries.
  if exists (
    select je.id
    from public.journal_entries je
    join public.journal_postings jp on jp.journal_entry_id = je.id
    group by je.id
    having count(*) < 2
       or coalesce(sum(jp.amount_cents) filter (where jp.side = 'DEBIT'), 0)
          <> coalesce(sum(jp.amount_cents) filter (where jp.side = 'CREDIT'), 0)
  ) then
    raise exception 'An unbalanced or one-sided journal exists';
  end if;

  begin
    update public.journal_entries set description = description where id = v_journal_id;
    raise exception 'Append-only journal accepted an update';
  exception when sqlstate '55000' then
    null;
  end;

  raise notice 'DOMAIN GAUNTLET PASSED: derived balance, hostile holds, idempotency, bitemporality, force post, out-of-order matching, and reconciliation';
end;
$gauntlet$;

rollback;
