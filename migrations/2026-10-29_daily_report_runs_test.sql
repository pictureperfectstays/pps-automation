-- Rolled-back test for 2026-10-29_daily_report_runs.sql.
-- Collects PASS/FAIL/INCONCLUSIVE lines and always ends by raising an
-- exception carrying them, so every change made here is rolled back.

do $$
declare
  client_id uuid;
  r text := '';
  n int;
  d date := (now() at time zone 'America/Phoenix')::date;
begin
  -- 1. Status outside the list is refused.
  begin
    insert into public.daily_report_runs (report_date, git_ref, status) values (d, 'refs/heads/main', 'done');
    r := r || E'\nFAIL 1: status ''done'' accepted';
  exception when check_violation then
    r := r || E'\nPASS 1: status ''done'' refused';
  end;

  -- 2. Missing git_ref is refused.
  begin
    insert into public.daily_report_runs (report_date) values (d);
    r := r || E'\nFAIL 2: row without git_ref accepted';
  exception when not_null_violation then
    r := r || E'\nPASS 2: row without git_ref refused';
  end;

  -- Sample rows: yesterday main left in 'running'; today a branch run sent.
  insert into public.daily_report_runs (report_date, git_ref, trigger_event, status)
  values (d - 1, 'refs/heads/main', 'workflow_dispatch', 'running'),
         (d,     'refs/heads/build-a/report-fixes', 'workflow_dispatch', 'sent');

  -- 3. "Already sent today" on main ignores the branch's sent row.
  select count(*) into n from public.daily_report_runs
   where git_ref = 'refs/heads/main' and report_date = d and status in ('sent', 'sent_with_failures');
  r := r || case when n = 0 then E'\nPASS 3: main not treated as sent by a branch run'
                 else E'\nFAIL 3: main sees ' || n || ' sent rows' end;

  -- 4. The same check on the branch finds its own sent row (branch skip test works).
  select count(*) into n from public.daily_report_runs
   where git_ref = 'refs/heads/build-a/report-fixes' and report_date = d and status in ('sent', 'sent_with_failures');
  r := r || case when n = 1 then E'\nPASS 4: branch sees its own sent row'
                 else E'\nFAIL 4: branch sees ' || n end;

  -- 5. "Yesterday didn't run": a main row still 'running' counts as not run.
  select count(*) into n from public.daily_report_runs
   where git_ref = 'refs/heads/main' and report_date = d - 1 and status in ('sent', 'sent_with_failures');
  r := r || case when n = 0 then E'\nPASS 5: yesterday''s running row counts as not run'
                 else E'\nFAIL 5: yesterday counted as sent' end;

  -- 6-7. A signed-in client can neither read nor insert.
  select po.owner_id into client_id
    from public.property_owners po join public.owners o on o.id = po.owner_id
   where po.property_id = 20 and not o.is_admin limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', client_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    select count(*) into n from public.daily_report_runs;
    r := r || case when n = 0 then E'\nPASS 6: client reads 0 of 2 rows'
                   else E'\nFAIL 6: client reads ' || n || ' rows' end;
  exception when insufficient_privilege then
    r := r || E'\nPASS 6: client read refused (' || sqlerrm || ')';
  end;

  begin
    insert into public.daily_report_runs (report_date, git_ref) values (d, 'refs/heads/main');
    r := r || E'\nFAIL 7: client insert accepted';
  exception when insufficient_privilege then
    r := r || E'\nPASS 7: client insert refused (' || sqlerrm || ')';
  end;

  reset role;
  raise exception '%', 'TEST RESULTS (rolled back):' || r;
end $$;
