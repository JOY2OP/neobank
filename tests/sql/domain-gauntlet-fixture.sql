insert into public.actors (id, kind, display_name)
values ('20000000-0000-4000-8000-000000000001', 'SYSTEM', 'Gauntlet System');

insert into public.organizations (id, legal_name)
values ('20000000-0000-4000-8000-000000000002', 'Gauntlet Inc.');

insert into public.business_accounts (id, organization_id, account_name)
values (
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002',
  'Gauntlet operating account'
);

insert into public.kyb_cases (id, organization_id, provider_code, external_case_id)
values (
  '20000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000002',
  'simulator',
  'gauntlet_kyb'
);

insert into public.kyb_events (
  kyb_case_id, idempotency_key, event_type, provider_status, occurred_at
)
values (
  '20000000-0000-4000-8000-000000000005',
  'gauntlet:kyb-approved', 'APPROVED', 'approved', clock_timestamp()
);

insert into public.business_account_events (
  business_account_id, actor_id, idempotency_key, event_type, occurred_at
)
values (
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000001',
  'gauntlet:account-opened', 'OPENED', clock_timestamp()
);

insert into public.cards (
  id, business_account_id, cardholder_actor_id,
  provider_code, provider_card_id, last4
)
values (
  '20000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000001',
  'simulator', 'gauntlet_card', '4242'
);

select public.create_ledger_account(
  p_external_key => 'GAUNTLET:CUSTOMER_DEPOSIT',
  p_account_class => 'LIABILITY',
  p_purpose => 'CUSTOMER_DEPOSIT',
  p_name => 'Gauntlet customer deposits',
  p_organization_id => '20000000-0000-4000-8000-000000000002',
  p_business_account_id => '20000000-0000-4000-8000-000000000003',
  p_is_primary => true
);

select public.create_ledger_account(
  p_external_key => 'GAUNTLET:CARD_PAYABLE',
  p_account_class => 'LIABILITY',
  p_purpose => 'CARD_NETWORK_PAYABLE',
  p_name => 'Gauntlet card payable',
  p_provider_code => 'simulator'
);

select public.create_ledger_account(
  p_external_key => 'GAUNTLET:ACH_CLEARING',
  p_account_class => 'ASSET',
  p_purpose => 'RAIL_CLEARING',
  p_name => 'Gauntlet ACH clearing',
  p_rail_code => 'ACH'
);

select public.post_journal_entry(
  p_posting_key => 'gauntlet:opening-funding',
  p_entry_kind => 'ACH_SETTLEMENT',
  p_value_date => current_date - 10,
  p_description => 'Gauntlet opening funding',
  p_postings => jsonb_build_array(
    jsonb_build_object(
      'ledger_account_id', (select id from public.ledger_accounts where external_key = 'GAUNTLET:ACH_CLEARING'),
      'side', 'DEBIT',
      'amount_cents', 10000000
    ),
    jsonb_build_object(
      'ledger_account_id', (select id from public.ledger_accounts where external_key = 'GAUNTLET:CUSTOMER_DEPOSIT'),
      'side', 'CREDIT',
      'amount_cents', 10000000
    )
  )
);
