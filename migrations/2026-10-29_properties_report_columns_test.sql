-- Rolled-back test for 2026-10-29_properties_report_columns.sql.
-- Collects PASS/FAIL/INCONCLUSIVE lines and always ends by raising an
-- exception carrying them, so every change made here is rolled back.

do $$
declare
  client_id uuid;
  r text := '';
  backfill text;
begin
  -- 1. Target outside 25/50/75/90 is refused.
  begin
    update public.properties set price_target_low_pct = 80 where id = 6;
    r := r || E'\nFAIL 1: target 80 was accepted';
  exception when check_violation then
    r := r || E'\nPASS 1: target 80 refused';
  end;

  -- 2. Low >= high is refused.
  begin
    update public.properties set price_target_low_pct = 75, price_target_high_pct = 50 where id = 6;
    r := r || E'\nFAIL 2: low >= high was accepted';
  exception when check_violation then
    r := r || E'\nPASS 2: low >= high refused';
  end;

  -- 3. Allowed values are accepted.
  begin
    update public.properties set price_target_low_pct = 25, price_target_high_pct = 90 where id = 6;
    r := r || E'\nPASS 3: 25/90 accepted (rows=' || (case when found then 1 else 0 end) || ')';
  exception when others then
    r := r || E'\nFAIL 3: 25/90 refused (' || sqlerrm || ')';
  end;

  -- Backfill as it stands (before switching role).
  select string_agg(format('%s=%s %s/%s', id, coalesce(report_short_name, '(none)'),
                           price_target_low_pct, price_target_high_pct), '; ' order by id)
    into backfill from public.properties where is_active;

  -- 4-6. A client (non-admin owner of the 412A draft).
  select po.owner_id into client_id
    from public.property_owners po join public.owners o on o.id = po.owner_id
   where po.property_id = 20 and not o.is_admin limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', client_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    update public.properties set report_short_name = 'x' where id = 20;
    r := r || case when found then E'\nFAIL 4: client changed report_short_name'
                   else E'\nINCONCLUSIVE 4: client update matched no row (RLS), trigger not reached' end;
  exception when insufficient_privilege then
    r := r || E'\nPASS 4: client refused (' || sqlerrm || ')';
  end;

  begin
    update public.properties set price_target_low_pct = 25 where id = 20;
    r := r || case when found then E'\nFAIL 5: client changed price_target_low_pct'
                   else E'\nINCONCLUSIVE 5: client update matched no row (RLS), trigger not reached' end;
  exception when insufficient_privilege then
    r := r || E'\nPASS 5: client refused (' || sqlerrm || ')';
  end;

  begin
    update public.properties set parking = parking where id = 20;
    r := r || case when found then E'\nPASS 6: client allowlisted update ran (1 row)'
                   else E'\nINCONCLUSIVE 6: client update matched no row (RLS)' end;
  exception when others then
    r := r || E'\nFAIL 6: client allowlisted update refused (' || sqlerrm || ')';
  end;

  reset role;
  raise exception '%', 'TEST RESULTS (rolled back):' || r || E'\nBACKFILL: ' || backfill;
end $$;
